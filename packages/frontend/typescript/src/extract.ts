import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import ts from "typescript";
import type { IREdge, IRFinding, IRNode, IRRecord, NodeId, Provenance, Span, UnresolvedRef } from "@insight/ir";
import type { IRBatch } from "@insight/sdk";
import { importBindings, matchCall, matchEnvRead, matchExportRoute, matchFetch, matchSchedule, matchServe, matchWorker, nodeScriptArgument, scriptPath, urlText, type ImportBinding, type ScriptPath, type UrlText, type WorkerEnv } from "./effects.js";
import { scriptKind } from "./digest.js";
import { dispatchFor, MAX_DISPATCH_TARGETS, propName } from "./dispatch.js";

export const FRONTEND_ID = "frontend-typescript";
export const SOURCE_RE = /\.(?:[mc]?[jt]sx?)$/;
const PROV: Provenance = { frontend: FRONTEND_ID, confidence: "exact" };
type Confidence = Provenance["confidence"];

/** The name of a file's module entry: the function its top-level executable code belongs to. */
const MODULE_NAME = "(module)";

type Entity =
  | { type: "type"; name: string; typeKind: "class" | "interface" | "enum" | "alias" }
  | {
      type: "function";
      name: string;
      async: boolean;
      generator: boolean;
      exported: boolean;
      anonymous: boolean;
      /** Set for a file's module entry: its top-level code runs when the module loads. */
      module?: true;
      /** Set for a module that an index.html loads with a script tag. */
      htmlEntry?: true;
      /** Set for a module that is a Node script: under scripts/ or bin/ with a shebang or process.argv, or named by package.json. */
      nodeEntry?: true;
    };

export interface Decl {
  id: NodeId;
  rel: string;
  qname: string;
  entity: Entity;
  node: ts.Node;
}

/** A parsed set of project files, with a checker and every declaration that can be a call target. */
export interface Project {
  root: string;
  rels: Set<string>;
  program: ts.Program;
  checker: ts.TypeChecker;
  options: ts.CompilerOptions;
  host: ts.CompilerHost;
  decls: Map<ts.Node, Decl>;
  /** The module entry of a file, `<rel>#(module)`, when its top-level code is executable. Undefined otherwise. */
  moduleOf(rel: string): NodeId | undefined;
  sourceFor(rel: string): ts.SourceFile | undefined;
  /** Maps a path under the compiler's output directory to the same path under its source directory. Undefined for other paths. */
  mapOutput(rel: string): string | undefined;
  /**
   * The declaration in an indexed source file that a node of a built `.d.ts` declares: `dist/a.d.ts`'s `f` is `src/a.ts`'s `f`.
   * Undefined for any other node, and when no indexed source file defines it.
   */
  sourceOf(node: ts.Node): Decl | undefined;
}

const isFnInit = (n: ts.Expression): boolean => ts.isArrowFunction(n) || ts.isFunctionExpression(n);
const hasModifier = (node: ts.Node, kind: ts.SyntaxKind): boolean =>
  ts.canHaveModifiers(node) && (ts.getModifiers(node)?.some((m) => m.kind === kind) ?? false);

/**
 * The qualified name that the function properties of a bound object literal take, by literal: `<binding>` for a literal
 * a variable, class property or `export default` holds, `<binding>.<prop>` for one a property of a bound literal holds.
 * A literal in no such place is not here, so its function properties stay lambdas.
 */
type LiteralNames = Map<ts.ObjectLiteralExpression, { qname: string }>;

/** The object literal an expression is, looking through parentheses and type assertions. */
function literalOf(e: ts.Expression): ts.ObjectLiteralExpression | undefined {
  let inner = e;
  while (
    ts.isParenthesizedExpression(inner) ||
    ts.isAsExpression(inner) ||
    ts.isSatisfiesExpression(inner) ||
    ts.isNonNullExpression(inner) ||
    ts.isTypeAssertionExpression(inner)
  ) {
    inner = inner.expression;
  }
  return ts.isObjectLiteralExpression(inner) ? inner : undefined;
}

/**
 * Records the object literal that `node` binds to a name, so that its properties are named by it. A variable with an
 * identifier name, a class property and `export default` bind their initializer; a property binds the literal it holds
 * when its own literal is bound. The literal's names follow its container, as the class members of a container do.
 */
function bindLiteral(node: ts.Node, container: { qname: string } | undefined, literals: LiteralNames): void {
  let value: ts.Expression | undefined;
  let name: string | undefined;
  let scope = container;
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
    value = node.initializer;
    name = node.name.text;
  } else if (ts.isPropertyDeclaration(node)) {
    value = node.initializer;
    name = propName(node.name);
  } else if (ts.isExportAssignment(node) && !node.isExportEquals) {
    value = node.expression;
    name = "default";
  } else if (ts.isPropertyAssignment(node) && ts.isObjectLiteralExpression(node.parent)) {
    const outer = literals.get(node.parent);
    if (outer === undefined) return;
    value = node.initializer;
    name = propName(node.name);
    scope = outer;
  }
  const literal = value && literalOf(value);
  if (literal && name !== undefined) literals.set(literal, { qname: scope ? `${scope.qname}.${name}` : name });
}

/** A function expression that its parent declaration names: the variable, class property or bound literal property it initializes. */
function namedByParent(node: ts.ArrowFunction | ts.FunctionExpression, literals: LiteralNames): boolean {
  const parent = node.parent;
  if (ts.isVariableDeclaration(parent)) return parent.initializer === node && ts.isIdentifier(parent.name);
  if (ts.isPropertyDeclaration(parent)) return parent.initializer === node;
  if (ts.isPropertyAssignment(parent)) return parent.initializer === node && literals.has(parent.parent);
  return false;
}

/** Decides whether a node becomes a structure node. Shared by the declaration pass and the emit pass. */
function classify(node: ts.Node, sf: ts.SourceFile, literals: LiteralNames): Entity | undefined {
  // fnNode carries the async modifier; owner carries the export modifier (for a variable, its statement).
  const fn = (name: string, owner: ts.Node, fnNode: ts.Node, anonymous = false): Entity => ({
    type: "function",
    name,
    async: hasModifier(fnNode, ts.SyntaxKind.AsyncKeyword),
    generator: (fnNode as ts.FunctionLikeDeclaration).asteriskToken !== undefined,
    exported: (ts.getCombinedModifierFlags(owner as ts.Declaration) & ts.ModifierFlags.Export) !== 0,
    anonymous,
  });
  if (ts.isClassDeclaration(node)) return { type: "type", name: node.name?.text ?? "default", typeKind: "class" };
  if (ts.isInterfaceDeclaration(node)) return { type: "type", name: node.name.text, typeKind: "interface" };
  if (ts.isEnumDeclaration(node)) return { type: "type", name: node.name.text, typeKind: "enum" };
  if (ts.isTypeAliasDeclaration(node)) return { type: "type", name: node.name.text, typeKind: "alias" };
  if (ts.isFunctionDeclaration(node) && node.body) return fn(node.name?.text ?? "default", node, node);
  if ((ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) && node.body) {
    return fn(propName(node.name), node, node);
  }
  if (ts.isConstructorDeclaration(node) && node.body) return fn("constructor", node, node);
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && isFnInit(node.initializer)) {
    return fn(node.name.text, node, node.initializer);
  }
  if (ts.isPropertyDeclaration(node) && node.initializer && isFnInit(node.initializer)) {
    return fn(propName(node.name), node, node.initializer);
  }
  // A function-valued property of a bound object literal is named by the property. Other literals' properties are lambdas.
  if (ts.isPropertyAssignment(node) && isFnInit(node.initializer) && literals.has(node.parent)) {
    return fn(propName(node.name), node, node.initializer);
  }
  // A function expression that no declaration names is a lambda. It is named by where it starts, 1-based like an editor.
  if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && !namedByParent(node, literals)) {
    const at = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    return fn(`λ${at.line + 1}:${at.character + 1}`, node, node, true);
  }
  return undefined;
}

const isAssignOp = (k: ts.SyntaxKind): boolean => k >= ts.SyntaxKind.FirstAssignment && k <= ts.SyntaxKind.LastAssignment;

/**
 * True when a file's top level runs code when the module loads: a call, `new`, `await`, an assignment or JSX outside any
 * function. Functions, arrows and methods are skipped, since they run later. A file of declarations and imports has none.
 */
function runsAtLoad(sf: ts.SourceFile): boolean {
  const walk = (n: ts.Node): boolean => {
    if (ts.isFunctionLike(n)) return false;
    if (
      ts.isCallExpression(n) ||
      ts.isNewExpression(n) ||
      ts.isAwaitExpression(n) ||
      ts.isJsxOpeningElement(n) ||
      ts.isJsxSelfClosingElement(n) ||
      (ts.isBinaryExpression(n) && isAssignOp(n.operatorToken.kind))
    ) {
      return true;
    }
    return ts.forEachChild(n, walk) === true;
  };
  return ts.forEachChild(sf, walk) === true;
}

/** The span of a module entry: from its first top-level statement to its last. */
function moduleSpan(rel: string, sf: ts.SourceFile): Span {
  const first = sf.statements[0];
  const last = sf.statements[sf.statements.length - 1];
  return first && last ? { file: rel, start: pos(sf, first.getStart(sf)), end: pos(sf, last.getEnd()) } : { file: rel, start: [0, 0], end: [0, 0] };
}

/** Assigns IDs to every declaration in a file: <file>#<qualified name>, with ~N for repeats. */
function assignDecls(rel: string, sf: ts.SourceFile, out: Map<ts.Node, Decl>, htmlEntry: boolean, nodeEntry: boolean): void {
  // The module entry is keyed by the source file itself. Its name is not a container, so declarations keep their ids.
  if (runsAtLoad(sf)) {
    const entity: Entity = {
      type: "function",
      name: MODULE_NAME,
      async: false,
      generator: false,
      exported: false,
      anonymous: false,
      module: true,
      ...(htmlEntry ? { htmlEntry: true as const } : {}),
      ...(nodeEntry ? { nodeEntry: true as const } : {}),
    };
    out.set(sf, { id: `${rel}#${MODULE_NAME}`, rel, qname: MODULE_NAME, entity, node: sf });
  }
  const counts = new Map<string, number>();
  const literals: LiteralNames = new Map();
  const visit = (node: ts.Node, container: { qname: string } | undefined): void => {
    let next = container;
    // A binding is registered before its children, so a literal's properties see it when they are classified.
    bindLiteral(node, container, literals);
    const entity = classify(node, sf, literals);
    if (entity) {
      // A property of a bound literal is named under that literal; anything else under its container.
      const owner = node.parent !== undefined && ts.isObjectLiteralExpression(node.parent) ? literals.get(node.parent) : undefined;
      const scope = owner ?? container;
      const qname = scope ? `${scope.qname}.${entity.name}` : entity.name;
      const n = (counts.get(qname) ?? 0) + 1;
      counts.set(qname, n);
      const id = n === 1 ? `${rel}#${qname}` : `${rel}#${qname}~${n}`;
      out.set(node, { id, rel, qname, entity, node });
      next = { qname };
    }
    ts.forEachChild(node, (child) => {
      visit(child, next);
    });
  };
  visit(sf, undefined);
}

function createSource(abs: string, rel: string, text: string): ts.SourceFile {
  return ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, true, scriptKind(rel));
}

function compilerOptions(root: string): ts.CompilerOptions {
  const base: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    esModuleInterop: true,
    resolveJsonModule: true,
    jsx: ts.JsxEmit.Preserve,
  };
  const config = join(root, "tsconfig.json");
  if (existsSync(config)) {
    const read = ts.readConfigFile(config, ts.sys.readFile);
    if (!read.error) {
      const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, root);
      Object.assign(base, parsed.options);
    }
  }
  return { ...base, allowJs: true, checkJs: false, noEmit: true, skipLibCheck: true };
}

/** A test, spec or fixture file: never a program's entry. */
const TEST_PATH = /(^|\/)(__tests__|tests?)\/|\.(test|spec)\.[^/]*$/;
/** A path-like token in a package.json script or bin command, such as `tsx scripts/gen.ts`. */
const SCRIPT_TOKEN = /(?:\.{0,2}\/)?[\w@.-]+(?:\/[\w@.-]+)*\.[cm]?[jt]sx?\b/g;

/** The script files a package.json names in its "bin" and "scripts" entries, relative to the project root. */
function manifestScripts(text: string): Set<string> {
  const out = new Set<string>();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return out;
  }
  if (typeof json !== "object" || json === null) return out;
  const pkg = json as { bin?: unknown; scripts?: unknown };
  const commands: string[] = [];
  if (typeof pkg.bin === "string") commands.push(pkg.bin);
  else if (typeof pkg.bin === "object" && pkg.bin !== null) commands.push(...Object.values(pkg.bin).filter((v): v is string => typeof v === "string"));
  if (typeof pkg.scripts === "object" && pkg.scripts !== null) commands.push(...Object.values(pkg.scripts).filter((v): v is string => typeof v === "string"));
  for (const c of commands) {
    for (const m of c.matchAll(SCRIPT_TOKEN)) out.add(m[0].replace(/^\.\//, ""));
  }
  return out;
}

/**
 * The Node script entries: a module file, not a test, that is under scripts/ or bin/ with a shebang or a read of
 * process.argv, or that a package.json "bin" or "scripts" entry names. `texts` is keyed by absolute path.
 */
function nodeEntryFiles(root: string, rels: string[], texts: Map<string, string>, manifests: Map<string, string>): Set<string> {
  const named = new Set<string>();
  for (const text of manifests.values()) for (const f of manifestScripts(text)) named.add(f);
  const out = new Set<string>();
  for (const rel of rels) {
    if (TEST_PATH.test(rel) || rel.endsWith(".d.ts")) continue;
    if (named.has(rel)) {
      out.add(rel);
      continue;
    }
    const first = rel.split("/")[0] ?? "";
    if (rel.includes("/") && (first === "scripts" || first === "bin")) {
      const text = texts.get(join(root, rel)) ?? "";
      if (text.startsWith("#!") || /\bprocess\.argv\b/.test(text)) out.add(rel);
    }
  }
  return out;
}

const SCRIPT_SRC = /<script\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi;

/**
 * The project source files an HTML page loads with a script tag. A leading slash is the project root, as in Vite; any
 * other path is relative to the page. `html` maps the page's project path to its text.
 */
function htmlScriptEntries(html: Map<string, string>, rels: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const [page, text] of html) {
    for (const m of text.matchAll(SCRIPT_SRC)) {
      const src = (m[1] ?? "").split(/[?#]/)[0] ?? "";
      if (src === "" || src.startsWith("//") || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(src)) continue;
      const at = src.startsWith("/") ? joinRel("", src.slice(1)) : joinRel(dirOf(page), src);
      const hit = at === undefined ? undefined : candidatesAt(at).find((c) => rels.has(c));
      if (hit !== undefined) out.add(hit);
    }
  }
  return out;
}

/**
 * A check that a path, once symlinks are followed, sits inside one of the folders. A path that does not exist is outside.
 * Results are cached, since the compiler asks about the same paths many times.
 */
function confinedTo(...dirs: string[]): (file: string) => boolean {
  const roots = dirs.map((d) => {
    try {
      return realpathSync(d);
    } catch {
      return d;
    }
  });
  const memo = new Map<string, boolean>();
  return (file) => {
    const hit = memo.get(file);
    if (hit !== undefined) return hit;
    let inside = false;
    try {
      const real = realpathSync(file);
      inside = roots.some((r) => real === r || real.startsWith(r + sep));
    } catch {
      inside = false;
    }
    memo.set(file, inside);
    return inside;
  };
}

/**
 * Parses every project source file into one program, so calls and imports resolve across files.
 * `texts` maps absolute paths to contents. Files are read once per extraction run.
 */
export function buildProject(
  root: string,
  rels: string[],
  texts: Map<string, string>,
  html: Map<string, string> = new Map(),
  manifests: Map<string, string> = new Map(),
): Project {
  const options = compilerOptions(root);
  const abs = (rel: string) => join(root, rel);
  const relOf = (file: string) => relative(root, file).split(sep).join("/");
  const cache = new Map<string, ts.SourceFile>();
  const orig = ts.createCompilerHost(options, true);
  // The compiler falls back to disk for files it was not given. It may read only the project and the bundled lib files.
  const readable = confinedTo(root, dirname(ts.getDefaultLibFilePath(options)));
  const host: ts.CompilerHost = {
    ...orig,
    getSourceFile(name, language, onError, shouldCreate) {
      const text = texts.get(name);
      if (text === undefined) return readable(name) ? orig.getSourceFile(name, language, onError, shouldCreate) : undefined;
      let sf = cache.get(name);
      if (!sf) {
        sf = createSource(name, relOf(name), text);
        cache.set(name, sf);
      }
      return sf;
    },
    fileExists: (f) => texts.has(f) || (readable(f) && orig.fileExists(f)),
    readFile: (f) => texts.get(f) ?? (readable(f) ? orig.readFile(f) : undefined),
  };
  const roots = rels.map(abs);
  const program = ts.createProgram({ rootNames: roots, options, host });
  const checker = program.getTypeChecker();
  const decls = new Map<ts.Node, Decl>();
  const relSet = new Set(rels);
  const htmlEntries = htmlScriptEntries(html, relSet);
  const nodeEntries = nodeEntryFiles(root, rels, texts, manifests);
  for (const rel of rels) {
    const sf = program.getSourceFile(abs(rel));
    if (sf) assignDecls(rel, sf, decls, htmlEntries.has(rel), nodeEntries.has(rel));
  }
  const moduleIds = new Map<string, NodeId>();
  for (const d of decls.values()) {
    if (d.entity.type === "function" && d.entity.module === true) moduleIds.set(d.rel, d.id);
  }
  return {
    root,
    rels: relSet,
    program,
    checker,
    options,
    host,
    decls,
    moduleOf: (rel) => moduleIds.get(rel),
    sourceFor: (rel) => program.getSourceFile(abs(rel)),
    mapOutput: outputMapper(root, options, rels),
    sourceOf: declarationSources(root, relSet, decls),
  };
}

const dirOf = (rel: string): string => (rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "");
const joinPath = (dir: string, name: string): string => (dir === "" ? name : `${dir}/${name}`);

/** A path relative to the project root, with forward slashes. Undefined when it lies outside the project. */
function projectPath(root: string, abs: string): string | undefined {
  const rel = relative(root, abs).split(sep).join("/");
  return rel === ".." || rel.startsWith("../") || isAbsolute(rel) ? undefined : rel;
}

/** The directory the files share, or undefined when there are none. Empty when they share only the root. */
function commonDir(files: string[]): string | undefined {
  if (files.length === 0) return undefined;
  const dirs = files.map((f) => dirOf(f).split("/").filter((s) => s !== ""));
  let common = dirs[0] ?? [];
  for (const d of dirs) {
    let i = 0;
    while (i < common.length && i < d.length && common[i] === d[i]) i++;
    common = common.slice(0, i);
  }
  return common.join("/");
}

/**
 * Maps a project path under the compiler's output directory back to the same path under its source directory:
 * `rootDir` when set, otherwise the directory the sources share, as tsc infers it. Other paths map to nothing.
 */
function outputMapper(root: string, options: ts.CompilerOptions, rels: string[]): (rel: string) => string | undefined {
  const outDir = options.outDir ? projectPath(root, options.outDir) : undefined;
  const srcDir = options.rootDir ? projectPath(root, options.rootDir) : commonDir(rels.filter((r) => !r.endsWith(".d.ts")));
  if (!outDir || srcDir === undefined) return () => undefined;
  return (rel) => (rel.startsWith(`${outDir}/`) ? joinPath(srcDir, rel.slice(outDir.length + 1)) : undefined);
}

/** Where a package's compiler writes its output and reads its sources, as project paths. */
interface OutputLayout {
  outDir: string;
  srcDir: string;
}

/** The suffixes of a declaration file, and the source suffixes it can have been built from. */
const DECL_SUFFIX = /\.d\.[mc]?ts$/;
const SOURCE_SUFFIXES = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

/** The path with symbolic links resolved, or the path itself when it cannot be resolved. */
function realOf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * A package's output and source directories, from its tsconfig.json `outDir` and `rootDir`. Without a config, or
 * without those options, they default to `dist` and `src`. Undefined when either lies outside the project.
 */
function readOutputLayout(root: string, pkgDir: string): OutputLayout | undefined {
  const pkgAbs = join(root, pkgDir);
  let options: ts.CompilerOptions = {};
  const config = join(pkgAbs, "tsconfig.json");
  if (existsSync(config)) {
    const read = ts.readConfigFile(config, ts.sys.readFile);
    // Clearing files and include stops reading the config from scanning the package for inputs.
    if (!read.error) options = ts.parseJsonConfigFileContent({ ...read.config, files: [], include: [] }, ts.sys, pkgAbs).options;
  }
  const outDir = projectPath(root, options.outDir ?? join(pkgAbs, "dist"));
  const srcDir = projectPath(root, options.rootDir ?? join(pkgAbs, "src"));
  if (!outDir || srcDir === undefined) return undefined;
  return { outDir, srcDir };
}

/** The indexed source file that a declaration file under a layout's output directory was built from. */
function sourceIn(layout: OutputLayout, dts: string, rels: Set<string>): string | undefined {
  const prefix = `${layout.outDir}/`;
  if (!dts.startsWith(prefix)) return undefined;
  const base = joinPath(layout.srcDir, dts.slice(prefix.length).replace(DECL_SUFFIX, ""));
  return SOURCE_SUFFIXES.map((suffix) => base + suffix).find((candidate) => rels.has(candidate));
}

/**
 * The qualified name a declaration-file node has in the source it was built from, named as assignDecls names it:
 * `Class.member` for a member, `default` for an unnamed declaration. Undefined for a node no source declaration matches.
 */
function declFileQname(node: ts.Node): string | undefined {
  let own: string | undefined;
  if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) {
    own = node.name?.text ?? "default";
  } else if (ts.isInterfaceDeclaration(node)) {
    own = node.name.text;
  } else if (ts.isConstructorDeclaration(node)) {
    own = "constructor";
  } else if (ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node) || ts.isPropertyDeclaration(node)) {
    own = propName(node.name);
  } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
    own = node.name.text;
  }
  if (own === undefined) return undefined;
  const names = [own];
  for (let p = node.parent; p !== undefined && !ts.isSourceFile(p); p = p.parent) {
    if (ts.isClassDeclaration(p)) names.unshift(p.name?.text ?? "default");
  }
  return names.join(".");
}

/**
 * Maps a declaration in a built `.d.ts` file to the declaration its source defines. A declaration file inside a
 * package's output directory is mapped to the source under that package's rootDir, and the declaration there with the
 * same qualified name is the answer. Declaration files under node_modules, outside the project, or with no indexed
 * source are not mapped. Each file's mapping and each package's config are read once.
 */
function declarationSources(root: string, rels: Set<string>, decls: Map<ts.Node, Decl>): (node: ts.Node) => Decl | undefined {
  const byId = new Map<string, Decl>();
  for (const d of decls.values()) byId.set(d.id, d);
  const realRoot = realOf(root);
  const layouts = new Map<string, OutputLayout | undefined>();
  const layoutOf = (dir: string): OutputLayout | undefined => {
    if (!layouts.has(dir)) layouts.set(dir, readOutputLayout(root, dir));
    return layouts.get(dir);
  };
  /**
   * The source file of a declaration file, by its path. Walks up from the file to the nearest directory with a
   * package.json or tsconfig.json whose output directory holds it. A package.json inside a build output does not own it.
   */
  const mapFile = (fileName: string): string | undefined => {
    const dts = projectPath(realRoot, realOf(fileName));
    if (dts === undefined || !DECL_SUFFIX.test(dts) || dts.split("/").includes("node_modules")) return undefined;
    let dir = dirOf(dts);
    for (;;) {
      if (existsSync(join(root, joinPath(dir, "package.json"))) || existsSync(join(root, joinPath(dir, "tsconfig.json")))) {
        const layout = layoutOf(dir);
        const source = layout && sourceIn(layout, dts, rels);
        if (source) return source;
      }
      if (dir === "") return undefined;
      dir = dirOf(dir);
    }
  };
  const mapped = new Map<string, string | undefined>();
  return (node) => {
    const sf = node.getSourceFile();
    if (!sf.isDeclarationFile) return undefined;
    const qname = declFileQname(node);
    if (qname === undefined) return undefined;
    if (!mapped.has(sf.fileName)) mapped.set(sf.fileName, mapFile(sf.fileName));
    const source = mapped.get(sf.fileName);
    return source === undefined ? undefined : byId.get(`${source}#${qname}`);
  };
}

/** Joins a relative path onto a project directory and normalises it. Undefined when it climbs above the project root. */
function joinRel(dir: string, spec: string): string | undefined {
  const parts: string[] = [];
  for (const seg of [dir, spec].join("/").split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg !== "..") {
      parts.push(seg);
    } else if (parts.length > 0) {
      parts.pop();
    } else {
      return undefined;
    }
  }
  return parts.join("/");
}

/**
 * The project paths a normalised path may name, in order: its source name first (`w.js` is `w.ts`), then the path
 * itself, then with each extension and as an index file.
 */
function candidatesAt(base: string): string[] {
  if (base === "") return [];
  const out = new Set<string>();
  for (const [output, source] of SOURCE_FOR_OUTPUT) {
    if (base.endsWith(output)) out.add(base.slice(0, -output.length) + source);
  }
  out.add(base);
  for (const e of [".ts", ".tsx", ".d.ts", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"]) {
    out.add(`${base}${e}`);
    out.add(`${base}/index${e}`);
  }
  return [...out];
}

/**
 * The nearest directory, from a file's own up to the root, that holds a package.json. Each manifest it checks is
 * recorded in `tried`, because creating one can change the answer.
 */
function nearestPackageDir(project: Project, rel: string, tried: string[]): string {
  let dir = dirOf(rel);
  for (;;) {
    const manifest = joinPath(dir, "package.json");
    tried.push(manifest);
    if (existsSync(join(project.root, manifest))) return dir;
    if (dir === "") return "";
    dir = dirOf(dir);
  }
}

/** Where a script path resolves, and how sure that is. `tried` lists every candidate considered, for dependencies. */
interface Resolution {
  to?: string;
  confidence?: Confidence;
  tried: string[];
}

/**
 * Resolves a script path to a project file. A `file` path is tried from its file's directory: exact. A `cwd` path
 * is tried from the nearest package directory, then from the project root: heuristic. When neither names a project
 * file, each path is mapped from the output directory back to the source directory: inferred.
 */
function resolveScript(project: Project, rel: string, script: ScriptPath): Resolution {
  const tried: string[] = [];
  const bases: { dir: string; confidence: Confidence }[] = [];
  if (script.base === "file") {
    bases.push({ dir: dirOf(rel), confidence: "exact" });
  } else {
    const pkg = nearestPackageDir(project, rel, tried);
    bases.push({ dir: pkg, confidence: "heuristic" });
    if (pkg !== "") bases.push({ dir: "", confidence: "heuristic" });
  }
  const paths = bases.flatMap(({ dir, confidence }) => {
    const at = joinRel(dir, script.path);
    return at === undefined ? [] : [{ at, confidence }];
  });
  const plain = paths.map(({ at, confidence }) => ({ confidence, names: candidatesAt(at) }));
  const mapped = paths.flatMap(({ at }) => {
    const source = project.mapOutput(at);
    return source === undefined ? [] : [{ confidence: "inferred" as const, names: candidatesAt(source) }];
  });
  const built = paths.flatMap(({ at }) => buildSourcesOf(at).map((source) => ({ confidence: "inferred" as const, names: candidatesAt(source) })));
  const groups = [...plain, ...mapped, ...built];
  // Every candidate is recorded, so that creating any of them re-extracts the file. The first hit in order wins.
  for (const group of groups) tried.push(...group.names);
  for (const group of groups) {
    const hit = group.names.find((name) => project.rels.has(name));
    if (hit !== undefined) return { to: hit, confidence: group.confidence, tried };
  }
  return { tried };
}

/** Directory names a build writes its compiled output into. */
const BUILD_OUTPUT_DIRS = new Set(["dist", "build", "out", "lib"]);

/** The source extensions a compiled file may have come from, for each output extension. The output name is also tried. */
const SOURCE_EXTS_FOR_BUILT: Record<string, string[]> = { ".js": [".ts", ".tsx"], ".jsx": [".tsx"], ".mjs": [".mts"], ".cjs": [".cts"] };

/**
 * Where a build's output path may have been compiled from: the same path with a build-output directory renamed to `src`,
 * and the source extension in place of the output one. Used when the compiler's own output mapping does not reach the file,
 * as for a package that builds into its own `dist/`. Each candidate is still checked against the project's files.
 */
function buildSourcesOf(at: string): string[] {
  const parts = at.split("/");
  const out: string[] = [];
  parts.forEach((seg, i) => {
    if (!BUILD_OUTPUT_DIRS.has(seg)) return;
    const renamed = [...parts];
    renamed[i] = "src";
    const path = renamed.join("/");
    const ext = /\.(js|jsx|mjs|cjs)$/.exec(path)?.[0];
    if (ext === undefined) return;
    const stem = path.slice(0, -ext.length);
    for (const source of SOURCE_EXTS_FOR_BUILT[ext] ?? []) out.push(stem + source);
    out.push(path);
  });
  return out;
}

/** The expression inside any parentheses around it. */
function unwrap(e: ts.Expression): ts.Expression {
  let inner = e;
  while (ts.isParenthesizedExpression(inner)) inner = inner.expression;
  return inner;
}

function pos(sf: ts.SourceFile, offset: number): [number, number] {
  const p = sf.getLineAndCharacterOfPosition(offset);
  return [p.line, p.character];
}

function spanOf(rel: string, sf: ts.SourceFile, node: ts.Node): Span {
  return { file: rel, start: pos(sf, node.getStart(sf)), end: pos(sf, node.getEnd()) };
}

/** The name node of a callee or tag: `b` for `a.b`, the node itself otherwise. */
const nameOf = (e: ts.Expression): ts.Node => (ts.isPropertyAccessExpression(e) ? e.name : e);

/** The most call sites of one wrapper whose URL argument is resolved. A wrapper with more is left at its `<dynamic>` node. */
const MAX_WRAPPER_SITES = 100;

/** The function a declaration names: a function-like node, or the arrow or function expression a const holds. */
function fnNodeOf(node: ts.Node): ts.SignatureDeclaration | undefined {
  if (ts.isVariableDeclaration(node) && node.initializer !== undefined) {
    const init = unwrapAll(node.initializer);
    return ts.isArrowFunction(init) || ts.isFunctionExpression(init) ? init : undefined;
  }
  return ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node) ? node : undefined;
}

/** The name node a function is declared under, for its symbol. */
function fnNameNode(fn: ts.SignatureDeclaration): ts.Node | undefined {
  if ((ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn)) && fn.name !== undefined) return fn.name;
  if ((ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && fn.parent && ts.isVariableDeclaration(fn.parent)) return fn.parent.name;
  return undefined;
}

/** A symbol with an import alias followed to what it names. */
function resolvedSymbol(checker: ts.TypeChecker, sym: ts.Symbol | undefined): ts.Symbol | undefined {
  if (sym && sym.flags & ts.SymbolFlags.Alias) {
    try {
      return checker.getAliasedSymbol(sym);
    } catch {
      return undefined;
    }
  }
  return sym;
}

const siteCounts = new WeakMap<Project, Map<ts.Node, number>>();

/**
 * How many calls in the project resolve to a function, counted up to one past MAX_WRAPPER_SITES. The program's project files
 * are scanned once per function and cached for the run.
 */
function callSiteCount(project: Project, fn: ts.SignatureDeclaration): number {
  let cache = siteCounts.get(project);
  if (cache === undefined) {
    cache = new Map();
    siteCounts.set(project, cache);
  }
  const hit = cache.get(fn);
  if (hit !== undefined) return hit;
  const nameNode = fnNameNode(fn);
  const target = nameNode === undefined ? undefined : resolvedSymbol(project.checker, project.checker.getSymbolAtLocation(nameNode));
  let count = 0;
  if (target !== undefined) {
    const limit = MAX_WRAPPER_SITES + 1;
    for (const sf of project.program.getSourceFiles()) {
      if (sf.isDeclarationFile || sf.fileName.includes("/node_modules/")) continue;
      const visit = (n: ts.Node): void => {
        if (count >= limit) return;
        if (ts.isCallExpression(n) && resolvedSymbol(project.checker, project.checker.getSymbolAtLocation(nameOf(n.expression))) === target) count++;
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
  }
  cache.set(fn, count);
  return count;
}

/** The nearest function-like node a node sits in. */
function enclosingFn(node: ts.Node): ts.SignatureDeclaration | undefined {
  let p: ts.Node | undefined = node.parent;
  while (p !== undefined && !ts.isFunctionLike(p)) p = p.parent;
  return p as ts.SignatureDeclaration | undefined;
}

/** A parameter name the URL expression reads: an identifier that is not the name of a property access. */
function readsParam(e: ts.Node, params: readonly string[]): boolean {
  if (ts.isIdentifier(e) && params.includes(e.text) && !(e.parent && ts.isPropertyAccessExpression(e.parent) && e.parent.name === e)) return true;
  let found = false;
  ts.forEachChild(e, (c) => {
    found = readsParam(c, params);
    return found;
  });
  return found;
}

/** A function that hands a parameter to fetch as its URL: the fetch call inside it, and the parameter names. */
export interface Wrapper {
  params: string[];
  fetch: ts.CallExpression;
  sf: ts.SourceFile;
}

const wrappers = new WeakMap<ts.Node, Wrapper | null>();

/** The wrapper a function is, when a fetch-like call in its own body takes its URL from one of its parameters. */
function wrapperOf(project: Project, fn: ts.SignatureDeclaration): Wrapper | undefined {
  const known = wrappers.get(fn);
  if (known !== undefined) return known ?? undefined;
  const params = fn.parameters.map((p) => (ts.isIdentifier(p.name) ? p.name.text : ""));
  let out: Wrapper | null = null;
  const sf = fn.getSourceFile();
  const imports = importBindings(sf);
  const env = workerEnvFor(project, sf);
  const visit = (n: ts.Node): void => {
    if (out !== null) return;
    if (ts.isCallExpression(n) && enclosingFn(n) === fn) {
      const callee = declOf(project, project.checker.getSymbolAtLocation(nameOf(n.expression)));
      const m = callee?.entity.type === "function" ? undefined : matchFetch(n, imports, env);
      const url = n.arguments[0];
      if (m !== undefined && url !== undefined && readsParam(url, params)) out = { params, fetch: n, sf };
    }
    ts.forEachChild(n, visit);
  };
  const body = (fn as { body?: ts.Node }).body;
  if (body !== undefined) visit(body);
  wrappers.set(fn, out);
  return out ?? undefined;
}

/** The declaration a symbol names, following an import alias. Undefined when the project does not declare it. */
function declOf(project: Project, sym: ts.Symbol | undefined): Decl | undefined {
  let resolved = sym;
  if (resolved && resolved.flags & ts.SymbolFlags.Alias) {
    try {
      resolved = project.checker.getAliasedSymbol(resolved);
    } catch {
      // an unresolvable alias simply has no target
    }
  }
  const declNode = resolved?.valueDeclaration ?? resolved?.declarations?.[0];
  // A namespace import names a file, whose module entry is not a callable declaration: it is not a target.
  if (!declNode || ts.isSourceFile(declNode)) return undefined;
  // A workspace package's call resolves to its built .d.ts, which is not indexed: its source declaration is the target.
  return project.decls.get(declNode) ?? project.sourceOf(declNode);
}

/** The function that `new` runs: the function itself, or a class's own constructor. A class without one has none. */
function callableOf(project: Project, decl: Decl | undefined): Decl | undefined {
  if (!decl) return undefined;
  if (decl.entity.type === "function") return decl;
  if (decl.entity.type === "type" && decl.entity.typeKind === "class") {
    const ctor = (decl.node as ts.ClassDeclaration).members.find((m) => ts.isConstructorDeclaration(m) && m.body !== undefined);
    return ctor ? project.decls.get(ctor) : undefined;
  }
  return undefined;
}

/** The outermost property access that `id` is the name of: `a.b` for the `b` in `a.b.c`. */
function headOf(id: ts.Node): ts.Node {
  let e = id;
  while (ts.isPropertyAccessExpression(e.parent) && e.parent.name === e) e = e.parent;
  return e;
}

/**
 * True when an identifier names something rather than uses it: a declaration, import or export name,
 * or the callee of a call or `new`, or a JSX tag. Those are recorded by other edges or not at all.
 */
function isNonUse(id: ts.Identifier): boolean {
  const parent = id.parent;
  if (ts.isShorthandPropertyAssignment(parent)) return false;
  if (ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent) || ts.isImportEqualsDeclaration(parent) || ts.isExportSpecifier(parent)) {
    return true;
  }
  if (!ts.isPropertyAccessExpression(parent) && (parent as ts.NamedDeclaration).name === id) return true;
  const head = headOf(id);
  const up = head.parent;
  if (ts.isCallExpression(up) || ts.isNewExpression(up)) return up.expression === head;
  if (ts.isJsxOpeningElement(up) || ts.isJsxSelfClosingElement(up) || ts.isJsxClosingElement(up)) return up.tagName === head;
  return false;
}

/** JSX tags starting with a lowercase letter, or containing a dash, are host elements, not components. */
const isIntrinsicTag = (name: string): boolean => /^[a-z]/.test(name) || name.includes("-");

/** Whether a call's value is awaited, looking through parentheses and type assertions. */
function isAwaited(call: ts.CallExpression): boolean {
  let up: ts.Node = call;
  while (ts.isParenthesizedExpression(up.parent) || ts.isAsExpression(up.parent) || ts.isNonNullExpression(up.parent)) {
    up = up.parent;
  }
  return ts.isAwaitExpression(up.parent);
}

/** How a function hands work to another: awaited, started without waiting, or scheduled to run later. */
type Dispatch = "await" | "start" | "callback" | "timer" | "microtask" | "message";

/** Compiled output names its source, which TypeScript resolves to: `./w.js` is `w.ts` in the project. */
const SOURCE_FOR_OUTPUT: [string, string][] = [
  [".js", ".ts"],
  [".jsx", ".tsx"],
  [".mjs", ".mts"],
  [".cjs", ".cts"],
];

/** The expression with every wrapper removed: parentheses, `as`, `<T>` and `!`. */
function unwrapAll(e: ts.Expression): ts.Expression {
  let inner = e;
  while (ts.isParenthesizedExpression(inner) || ts.isAsExpression(inner) || ts.isTypeAssertionExpression(inner) || ts.isNonNullExpression(inner)) {
    inner = inner.expression;
  }
  return inner;
}

/** The browser's Worker and SharedWorker are globals. A name the file or project declares is not one of them. */
function workerEnvFor(project: Project, sf: ts.SourceFile): WorkerEnv {
  return {
    constOf: (id) => {
      const d = project.checker.getSymbolAtLocation(id)?.valueDeclaration;
      if (d === undefined || !ts.isVariableDeclaration(d) || !ts.isIdentifier(d.name) || d.initializer === undefined) return undefined;
      if ((ts.getCombinedNodeFlags(d) & ts.NodeFlags.Const) === 0 || d.getSourceFile() !== sf) return undefined;
      return d.initializer;
    },
    fnBody: (id) => {
      const d = project.checker.getSymbolAtLocation(id)?.valueDeclaration;
      if (d === undefined || d.getSourceFile() !== sf) return undefined;
      let fn: ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction | undefined;
      if (ts.isFunctionDeclaration(d)) fn = d;
      else if (ts.isVariableDeclaration(d) && d.initializer !== undefined) {
        const init = unwrapAll(d.initializer);
        if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) fn = init;
      }
      if (fn === undefined || fn.body === undefined) return undefined;
      if (!ts.isBlock(fn.body)) return fn.body;
      if (fn.body.statements.length !== 1) return undefined;
      const only = fn.body.statements[0];
      return only !== undefined && ts.isReturnStatement(only) ? only.expression : undefined;
    },
    declared: (id) => {
      const sym = project.checker.getSymbolAtLocation(id);
      const d = sym?.valueDeclaration ?? sym?.declarations?.[0];
      return d !== undefined && !d.getSourceFile().isDeclarationFile;
    },
  };
}

/** The project function a callback names: an inline function, or an identifier or property reference to one. */
function callbackDecl(project: Project, arg: ts.Expression | undefined): Decl | undefined {
  if (!arg) return undefined;
  const e = unwrapAll(arg);
  if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) {
    const inline = project.decls.get(e);
    return inline?.entity.type === "function" ? inline : undefined;
  }
  if (!(ts.isIdentifier(e) || ts.isPropertyAccessExpression(e))) return undefined;
  const target = declOf(project, project.checker.getSymbolAtLocation(nameOf(e)));
  return target?.entity.type === "function" ? target : undefined;
}

/** `self` or `globalThis`, the global object of a worker or page, possibly behind a cast or a const that holds it. */
function isGlobalSelf(project: Project, e: ts.Expression, depth = 0): boolean {
  const x = unwrapAll(e);
  if (!ts.isIdentifier(x) || depth > 6) return false;
  const sym = project.checker.getSymbolAtLocation(x);
  const d = sym?.valueDeclaration;
  if (d !== undefined && ts.isVariableDeclaration(d) && d.initializer !== undefined) return isGlobalSelf(project, d.initializer, depth + 1);
  if (x.text !== "self" && x.text !== "globalThis") return false;
  // A name the project declares is not the global object. The library's declarations of it are.
  return (sym?.declarations ?? []).every((decl) => decl.getSourceFile().isDeclarationFile);
}

/** A handler an expression installs on an object: `r.onmessage = fn`, a bare `onmessage = fn`, or `r.addEventListener("message", fn)`. */
interface Registration {
  event: string;
  at: ts.Expression;
  /** The object the handler is installed on. Undefined for a bare name, which is the global object. */
  receiver: ts.Expression | undefined;
}

function registrationOf(node: ts.Node): Registration | undefined {
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    const left = node.left;
    if (ts.isPropertyAccessExpression(left) && /^on[a-z]+$/.test(left.name.text)) {
      return { event: left.name.text.slice(2), at: node.right, receiver: left.expression };
    }
    if (ts.isIdentifier(left) && /^on[a-z]+$/.test(left.text)) return { event: left.text.slice(2), at: node.right, receiver: undefined };
  }
  if (ts.isCallExpression(node)) {
    const callee = node.expression;
    const isAdd = ts.isPropertyAccessExpression(callee)
      ? callee.name.text === "addEventListener"
      : ts.isIdentifier(callee) && callee.text === "addEventListener";
    const first = node.arguments[0];
    const at = node.arguments[1];
    if (isAdd && first !== undefined && ts.isStringLiteralLike(first) && at !== undefined) {
      return { event: first.text, at, receiver: ts.isPropertyAccessExpression(callee) ? callee.expression : undefined };
    }
  }
  return undefined;
}

/** The `message` handlers a worker file registers at its top level, on its own global object or an alias of it. */
function workerHandlers(project: Project, rel: string): Decl[] {
  const sf = project.sourceFor(rel);
  if (!sf) return [];
  const out: Decl[] = [];
  for (const stmt of sf.statements) {
    if (!ts.isExpressionStatement(stmt)) continue;
    const reg = registrationOf(stmt.expression);
    if (reg?.event !== "message") continue;
    if (reg.receiver !== undefined && !isGlobalSelf(project, reg.receiver)) continue;
    const target = callbackDecl(project, reg.at);
    if (target !== undefined) out.push(target);
  }
  return out;
}

/** The nearest class that holds a node, or undefined outside any class. */
function enclosingClass(node: ts.Node): ts.ClassLikeDeclaration | undefined {
  for (let n: ts.Node | undefined = node.parent; n !== undefined; n = n.parent) {
    if (ts.isClassLike(n)) return n;
  }
  return undefined;
}

/**
 * The `new Worker(...)` constructors (browser Workers) an expression may hold. Follows a const's initializer, a class
 * field assigned from anywhere in its class, and the return values of a function it calls. A parameter holds none.
 */
function workerCtors(project: Project, expr: ts.Expression, depth = 0): ts.NewExpression[] {
  if (depth > 6) return [];
  const e = unwrapAll(expr);
  if (ts.isNewExpression(e)) {
    const sf = e.getSourceFile();
    return matchWorker(e, importBindings(sf), workerEnvFor(project, sf))?.api === "Worker" ? [e] : [];
  }
  if (ts.isIdentifier(e)) {
    const d = project.checker.getSymbolAtLocation(e)?.valueDeclaration;
    return d !== undefined && ts.isVariableDeclaration(d) && d.initializer !== undefined ? workerCtors(project, d.initializer, depth + 1) : [];
  }
  if (ts.isPropertyAccessExpression(e) && e.expression.kind === ts.SyntaxKind.ThisKeyword) {
    const cls = enclosingClass(e);
    const out: ts.NewExpression[] = [];
    if (cls === undefined) return out;
    const name = e.name.text;
    const scan = (n: ts.Node): void => {
      if (
        ts.isBinaryExpression(n) &&
        n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isPropertyAccessExpression(n.left) &&
        n.left.expression.kind === ts.SyntaxKind.ThisKeyword &&
        n.left.name.text === name
      ) {
        out.push(...workerCtors(project, n.right, depth + 1));
      } else if (ts.isPropertyDeclaration(n) && n.initializer !== undefined && ts.isIdentifier(n.name) && n.name.text === name) {
        out.push(...workerCtors(project, n.initializer, depth + 1));
      }
      ts.forEachChild(n, scan);
    };
    scan(cls);
    return out;
  }
  if (ts.isCallExpression(e)) {
    const node = declOf(project, project.checker.getSymbolAtLocation(nameOf(e.expression)))?.node;
    if (node === undefined || !(ts.isMethodDeclaration(node) || ts.isFunctionDeclaration(node)) || node.body === undefined) return [];
    const body = node.body;
    const out: ts.NewExpression[] = [];
    const scan = (n: ts.Node): void => {
      if (ts.isReturnStatement(n) && n.expression !== undefined) out.push(...workerCtors(project, n.expression, depth + 1));
      if (n !== body && ts.isFunctionLike(n)) return;
      ts.forEachChild(n, scan);
    };
    scan(body);
    return out;
  }
  return [];
}

/** Every browser worker a project constructs, with the file that constructs it and the handlers on its object. */
interface WorkerIndex {
  /** Each Worker constructor that names a project script: the file that holds it, and the worker file it runs. */
  ctors: Map<ts.NewExpression, { rel: string; to: string }>;
  /** The Worker constructors that run each worker file. */
  byTarget: Map<string, ts.NewExpression[]>;
  /** The `message` handlers installed on each Worker's object, anywhere in the project. */
  handlers: Map<ts.NewExpression, Decl[]>;
}

const workerIndexes = new WeakMap<Project, WorkerIndex>();

/** Built once per project, on the first postMessage that needs it. */
function workerIndex(project: Project): WorkerIndex {
  const cached = workerIndexes.get(project);
  if (cached !== undefined) return cached;
  const index: WorkerIndex = { ctors: new Map(), byTarget: new Map(), handlers: new Map() };
  for (const rel of project.rels) {
    const sf = project.sourceFor(rel);
    if (!sf || !sf.text.includes("Worker")) continue;
    const imports = importBindings(sf);
    const env = workerEnvFor(project, sf);
    const visit = (n: ts.Node): void => {
      if (ts.isNewExpression(n)) {
        const m = matchWorker(n, imports, env);
        const to = m?.api === "Worker" && m.script !== undefined ? resolveScript(project, rel, m.script).to : undefined;
        if (to !== undefined) {
          index.ctors.set(n, { rel, to });
          index.byTarget.set(to, [...(index.byTarget.get(to) ?? []), n]);
        }
      }
      const reg = registrationOf(n);
      if (reg?.event === "message" && reg.receiver !== undefined) {
        const handler = callbackDecl(project, reg.at);
        if (handler !== undefined) {
          for (const ctor of workerCtors(project, reg.receiver)) {
            index.handlers.set(ctor, [...(index.handlers.get(ctor) ?? []), handler]);
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  workerIndexes.set(project, index);
  return index;
}

/** Records and dependencies for one file. */
export function emitFile(project: Project, rel: string): IRBatch {
  const sf = project.sourceFor(rel);
  if (!sf) return { file: rel, records: [] };
  const records: IRRecord[] = [];
  const deps = new Set<string>();
  const imports = importBindings(sf);
  const moduleId = project.moduleOf(rel);
  // A spawn runs a script's module entry when the script has one, and the file otherwise.
  const spawnTarget = (to: string): string => project.moduleOf(to) ?? to;
  const workerEnv = workerEnvFor(project, sf);
  const usedIds = new Set<string>();
  const uniqueId = (base: string): string => {
    let id = `${rel}@${base}`;
    for (let n = 2; usedIds.has(id); n++) id = `${rel}@${base}~${n}`;
    usedIds.add(id);
    return id;
  };
  const push = (node: IRNode) => records.push({ node });
  const pushEdge = (edge: IREdge) => records.push({ edge });

  const dependOn = (target: string) => {
    if (target !== rel) deps.add(target);
  };

  /**
   * The project file a spawn's script names, with the confidence of that resolution. Every candidate the resolution
   * considers becomes a dependency, so creating one re-extracts this file.
   */
  const scriptTarget = (script: ScriptPath | undefined): { to: string; confidence: Confidence } | undefined => {
    if (script === undefined) return undefined;
    const found = resolveScript(project, rel, script);
    for (const name of found.tried) dependOn(name);
    return found.to !== undefined && found.confidence !== undefined ? { to: found.to, confidence: found.confidence } : undefined;
  };

  const emitModule = (from: string, spec: string, specNode: ts.Node, typeOnly: boolean, dynamic: boolean, kind: "packaging.import" | "packaging.re-export") => {
    const resolved = ts.resolveModuleName(spec, sf.fileName, project.options, project.host).resolvedModule;
    let to: NodeId | UnresolvedRef;
    const target = resolved && !resolved.isExternalLibraryImport ? relative(project.root, resolved.resolvedFileName).split(sep).join("/") : undefined;
    if (target !== undefined && project.rels.has(target)) {
      to = target;
      dependOn(target);
    } else {
      to = { unresolved: { scheme: "ts.import", text: spec } };
      if (spec.startsWith(".")) {
        for (const c of importCandidates(rel, spec)) deps.add(c);
      }
    }
    const attrs: Record<string, unknown> = kind === "packaging.import" ? { specifier: spec, typeOnly, dynamic } : { specifier: spec };
    pushEdge({ from, to, facet: "packaging", kind, attrs, span: spanOf(rel, sf, specNode), provenance: PROV });
  };

  const visit = (node: ts.Node, container: string, fn: string): void => {
    let nextContainer = container;
    let nextFn = fn;
    // Code that runs at the top of the file belongs to its module entry, when it has one. Structure keeps the file as parent.
    const owner = container === rel && moduleId !== undefined ? moduleId : container;
    const decl = project.decls.get(node);
    if (decl && decl.rel === rel) {
      const span = decl.entity.type === "function" && decl.entity.module === true ? moduleSpan(rel, sf) : spanOf(rel, sf, node);
      if (decl.entity.type === "type") {
        push({
          id: decl.id,
          facet: "structure",
          kind: "structure.type",
          parent: container,
          attrs: { name: decl.entity.name, typeKind: decl.entity.typeKind },
          span,
          provenance: PROV,
        });
      } else {
        push({
          id: decl.id,
          facet: "structure",
          kind: "structure.function",
          // A top-level lambda is written in its module entry, so folding it reaches that entry's owner.
          parent: decl.entity.anonymous ? owner : container,
          attrs: {
            name: decl.entity.name,
            qualifiedName: decl.qname,
            async: decl.entity.async,
            exported: decl.entity.exported,
            ...(decl.entity.anonymous ? { anonymous: true } : {}),
            ...(decl.entity.module ? { module: true } : {}),
            ...(decl.entity.htmlEntry ? { htmlEntry: true } : {}),
            ...(decl.entity.nodeEntry ? { nodeEntry: true } : {}),
          },
          span,
          provenance: PROV,
        });
        if (decl.entity.anonymous) {
          // The function is made here, so its creator reaches whatever it calls: a closure edge from the enclosing function.
          pushEdge({ from: fn, to: decl.id, facet: "calls", kind: "calls.reference", attrs: { how: "closure" }, span, provenance: PROV });
        }
        nextFn = decl.id;
        if (decl.entity.async) {
          push({
            id: `async:${decl.id}`,
            facet: "concurrency",
            kind: "concurrency.async-task",
            parent: decl.id,
            attrs: { name: decl.entity.name },
            span,
            provenance: PROV,
          });
        }
        if (decl.entity.generator) {
          // A generator is a coroutine: it suspends at each yield and is resumed by its caller.
          push({
            id: `coroutine:${decl.id}`,
            facet: "concurrency",
            kind: "concurrency.coroutine",
            parent: decl.id,
            attrs: { name: decl.entity.name, variant: decl.entity.async ? "async-generator" : "generator" },
            span,
            provenance: PROV,
          });
        }
      }
      // A module entry holds the file's top-level code, but declarations there stay in the file's structure.
      if (!(decl.entity.type === "function" && decl.entity.module === true)) nextContainer = decl.id;
    }

    /** A function that `fn` refers to without calling it: constructed, rendered as JSX, or used as a value. */
    const reference = (target: Decl, how: "new" | "jsx" | "value", at: ts.Node) => {
      pushEdge({
        from: fn,
        to: target.id,
        facet: "calls",
        kind: "calls.reference",
        attrs: { how },
        span: spanOf(rel, sf, at),
        provenance: PROV,
      });
      dependOn(target.rel);
    };

    /** A hand-off from the enclosing function to a project function. Each call site gets its own edge. */
    const dispatch = (target: Decl, how: Dispatch, at: ts.Node) => {
      pushEdge({
        from: fn,
        to: target.id,
        facet: "concurrency",
        kind: "concurrency.dispatches",
        attrs: { how },
        span: spanOf(rel, sf, at),
        provenance: PROV,
      });
      dependOn(target.rel);
    };

    const callbackTarget = (arg: ts.Expression | undefined): Decl | undefined => callbackDecl(project, arg);

    /** The hand-offs one call makes: an async callee, awaited or started, and the callbacks it schedules. */
    const emitDispatches = (call: ts.CallExpression) => {
      const target = declOf(project, project.checker.getSymbolAtLocation(nameOf(call.expression)));
      // An async function runs as a task of its own, so calling it hands it work whether or not the call is awaited.
      if (target?.entity.type === "function" && target.entity.async) {
        dispatch(target, isAwaited(call) ? "await" : "start", call);
      }
      // An async function expression called on the spot (an async IIFE) is a task of its own, the same way.
      const iife = project.decls.get(unwrap(call.expression));
      if (iife?.entity.type === "function" && iife.entity.async) {
        dispatch(iife, isAwaited(call) ? "await" : "start", call);
      }
      // A callee the project declares is that declaration, not the runtime's scheduler, so it schedules nothing.
      const sched = matchSchedule(call, imports);
      if (sched && target === undefined) {
        const callbacks = new Set<Decl>();
        for (const i of sched.callbacks) {
          const cb = callbackTarget(call.arguments[i]);
          if (cb) callbacks.add(cb);
        }
        for (const cb of callbacks) dispatch(cb, sched.how, call);
      }
    };

    /**
     * A message across a worker boundary, as a dispatch with how "message". A page's postMessage to a Worker it constructs
     * reaches the handlers the worker file registers at its top level. A worker's postMessage reaches the handlers installed
     * on each Worker that runs its file. Both ends must resolve, or nothing is emitted.
     */
    const emitMessages = (call: ts.CallExpression) => {
      const callee = call.expression;
      const named = ts.isPropertyAccessExpression(callee)
        ? callee.name.text === "postMessage"
        : ts.isIdentifier(callee) && callee.text === "postMessage" && !workerEnv.declared?.(callee);
      if (!named) return;
      const index = workerIndex(project);
      const sent = new Set<string>();
      const message = (target: Decl) => {
        if (sent.has(target.id)) return;
        sent.add(target.id);
        pushEdge({
          from: fn,
          to: target.id,
          facet: "concurrency",
          kind: "concurrency.dispatches",
          attrs: { how: "message" },
          span: spanOf(rel, sf, call),
          provenance: { frontend: FRONTEND_ID, confidence: "inferred" },
        });
        dependOn(target.rel);
      };
      if (ts.isPropertyAccessExpression(callee)) {
        // Page to worker: the Worker this posts to, and the handlers its worker file registers at the top level.
        for (const ctor of workerCtors(project, callee.expression)) {
          const worker = index.ctors.get(ctor);
          if (worker === undefined) continue;
          dependOn(worker.rel);
          dependOn(worker.to);
          for (const handler of workerHandlers(project, worker.to)) message(handler);
        }
      }
      // Worker to page: a postMessage in a worker file, reaching the handlers on each Worker that runs the file.
      const fromWorker = ts.isPropertyAccessExpression(callee) ? isGlobalSelf(project, callee.expression) : true;
      if (fromWorker) {
        for (const ctor of index.byTarget.get(rel) ?? []) {
          const worker = index.ctors.get(ctor);
          if (worker === undefined) continue;
          dependOn(worker.rel);
          for (const handler of index.handlers.get(ctor) ?? []) message(handler);
        }
      }
    };

    /**
     * A handler the enclosing code installs: `x.onmessage = fn` or `x.addEventListener("message", fn)` with a project
     * function. The step opens the handler, and the reference lets reachability reach it from the installing code.
     */
    const emitHandler = (node: ts.Node) => {
      let event: string | undefined;
      let at: ts.Expression | undefined;
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(node.left) && /^on[a-z]+$/.test(node.left.name.text)) {
        event = node.left.name.text.slice(2);
        at = node.right;
      } else if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "addEventListener") {
        const first = node.arguments[0];
        if (first && ts.isStringLiteralLike(first)) {
          event = first.text;
          at = node.arguments[1];
        }
      }
      if (event === undefined || at === undefined) return;
      const target = callbackTarget(at);
      if (target === undefined) return;
      push({
        id: uniqueId(`handler:${pos(sf, node.getStart(sf)).join(":")}`),
        facet: "flow",
        kind: "flow.handler",
        parent: owner,
        attrs: { label: `on ${event} ▸`, event, target: target.id },
        span: spanOf(rel, sf, node),
        provenance: PROV,
      });
      pushEdge({ from: fn, to: target.id, facet: "calls", kind: "calls.reference", attrs: { how: "handler" }, span: spanOf(rel, sf, node), provenance: PROV });
      dependOn(target.rel);
    };

    const emitCall = (call: ts.CallExpression) => {
      const callee = call.expression;
      const sym = project.checker.getSymbolAtLocation(nameOf(callee));
      const target = declOf(project, sym);
      if (target?.entity.type === "function") {
        pushEdge({
          from: fn,
          to: target.id,
          facet: "calls",
          kind: "calls.call",
          attrs: { callee: callee.getText(sf).slice(0, 200) },
          span: spanOf(rel, sf, callee),
          provenance: PROV,
        });
        dependOn(target.rel);
      } else {
        // A call through an interface or abstract member: every implementation the project declares is a candidate.
        const dispatch = dispatchFor(project, sym, ts.isPropertyAccessExpression(callee) ? callee.expression : undefined);
        if (dispatch !== undefined && dispatch.targets.length > 0) {
          const kept = dispatch.targets.slice(0, MAX_DISPATCH_TARGETS).map((t) => t.id);
          const [first, ...rest] = kept as [NodeId, ...NodeId[]];
          const truncated = dispatch.targets.length > MAX_DISPATCH_TARGETS;
          pushEdge({
            from: fn,
            to: { candidates: [first, ...rest] },
            facet: "calls",
            kind: "calls.call",
            attrs: { callee: callee.getText(sf).slice(0, 200), how: "interface", ...(truncated ? { truncated: true } : {}) },
            span: spanOf(rel, sf, callee),
            provenance: { frontend: FRONTEND_ID, confidence: "heuristic" },
          });
          // The candidate list depends on every implementation and on the type that declares the member, dropped ones included.
          for (const t of dispatch.targets) dependOn(t.rel);
          dependOn(dispatch.owner.rel);
        }
      }
      // A call to a function the project declares is that function, not a network request, so a fetch-named one is not matched.
      const effect = matchCall(call, imports) ?? (target?.entity.type === "function" ? undefined : matchFetch(call, imports, workerEnv));
      // An HTTP route the call registers on a server object: the path it serves, owned by the code that registers it.
      const serve = matchServe(call, imports);
      if (serve) {
        push({
          id: uniqueId(`serve:${pos(sf, call.getStart(sf)).join(":")}`),
          facet: "effects",
          kind: serve.kind,
          parent: owner,
          attrs: serve.attrs,
          span: spanOf(rel, sf, call),
          provenance: PROV,
        });
      }
      // A message a worker or page posts to its peer: a step of its own, since the runtime has no call the project declares.
      if (!effect && target === undefined && ts.isPropertyAccessExpression(callee) && callee.name.text === "postMessage") {
        push({
          id: uniqueId(`effect:${pos(sf, call.getStart(sf)).join(":")}`),
          facet: "effects",
          kind: "effects.message.post",
          parent: owner,
          attrs: { api: "postMessage" },
          span: spanOf(rel, sf, call),
          provenance: PROV,
        });
      }
      // A call to a wrapper (one level): the URL the caller passes for the wrapper's parameter, read with the caller's own names.
      // The node is owned by this caller and says which wrapper it went through. An unresolved argument emits nothing here.
      if (!effect && target?.entity.type === "function") {
        const fn = fnNodeOf(target.node);
        const wrapper = fn === undefined ? undefined : wrapperOf(project, fn);
        if (fn !== undefined && wrapper !== undefined && callSiteCount(project, fn) <= MAX_WRAPPER_SITES) {
          let unresolved = false;
          const argFor = (i: number): ts.Expression | undefined => {
            const a = call.arguments[i];
            return a === undefined || ts.isSpreadElement(a) ? undefined : a;
          };
          const paramIndex = (e: ts.Expression): number => (ts.isIdentifier(e) ? wrapper.params.indexOf(e.text) : -1);
          const hooks = {
            url: (e: ts.Expression): UrlText | undefined => {
              const i = paramIndex(e);
              if (i < 0) return undefined;
              const a = argFor(i);
              const resolved = a === undefined ? undefined : urlText(a, imports, workerEnv, true);
              if (resolved === undefined) unresolved = true;
              return resolved ?? { text: "\uFFFC", leadEnv: false };
            },
            method: (e: ts.Expression): string | undefined => {
              const i = paramIndex(e);
              const a = i < 0 ? undefined : argFor(i);
              const v = a === undefined ? undefined : unwrapAll(a);
              return v !== undefined && ts.isStringLiteralLike(v) ? v.text.toUpperCase() : undefined;
            },
            options: (e: ts.Expression): ts.Expression | undefined => {
              const i = paramIndex(e);
              const a = i < 0 ? undefined : argFor(i);
              const v = a === undefined ? undefined : unwrapAll(a);
              return v !== undefined && ts.isObjectLiteralExpression(v) ? v : undefined;
            },
          };
          const wrapperEnv = workerEnvFor(project, wrapper.sf);
          const m = matchFetch(wrapper.fetch, importBindings(wrapper.sf), wrapperEnv, hooks);
          if (m !== undefined && !unresolved) {
            const attrs = { ...m.attrs, via: target.entity.name };
            push({
              id: uniqueId(`effect:${pos(sf, call.getStart(sf)).join(":")}`),
              facet: "effects",
              kind: m.kind,
              parent: owner,
              attrs,
              span: spanOf(rel, sf, call),
              provenance: PROV,
            });
            dependOn(target.rel);
          }
        }
      }
      if (effect) {
        push({
          id: uniqueId(`effect:${pos(sf, call.getStart(sf)).join(":")}`),
          facet: "effects",
          kind: effect.kind,
          parent: owner,
          attrs: effect.attrs,
          span: spanOf(rel, sf, call),
          provenance: PROV,
        });
        if (effect.kind === "effects.proc.exec") {
          // Running a command starts a child process, which is also a concurrency fact.
          const spawnId = uniqueId(`spawn:${pos(sf, call.getStart(sf)).join(":")}`);
          push({
            id: spawnId,
            facet: "concurrency",
            kind: "concurrency.spawn-process",
            parent: owner,
            attrs: { target: effect.attrs.command, api: effect.attrs.api },
            span: spanOf(rel, sf, call),
            provenance: PROV,
          });
          // fork runs a script rather than a command, and so does a Node binary started with an argument vector: a project file
          // the process is told to run is the code it runs.
          const api = String(effect.attrs.api);
          const script = api === "child_process.fork" ? call.arguments[0] : nodeScriptArgument(call, api, imports);
          const ran = scriptTarget(scriptPath(script, imports, workerEnv));
          if (ran !== undefined) {
            pushEdge({ from: spawnId, to: spawnTarget(ran.to), facet: "concurrency", kind: "concurrency.spawns", attrs: { how: "process" }, span: spanOf(rel, sf, call), provenance: { frontend: FRONTEND_ID, confidence: ran.confidence } });
          }
        }
      }
    };

    const flow = (tag: string, kind: string, attrs: Record<string, unknown>, at: ts.Node = node) =>
      push({
        id: uniqueId(`${tag}:${pos(sf, at.getStart(sf)).join(":")}`),
        facet: "flow",
        kind,
        parent: owner,
        attrs,
        span: spanOf(rel, sf, at),
        provenance: PROV,
      });
    const arm = (label: string, at: ts.Node) => flow("arm", "flow.branch-arm", { label }, at);
    const block = (label: string, at: ts.Node) => flow("block", "flow.block", { label }, at);

    if (ts.isIfStatement(node)) {
      flow("if", "flow.branch", { condition: node.expression.getText(sf).slice(0, 200) });
      arm("then", node.thenStatement);
      if (node.elseStatement) arm("else", node.elseStatement);
    } else if (ts.isConditionalExpression(node)) {
      flow("cond", "flow.branch", { condition: node.condition.getText(sf).slice(0, 200) });
      arm("then", node.whenTrue);
      arm("else", node.whenFalse);
    } else if (ts.isSwitchStatement(node)) {
      flow("switch", "flow.switch", { hasDefault: node.caseBlock.clauses.some((c) => ts.isDefaultClause(c)) });
      for (const clause of node.caseBlock.clauses) {
        arm(ts.isDefaultClause(clause) ? "default" : `case ${clause.expression.getText(sf).slice(0, 60)}`, clause);
      }
    } else if (ts.isForStatement(node)) {
      flow("loop", "flow.loop", { variant: "for", condition: node.condition?.getText(sf).slice(0, 200) ?? "" });
      block("body", node.statement);
    } else if (ts.isForOfStatement(node)) {
      flow("loop", "flow.loop", { variant: "for-of", condition: `${node.initializer.getText(sf)} of ${node.expression.getText(sf)}`.slice(0, 200) });
      block("body", node.statement);
    } else if (ts.isForInStatement(node)) {
      flow("loop", "flow.loop", { variant: "for-in", condition: `${node.initializer.getText(sf)} in ${node.expression.getText(sf)}`.slice(0, 200) });
      block("body", node.statement);
    } else if (ts.isWhileStatement(node)) {
      flow("loop", "flow.loop", { variant: "while", condition: node.expression.getText(sf).slice(0, 200) });
      block("body", node.statement);
    } else if (ts.isDoStatement(node)) {
      flow("loop", "flow.loop", { variant: "do", condition: node.expression.getText(sf).slice(0, 200) });
      block("body", node.statement);
    } else if (ts.isTryStatement(node)) {
      flow("try", "flow.try", { hasFinally: node.finallyBlock !== undefined });
      block("try", node.tryBlock);
      if (node.catchClause) block("catch", node.catchClause);
      if (node.finallyBlock) block("finally", node.finallyBlock);
    } else if (ts.isThrowStatement(node)) {
      flow("throw", "flow.throw", {});
    } else if (ts.isReturnStatement(node)) {
      flow("return", "flow.return", {});
    } else if (ts.isBreakStatement(node) || ts.isContinueStatement(node)) {
      flow("jump", "flow.jump", { variant: ts.isBreakStatement(node) ? "break" : "continue", ...(node.label ? { label: node.label.text } : {}) });
    }

    if (ts.isAwaitExpression(node)) {
      push({
        id: uniqueId(`await:${pos(sf, node.getStart(sf)).join(":")}`),
        facet: "concurrency",
        kind: "concurrency.await",
        parent: owner,
        attrs: {},
        span: spanOf(rel, sf, node),
        provenance: PROV,
      });
    }

    if (ts.isNewExpression(node)) {
      const worker = matchWorker(node, imports, workerEnv);
      if (worker !== undefined) {
        const spawnId = uniqueId(`spawn:${pos(sf, node.getStart(sf)).join(":")}`);
        push({
          id: spawnId,
          facet: "concurrency",
          kind: "concurrency.spawn-thread",
          parent: owner,
          attrs: { target: worker.target, api: worker.api },
          span: spanOf(rel, sf, node),
          provenance: PROV,
        });
        const script = scriptTarget(worker.script);
        if (script !== undefined) {
          pushEdge({ from: spawnId, to: spawnTarget(script.to), facet: "concurrency", kind: "concurrency.spawns", attrs: { how: "thread" }, span: spanOf(rel, sf, node), provenance: { frontend: FRONTEND_ID, confidence: script.confidence } });
        }
      }
      const ctor = callableOf(project, declOf(project, project.checker.getSymbolAtLocation(nameOf(node.expression))));
      if (ctor) reference(ctor, "new", node.expression);
    }

    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName;
      if ((ts.isIdentifier(tag) && !isIntrinsicTag(tag.text)) || ts.isPropertyAccessExpression(tag)) {
        const component = callableOf(project, declOf(project, project.checker.getSymbolAtLocation(nameOf(tag))));
        if (component) reference(component, "jsx", tag);
      }
    }

    if (ts.isIdentifier(node) && !isNonUse(node)) {
      const sym = ts.isShorthandPropertyAssignment(node.parent)
        ? project.checker.getShorthandAssignmentValueSymbol(node.parent)
        : project.checker.getSymbolAtLocation(node);
      const target = declOf(project, sym);
      if (target?.entity.type === "function") reference(target, "value", node);
    }

    emitHandler(node);
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      emitModule(rel, node.moduleSpecifier.text, node.moduleSpecifier, node.importClause?.isTypeOnly ?? false, false, "packaging.import");
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      emitModule(rel, node.moduleSpecifier.text, node.moduleSpecifier, false, false, "packaging.re-export");
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) {
        emitModule(rel, node.arguments[0].text, node.arguments[0], false, true, "packaging.import");
      }
      emitCall(node);
      emitDispatches(node);
      emitMessages(node);
    } else if (ts.isPropertyAccessExpression(node)) {
      const name = matchEnvRead(node, imports);
      if (name !== undefined) {
        push({
          id: uniqueId(`env:${pos(sf, node.getStart(sf)).join(":")}`),
          facet: "effects",
          kind: "effects.env.read",
          parent: owner,
          attrs: { api: "process.env", name },
          span: spanOf(rel, sf, node),
          provenance: PROV,
        });
      }
    }

    // An HTTP verb exported from a file is a route the deployment serves.
    if (ts.isFunctionDeclaration(node) || ts.isVariableStatement(node) || ts.isExportDeclaration(node) || ts.isExportAssignment(node)) {
      for (const serve of matchExportRoute(node)) {
        push({
          id: uniqueId(`serve:${pos(sf, node.getStart(sf)).join(":")}`),
          facet: "effects",
          kind: serve.kind,
          parent: owner,
          attrs: serve.attrs,
          span: spanOf(rel, sf, node),
          provenance: PROV,
        });
      }
    }

    ts.forEachChild(node, (child) => {
      visit(child, nextContainer, nextFn);
    });
  };
  visit(sf, rel, rel);

  for (const d of project.program.getSyntacticDiagnostics(sf)) {
    const start = d.start ?? 0;
    const finding: IRFinding = {
      severity: "error",
      message: `syntax: ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`,
      span: { file: rel, start: pos(sf, start), end: pos(sf, start + (d.length ?? 0)) },
      provenance: PROV,
    };
    records.push({ finding });
  }

  return { file: rel, records, dependsOn: [...deps].sort() };
}

/** Paths a relative import could resolve to. Creating one of them re-extracts the importer. */
export function importCandidates(fromFile: string, specifier: string): string[] {
  const at = joinRel(dirOf(fromFile), specifier);
  return at === undefined ? [] : candidatesAt(at);
}

