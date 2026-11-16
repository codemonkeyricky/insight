import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import ts from "typescript";
import type { IREdge, IRFinding, IRNode, IRRecord, NodeId, Provenance, Span, UnresolvedRef } from "@insight/ir";
import type { IRBatch } from "@insight/sdk";
import { importBindings, matchCall, matchDispatchTable, matchEnvRead, matchEventSource, matchExportRoute, matchFetch, matchSchedule, matchServe, matchStoreAccess, matchWorker, nodeScriptArgument, scriptPath, urlText, workerEnvNames, type ImportBinding, type ScriptPath, type UrlText, type WorkerEnv } from "./effects.js";
import { workerEntries, type WorkerDeploy, type WranglerInfo } from "./deploy.js";
import { channelIndex, matchChannelRecv, matchChannelSend } from "./channels.js";
import { scriptKind } from "./digest.js";
import { emitState } from "./state.js";
import { emitData, exportedLocals } from "./data.js";
import { dispatchFor, MAX_DISPATCH_TARGETS, propName, registryFor } from "./dispatch.js";
import { workspaceManifestPaths, workspacePackages, workspaceProgramEntries, workspaceSource, type ProgramEntry, type WorkspacePackage } from "./packages.js";

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
      /**
       * Set for a module that a workspace package.json names as a program (a bin, or a script's node, tsx, ts-node or bun
       * file). Unlike other Node scripts, it is a program even when some spawn also runs it, as a server a CLI starts.
       */
      packageEntry?: true;
      /**
       * Set with packageEntry: what the package.json names the program as (a bin command, or a script), so the program can
       * be labelled by its package rather than its file.
       */
      programEntry?: ProgramEntry;
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
  /**
   * The project file a module specifier names from a file, or undefined when it names none in the project. A bare
   * specifier of a workspace package resolves to that package's source first; the compiler's own resolution is the fallback.
   */
  resolveModule(spec: string, fromAbs: string): string | undefined;
  /** Project-relative paths of every workspace package.json. A bare import's answer depends on each of them. */
  manifestRels: string[];
  /** The Worker entry files a wrangler config deploys, keyed by project-relative path (see deploy.ts). */
  workers: Map<string, WorkerDeploy>;
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

/**
 * Whether a lambda is a callback slot: a function a caller passes in, which the model drops when every candidate of a call is one.
 * A function is a callback unless it is the initializer of a property of an object literal that is not a call argument: a property of
 * a literal that is returned or stored (`return { parse: (t) => … }`) names a member, not a callback. A literal passed to a call is an
 * options bag (`run({ onProgress: () => … })`), so its properties are callback slots.
 */
function isCallbackSlot(node: ts.Node): boolean {
  const parent = node.parent;
  if (!ts.isPropertyAssignment(parent) || parent.initializer !== node || !ts.isObjectLiteralExpression(parent.parent)) return true;
  let up: ts.Node = parent.parent;
  while (
    ts.isParenthesizedExpression(up.parent) ||
    ts.isAsExpression(up.parent) ||
    ts.isSatisfiesExpression(up.parent) ||
    ts.isNonNullExpression(up.parent) ||
    ts.isTypeAssertionExpression(up.parent)
  ) {
    up = up.parent;
  }
  const call = up.parent;
  return (ts.isCallExpression(call) || ts.isNewExpression(call)) && (call.arguments ?? []).some((a) => a === up);
}

/**
 * A named function with no identifier binding of its own: a property or method of an object literal, or a method, accessor
 * or property arrow of a class. A nested declaration or a function bound to a variable is reached by its own call or value
 * edge, so it gets no closure edge from its creator. A constructor is reached by `new`.
 */
function isUnboundMember(node: ts.Node): boolean {
  if (ts.isPropertyAssignment(node)) return ts.isObjectLiteralExpression(node.parent);
  if (ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
    return ts.isObjectLiteralExpression(node.parent) || ts.isClassLike(node.parent);
  }
  if (ts.isPropertyDeclaration(node)) return ts.isClassLike(node.parent);
  return false;
}

/**
 * Whether a function's owner (its declaration, or the statement or declarator of a const) is exported. A class member is
 * exported when its class is, unless it is `private` or `#private`. A top-level declaration is exported by its own modifier
 * or by an `export { name }` list in its file.
 */
function exportedOwner(owner: ts.Node, name: string, sf: ts.SourceFile): boolean {
  if (ts.isClassElement(owner) && ts.isClassLike(owner.parent)) return classMemberExported(owner, sf);
  if ((ts.getCombinedModifierFlags(owner as ts.Declaration) & ts.ModifierFlags.Export) !== 0) return true;
  let top: ts.Node | undefined = owner.parent;
  while (top !== undefined && (ts.isVariableDeclarationList(top) || ts.isVariableStatement(top))) top = top.parent;
  return top === sf && exportedLocals(sf).has(name);
}

/** A class member is exported unless it is `private` or `#private`. A `protected` member stays exported: a subclass in another module calls it. */
function classMemberExported(member: ts.ClassElement, sf: ts.SourceFile): boolean {
  if (hasModifier(member, ts.SyntaxKind.PrivateKeyword) || (member.name !== undefined && ts.isPrivateIdentifier(member.name))) return false;
  const cls = member.parent;
  if (ts.isClassDeclaration(cls)) return exportedOwner(cls, cls.name?.text ?? "default", sf);
  // `export const Thing = class { … }`: the class takes its variable's export.
  if (ts.isClassExpression(cls) && ts.isVariableDeclaration(cls.parent) && ts.isIdentifier(cls.parent.name)) {
    return exportedOwner(cls.parent, cls.parent.name.text, sf);
  }
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
    exported: exportedOwner(owner, name, sf),
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
function assignDecls(rel: string, sf: ts.SourceFile, out: Map<ts.Node, Decl>, htmlEntry: boolean, nodeEntry: boolean, programEntry: ProgramEntry | undefined, manifestNamed = false): void {
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
      // A file a package.json names is a program even when imported: a workspace package's, with what names it, or one an
      // unnamed manifest (a private monorepo root) names, which has no package to label it by.
      ...(programEntry !== undefined ? { packageEntry: true as const, programEntry } : manifestNamed ? { packageEntry: true as const } : {}),
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

/** The compiler extension of a file name: the longest known suffix, so `a.d.ts` is `.d.ts`, not `.ts`. */
function extensionOf(file: string): ts.Extension {
  const exts = (Object.values(ts.Extension) as string[]).sort((a, b) => b.length - a.length);
  return (exts.find((e) => file.endsWith(e)) ?? ts.Extension.Ts) as ts.Extension;
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

/** A main-module guard: `require.main === module` or `import.meta.main`. */
const MAIN_GUARD = /\brequire\.main\s*===\s*module\b|\bimport\.meta\.main\b/;

/** Statements that run when the module loads, so a call or assignment among them is a script's work. */
const RUNNING_STATEMENTS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.ExpressionStatement,
  ts.SyntaxKind.IfStatement,
  ts.SyntaxKind.ForStatement,
  ts.SyntaxKind.ForInStatement,
  ts.SyntaxKind.ForOfStatement,
  ts.SyntaxKind.WhileStatement,
  ts.SyntaxKind.DoStatement,
  ts.SyntaxKind.TryStatement,
  ts.SyntaxKind.SwitchStatement,
  ts.SyntaxKind.Block,
  ts.SyntaxKind.LabeledStatement,
]);

/**
 * True when a top-level statement runs code on load: a call, `new`, `await` or assignment outside any function body.
 * Declarations, imports and exports alone do not count, so a library that only exports and builds constants is not an
 * entry. A declaration with a top-level `await` does count (`const n = await main()`): a library does not wait on load.
 */
function runsTopLevelStatement(sf: ts.SourceFile): boolean {
  const has = (node: ts.Node, hit: (n: ts.Node) => boolean): boolean => {
    if (ts.isFunctionLike(node)) return false;
    if (hit(node)) return true;
    return ts.forEachChild(node, (child) => (has(child, hit) ? true : undefined)) === true;
  };
  const runs = (n: ts.Node): boolean =>
    ts.isCallExpression(n) || ts.isNewExpression(n) || ts.isAwaitExpression(n) || (ts.isBinaryExpression(n) && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment);
  return sf.statements.some((s) => (RUNNING_STATEMENTS.has(s.kind) && has(s, runs)) || (ts.isVariableStatement(s) && has(s, ts.isAwaitExpression)));
}

/** Browser globals: a file that touches them is page code, even under a scripts/ folder. */
const DOM_GLOBAL = /\b(?:document|window|navigator|localStorage)\s*\.|\bcustomElements\.define\b/;

/** The files a package.json "bin" or "scripts" entry names directly, by project path (see manifestScripts). */
function manifestNamedFiles(manifests: Map<string, string>): Set<string> {
  const named = new Set<string>();
  for (const text of manifests.values()) for (const f of manifestScripts(text)) named.add(f);
  return named;
}

/**
 * The Node script entries: a module file, not a test, that is under a scripts/ or bin/ folder (at any depth) and either
 * has a shebang, reads process.argv, has a main-module guard, or runs code on load; or that a package.json "bin" or
 * "scripts" entry names (the root's by name, every workspace package's through its build-to-source map). `texts` is
 * keyed by absolute path; `sourceOf` gives a file's parsed source, when the program has it.
 */
function nodeEntryFiles(
  root: string,
  rels: string[],
  texts: Map<string, string>,
  manifests: Map<string, string>,
  packageEntries: ReadonlySet<string>,
  sourceOf: (rel: string) => ts.SourceFile | undefined,
): Set<string> {
  const named = manifestNamedFiles(manifests);
  // Every workspace package's bin and script targets, mapped from build output to source (see workspaceProgramEntries).
  for (const f of packageEntries) named.add(f);
  const out = new Set<string>();
  for (const rel of rels) {
    if (TEST_PATH.test(rel) || rel.endsWith(".d.ts")) continue;
    if (named.has(rel)) {
      out.add(rel);
      continue;
    }
    const folders = rel.split("/").slice(0, -1);
    if (folders.some((f) => f === "scripts" || f === "bin")) {
      const text = texts.get(join(root, rel)) ?? "";
      if (text.startsWith("#!") || /\bprocess\.argv\b/.test(text) || MAIN_GUARD.test(text)) {
        out.add(rel);
        continue;
      }
      // Code that runs on load is a Node script unless it is page code (a bundler may load a scripts/ file into a page).
      const sf = sourceOf(rel);
      if (sf !== undefined && !DOM_GLOBAL.test(text) && runsTopLevelStatement(sf)) out.add(rel);
    }
  }
  return out;
}

const SCRIPT_SRC = /<script\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi;

/**
 * The project source files an HTML page loads with a script tag. A leading slash is the page's own folder, its Vite root,
 * so an apps/web/index.html that loads /src/main.tsx loads apps/web/src/main.tsx; any other path is relative to the page.
 * A page under public/ resolves a leading slash against the folder above public/ (its app), then the project root.
 * `html` maps the page's project path to its text.
 */
function htmlScriptEntries(html: Map<string, string>, rels: Set<string>): Set<string> {
  const out = new Set<string>();
  const sourceAt = (base: string | undefined): string | undefined => (base === undefined ? undefined : candidatesAt(base).find((c) => rels.has(c)));
  for (const [page, text] of html) {
    const folder = dirOf(page);
    for (const m of text.matchAll(SCRIPT_SRC)) {
      const src = (m[1] ?? "").split(/[?#]/)[0] ?? "";
      if (src === "" || src.startsWith("//") || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(src)) continue;
      // A page under public/ is served from the folder above it (its app's Vite root), so a leading slash resolves there first,
      // and to the project root only when that file does not exist.
      const inPublic = /(^|\/)public$/.test(folder);
      const root = inPublic ? dirOf(folder) : folder;
      let hit = sourceAt(src.startsWith("/") ? joinRel(root, src.slice(1)) : joinRel(folder, src));
      if (hit === undefined && src.startsWith("/") && inPublic) hit = sourceAt(joinRel("", src.slice(1)));
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
  packageJsons: Map<string, string> = new Map(),
  wranglers: Map<string, WranglerInfo> = new Map(),
): Project {
  const options = compilerOptions(root);
  const abs = (rel: string) => join(root, rel);
  const relOf = (file: string) => relative(root, file).split(sep).join("/");
  const cache = new Map<string, ts.SourceFile>();
  const orig = ts.createCompilerHost(options, true);
  // The compiler falls back to disk for files it was not given. It may read only the project and the bundled lib files.
  const readable = confinedTo(root, dirname(ts.getDefaultLibFilePath(options)));
  const packages = workspacePackages(packageJsons);
  const manifestRels = workspaceManifestPaths(packageJsons);
  const relSet = new Set(rels);
  /** The project file a specifier names from a file: a workspace package's source first, else the compiler's answer inside the project. */
  const resolveModule = (spec: string, fromAbs: string): string | undefined => {
    const ws = workspaceSource(packages, spec, relSet);
    if (ws !== undefined) return ws;
    const resolved = ts.resolveModuleName(spec, fromAbs, options, host).resolvedModule;
    return resolved && !resolved.isExternalLibraryImport ? relative(root, resolved.resolvedFileName).split(sep).join("/") : undefined;
  };
  const host: ts.CompilerHost = {
    ...orig,
    // Answers the checker's module lookups with resolveModule, so calls and types follow a workspace import into its source.
    resolveModuleNameLiterals(literals, containingFile) {
      return literals.map((literal) => {
        const hit = workspaceSource(packages, literal.text, relSet);
        if (hit !== undefined) {
          const file = abs(hit);
          return { resolvedModule: { resolvedFileName: file, extension: extensionOf(file), isExternalLibraryImport: false } };
        }
        return ts.resolveModuleName(literal.text, containingFile, options, host);
      });
    },
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
  const htmlEntries = htmlScriptEntries(html, relSet);
  // The programs the workspace packages name, as source files. A test or declaration file is never a program.
  const packageEntries = new Map([...workspaceProgramEntries(packageJsons, relSet)].filter(([f]) => !TEST_PATH.test(f) && !f.endsWith(".d.ts")));
  const manifestNamed = manifestNamedFiles(manifests);
  const nodeEntries = nodeEntryFiles(root, rels, texts, manifests, new Set(packageEntries.keys()), (rel) => program.getSourceFile(abs(rel)));
  for (const rel of rels) {
    const sf = program.getSourceFile(abs(rel));
    if (sf) assignDecls(rel, sf, decls, htmlEntries.has(rel), nodeEntries.has(rel), packageEntries.get(rel), nodeEntries.has(rel) && manifestNamed.has(rel));
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
    resolveModule,
    manifestRels,
    workers: workerEntries(wranglers, relSet),
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

/** An assignment that may store its right side: `=`, `??=` and `||=`. */
const ASSIGNS = new Set([ts.SyntaxKind.EqualsToken, ts.SyntaxKind.QuestionQuestionEqualsToken, ts.SyntaxKind.BarBarEqualsToken]);

/**
 * The `new Worker(...)` constructors (browser Workers) an expression may hold, each once. Follows a const's initializer, a
 * `let` or `var` assigned anywhere in its scope (`=`, `??=`, `||=`), a class field assigned from anywhere in its class, the
 * sides of `?:`, `??` and `||`, and the return values of a function it calls. A parameter holds none. Each variable and field
 * is expanded once per query and depth, so a self-referencing lazy init (`w = w ?? new Worker(…)`) costs one scan of its scope.
 */
function workerCtors(project: Project, expr: ts.Expression): ts.NewExpression[] {
  const seen = new Map<unknown, number>();
  const found = new Set<ts.NewExpression>();
  walkWorkerCtors(project, expr, 0, seen, found);
  return [...found];
}

function walkWorkerCtors(project: Project, expr: ts.Expression, depth: number, seen: Map<unknown, number>, found: Set<ts.NewExpression>): void {
  if (depth > 6) return;
  const walk = (x: ts.Expression): void => walkWorkerCtors(project, x, depth + 1, seen, found);
  // Whether to expand a variable, field or function here: not when it was already expanded at this depth or nearer the top.
  const first = (k: unknown): boolean => {
    const at = seen.get(k);
    if (at !== undefined && at <= depth) return false;
    seen.set(k, depth);
    return true;
  };
  const e = unwrapAll(expr);
  if (ts.isNewExpression(e)) {
    const sf = e.getSourceFile();
    if (matchWorker(e, importBindings(sf), workerEnvFor(project, sf))?.api === "Worker") found.add(e);
    return;
  }
  // `c ? a : b`, `a ?? b` and `a || b` may hold either side's worker.
  if (ts.isConditionalExpression(e)) {
    walk(e.whenTrue);
    walk(e.whenFalse);
    return;
  }
  if (ts.isBinaryExpression(e) && (e.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken || e.operatorToken.kind === ts.SyntaxKind.BarBarToken)) {
    walk(e.left);
    walk(e.right);
    return;
  }
  if (ts.isIdentifier(e)) {
    const symbol = project.checker.getSymbolAtLocation(e);
    const d = symbol?.valueDeclaration;
    if (symbol === undefined || d === undefined || !ts.isVariableDeclaration(d) || !first(symbol)) return;
    if (d.initializer !== undefined) walk(d.initializer);
    // A `let` or `var` may be assigned after its declaration: every `name = expr`, `name ??= expr` and `name ||= expr` in the
    // declaring scope counts. A `let` is scoped to its block, a `var` to its function or file.
    const flags = ts.getCombinedNodeFlags(d);
    if ((flags & ts.NodeFlags.Const) === 0) {
      const blockScoped = (flags & ts.NodeFlags.BlockScoped) !== 0;
      let scope: ts.Node = d;
      while (scope.parent !== undefined && !(ts.isSourceFile(scope) || ts.isFunctionLike(scope) || (blockScoped && (ts.isBlock(scope) || ts.isModuleBlock(scope))))) {
        scope = scope.parent;
      }
      const scan = (n: ts.Node): void => {
        if (ts.isBinaryExpression(n) && ASSIGNS.has(n.operatorToken.kind) && ts.isIdentifier(n.left) && project.checker.getSymbolAtLocation(n.left) === symbol) walk(n.right);
        ts.forEachChild(n, scan);
      };
      scan(scope);
    }
    return;
  }
  if (ts.isPropertyAccessExpression(e) && e.expression.kind === ts.SyntaxKind.ThisKeyword) {
    const cls = enclosingClass(e);
    if (cls === undefined) return;
    const name = e.name.text;
    const key = `${cls.pos}:${cls.getSourceFile().fileName}#${name}`;
    if (!first(key)) return;
    const scan = (n: ts.Node): void => {
      if (ts.isBinaryExpression(n) && ASSIGNS.has(n.operatorToken.kind) && ts.isPropertyAccessExpression(n.left) && n.left.expression.kind === ts.SyntaxKind.ThisKeyword && n.left.name.text === name) {
        walk(n.right);
      } else if (ts.isPropertyDeclaration(n) && n.initializer !== undefined && ts.isIdentifier(n.name) && n.name.text === name) {
        walk(n.initializer);
      }
      ts.forEachChild(n, scan);
    };
    scan(cls);
    return;
  }
  if (ts.isCallExpression(e)) {
    const node = declOf(project, project.checker.getSymbolAtLocation(nameOf(e.expression)))?.node;
    if (node === undefined || !(ts.isMethodDeclaration(node) || ts.isFunctionDeclaration(node)) || node.body === undefined || !first(node)) return;
    const body = node.body;
    const scan = (n: ts.Node): void => {
      if (ts.isReturnStatement(n) && n.expression !== undefined) walk(n.expression);
      if (n !== body && ts.isFunctionLike(n)) return;
      ts.forEachChild(n, scan);
    };
    scan(body);
  }
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
  // A file a wrangler config deploys: its platform bindings and the names it takes as env (see matchStoreAccess).
  const deploy = project.workers.get(rel);
  const deployEnv = deploy !== undefined ? { bindings: deploy.bindings, names: workerEnvNames(sf) } : undefined;
  const chans = channelIndex(project.checker, sf, rel);
  const usedIds = new Set<string>();
  const uniqueId = (base: string): string => {
    let id = `${rel}@${base}`;
    for (let n = 2; usedIds.has(id); n++) id = `${rel}@${base}~${n}`;
    usedIds.add(id);
    return id;
  };
  const push = (node: IRNode) => records.push({ node });
  const pushEdge = (edge: IREdge) => records.push({ edge });
  /** The flow.branch-arm id emitted for each arm node, so state tests can name their arms. */
  const armIds = new Map<ts.Node, string>();
  /** The calls.call edge emitted for each call to a project function, so state facts can annotate it. */
  const callEdges = new Map<ts.CallExpression, IREdge>();

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

  const emitModule = (from: string, spec: string, specNode: ts.Node, typeOnly: boolean, dynamic: boolean, kind: "packaging.import" | "packaging.re-export", names?: readonly string[], aliases?: readonly string[]) => {
    const target = project.resolveModule(spec, sf.fileName);
    let to: NodeId | UnresolvedRef;
    if (target !== undefined && project.rels.has(target)) {
      to = target;
      dependOn(target);
    } else {
      to = { unresolved: { scheme: "ts.import", text: spec } };
      if (spec.startsWith(".")) {
        for (const c of importCandidates(rel, spec)) deps.add(c);
      }
    }
    // A bare specifier may name a workspace package, whose package.json decides its source. Any manifest change re-extracts.
    if (!spec.startsWith(".") && !spec.startsWith("/")) for (const m of project.manifestRels) dependOn(m);
    // A re-export records the names it passes on: the exported-from side of `export { a as b } from` (`a`), `["*"]` for `export *`.
    // `as` gives the exported name of each, by position (`b`), so a downstream name maps back to the name it came from.
    const attrs: Record<string, unknown> = kind === "packaging.import" ? { specifier: spec, typeOnly, dynamic } : { specifier: spec, names: [...(names ?? ["*"])] };
    if (kind === "packaging.re-export" && aliases !== undefined && aliases[0] !== "*") attrs.as = [...aliases];
    pushEdge({ from, to, facet: "packaging", kind, attrs, span: spanOf(rel, sf, specNode), provenance: PROV });
  };

  /**
   * The local a call's result is bound or assigned to: `cfg` for `const cfg = f()` or `cfg = f()`, and the names of a
   * destructuring. `await`, parentheses, `as`, `!` and `satisfies` are transparent. A call anywhere else (an argument,
   * a member, a return) binds no local.
   */
  const callBindIdents = (call: ts.CallExpression): ts.Identifier[] | undefined => {
    let value: ts.Expression = call;
    let p: ts.Node | undefined = value.parent;
    while (
      p !== undefined &&
      (ts.isAwaitExpression(p) || ts.isParenthesizedExpression(p) || ts.isAsExpression(p) ||
        ts.isNonNullExpression(p) || ts.isTypeAssertionExpression(p) || ts.isSatisfiesExpression(p))
    ) {
      value = p as ts.Expression;
      p = p.parent;
    }
    let ids: ts.Identifier[] | undefined;
    if (ts.isVariableDeclaration(p) && p.initializer === value) ids = bindingIdents(p.name);
    else if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.EqualsToken && p.right === value && ts.isIdentifier(p.left)) ids = [p.left];
    if (ids === undefined || ids.length === 0) return undefined;
    return ids;
  };

  /** The `binds` attribute of a call: one name as a string, several (a destructuring) as an array. */
  const callBinds = (call: ts.CallExpression): string | string[] | undefined => {
    const ids = callBindIdents(call);
    if (ids === undefined) return undefined;
    return ids.length === 1 ? localKey(ids[0]!) : ids.map((i) => localKey(i));
  };

  /** The identifiers a binding pattern declares, in source order: `a` for `a`, `a` and `b` for `{ a, b }`. */
  const bindingIdents = (name: ts.BindingName): ts.Identifier[] => {
    if (ts.isIdentifier(name)) return [name];
    return name.elements.flatMap((el) => (ts.isOmittedExpression(el) ? [] : bindingIdents(el.name)));
  };

  /** The function a declaration sits in: its nearest function-like ancestor. */
  const enclosingFunction = (d: ts.Node): ts.Node | undefined => {
    for (let p: ts.Node | undefined = d.parent; p !== undefined; p = p.parent) if (ts.isFunctionLike(p)) return p;
    return undefined;
  };
  /**
   * The function a local's name is counted in: an anonymous function (an arrow or a function expression) counts in the function it
   * sits in, so a callback's parameter or variable collides with the enclosing function's locals of the same name.
   */
  const namingRoot = (fn: ts.Node): ts.Node => {
    let cur = fn;
    while ((ts.isArrowFunction(cur) || ts.isFunctionExpression(cur)) && enclosingFunction(cur) !== undefined) cur = enclosingFunction(cur)!;
    return cur;
  };
  const localsCache = new WeakMap<ts.Node, Map<string, ts.Identifier[]>>();
  /**
   * The identifiers a function declares, by name: its parameters and its variables, and those of the anonymous functions nested in it.
   * Named nested functions are not descended into.
   */
  const localsOf = (fn: ts.Node): Map<string, ts.Identifier[]> => {
    const hit = localsCache.get(fn);
    if (hit !== undefined) return hit;
    const byName = new Map<string, ts.Identifier[]>();
    const walk = (n: ts.Node): void => {
      if (n !== fn && ts.isFunctionLike(n) && !(ts.isArrowFunction(n) || ts.isFunctionExpression(n))) return;
      if (ts.isVariableDeclaration(n) || ts.isParameter(n)) {
        for (const id of bindingIdents(n.name)) {
          const list = byName.get(id.text);
          if (list) list.push(id);
          else byName.set(id.text, [id]);
        }
      }
      ts.forEachChild(n, walk);
    };
    walk(fn);
    localsCache.set(fn, byName);
    return byName;
  };
  /**
   * The key a local is emitted under, resolved through the checker so every use of one local gives one key. A name its function
   * declares once is the bare name. A name declared more than once in one function (shadowing, or the same name in sibling
   * blocks or loops) is `name@line`: the 1-based line of the declared identifier, with `:col` (1-based) added when two of those
   * declarations share a line. The model strips the suffix for display.
   */
  const localKey = (id: ts.Identifier): string => {
    const sym = project.checker.getSymbolAtLocation(id);
    const decl = sym?.valueDeclaration ?? sym?.declarations?.[0];
    if (decl === undefined || !(ts.isVariableDeclaration(decl) || ts.isBindingElement(decl) || ts.isParameter(decl))) return id.text;
    const fn = enclosingFunction(decl);
    if (fn === undefined) return id.text;
    const same = localsOf(namingRoot(fn)).get(id.text) ?? [];
    if (same.length < 2) return id.text;
    const declId = same.find((d) => project.checker.getSymbolAtLocation(d) === sym);
    if (declId === undefined) return id.text;
    const posOf = (i: ts.Identifier) => i.getSourceFile().getLineAndCharacterOfPosition(i.getStart(i.getSourceFile()));
    const at = posOf(declId);
    const shared = same.some((d) => d !== declId && posOf(d).line === at.line);
    return shared ? `${id.text}@${at.line + 1}:${at.character + 1}` : `${id.text}@${at.line + 1}`;
  };

  /**
   * The distinct local variable names an expression reads. Locals are parameters and variables declared inside a function;
   * a module-level variable (a `data.variable`), an imported binding or a global is not one. Member names, declaration
   * names and called function names are not reads.
   */
  const localReads = (expr: ts.Node, skipFunctions = false): string[] => {
    const out = new Set<string>();
    const isLocalDecl = (d: ts.Declaration): boolean => {
      for (let p: ts.Node | undefined = d.parent; p !== undefined; p = p.parent) {
        if (ts.isSourceFile(p)) return false;
        if (ts.isFunctionLike(p)) return true;
      }
      return false;
    };
    const isName = (n: ts.Identifier, p: ts.Node): boolean =>
      (ts.isPropertyAccessExpression(p) && p.name === n) ||
      (ts.isPropertyAssignment(p) && p.name === n) ||
      (ts.isVariableDeclaration(p) && p.name === n) ||
      (ts.isBindingElement(p) && p.name === n) ||
      (ts.isParameter(p) && p.name === n) ||
      (ts.isFunctionDeclaration(p) && p.name === n) ||
      (ts.isClassDeclaration(p) && p.name === n) ||
      (ts.isInterfaceDeclaration(p) && p.name === n) ||
      (ts.isTypeAliasDeclaration(p) && p.name === n) ||
      (ts.isMethodDeclaration(p) && p.name === n) ||
      (ts.isPropertyDeclaration(p) && p.name === n) ||
      (ts.isGetAccessorDeclaration(p) && p.name === n) ||
      (ts.isSetAccessorDeclaration(p) && p.name === n) ||
      (ts.isEnumDeclaration(p) && p.name === n) ||
      (ts.isEnumMember(p) && p.name === n) ||
      (ts.isLabeledStatement(p) && p.label === n) ||
      (ts.isBreakOrContinueStatement(p) && p.label === n) ||
      (ts.isCallExpression(p) && p.expression === n) ||
      (ts.isNewExpression(p) && p.expression === n);
    const visitName = (n: ts.Node): void => {
      // A function written inside the expression is its own function, with its own locals: its reads are not this expression's.
      if (skipFunctions && ts.isFunctionLike(n)) return;
      if (ts.isIdentifier(n)) {
        if (isName(n, n.parent)) return;
        const decls = project.checker.getSymbolAtLocation(n)?.declarations;
        if (decls?.some(isLocalDecl) === true) out.add(localKey(n));
        return;
      }
      ts.forEachChild(n, visitName);
    };
    visitName(expr);
    return [...out];
  };

  /** The `reads` attribute for a condition, omitted when it names no local. */
  const readsAttr = (expr: ts.Node | undefined): { reads?: string[] } => {
    const reads = expr === undefined ? [] : localReads(expr);
    return reads.length > 0 ? { reads } : {};
  };

  /**
   * The `reads` attribute of a call: the locals its receiver and its arguments read, in first-seen order. A function written as
   * an argument (an arrow or a function expression) is its own function and is not descended into. The callee's name is not a read.
   */
  const callReadsAttr = (call: ts.CallExpression): { reads?: string[] } => {
    const callee = call.expression;
    const parts: ts.Node[] = [];
    if (ts.isPropertyAccessExpression(callee)) parts.push(callee.expression);
    else if (ts.isElementAccessExpression(callee)) parts.push(callee);
    parts.push(...call.arguments);
    const reads = [...new Set(parts.flatMap((p) => localReads(p, true)))];
    return reads.length > 0 ? { reads } : {};
  };

  /**
   * The `argReads` attribute of a call: the distinct locals each positional argument reads, one list per argument, keyed as `reads`
   * are. `argSpread` is the index of the first spread argument; that argument's reads map to every parameter from there on. Omitted
   * when no argument reads a local.
   */
  const argReadsAttr = (call: ts.CallExpression): { argReads?: string[][]; argSpread?: number } => {
    const argReads = call.arguments.map((a) => [...new Set(localReads(a, true))]);
    if (!argReads.some((r) => r.length > 0)) return {};
    const spread = call.arguments.findIndex((a) => ts.isSpreadElement(a));
    return { argReads, ...(spread >= 0 ? { argSpread: spread } : {}) };
  };

  /**
   * The checker's type text of a bound local, for `calls.call` `bindsType`: one line, at most 60 characters (the last one an
   * ellipsis). Undefined for an any, unknown or error type, which says nothing.
   */
  const boundTypeText = (id: ts.Identifier): string | undefined => {
    const type = project.checker.getTypeAtLocation(id);
    if ((type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) return undefined;
    const text = project.checker.typeToString(type).replace(/\s+/g, " ").trim();
    if (text === "" || text === "any" || text === "unknown" || text === "error") return undefined;
    return text.length > 60 ? `${text.slice(0, 59)}…` : text;
  };

  const ASSIGN_OPERATORS = new Set<ts.SyntaxKind>([
    ts.SyntaxKind.EqualsToken, ts.SyntaxKind.PlusEqualsToken, ts.SyntaxKind.MinusEqualsToken, ts.SyntaxKind.AsteriskEqualsToken,
    ts.SyntaxKind.AsteriskAsteriskEqualsToken, ts.SyntaxKind.SlashEqualsToken, ts.SyntaxKind.PercentEqualsToken,
    ts.SyntaxKind.LessThanLessThanEqualsToken, ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
    ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken, ts.SyntaxKind.AmpersandEqualsToken, ts.SyntaxKind.BarEqualsToken,
    ts.SyntaxKind.CaretEqualsToken, ts.SyntaxKind.AmpersandAmpersandEqualsToken, ts.SyntaxKind.BarBarEqualsToken,
    ts.SyntaxKind.QuestionQuestionEqualsToken,
  ]);

  /** The identifiers an assignment writes to: `a` for `a = …`, each element of an array or object pattern on the left. */
  const assignTargets = (e: ts.Expression): ts.Identifier[] => {
    if (ts.isIdentifier(e)) return [e];
    if (ts.isParenthesizedExpression(e)) return assignTargets(e.expression);
    if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.EqualsToken) return assignTargets(e.left);
    if (ts.isArrayLiteralExpression(e)) return e.elements.flatMap((el) => assignTargets(el));
    if (ts.isSpreadElement(e)) return assignTargets(e.expression);
    if (ts.isObjectLiteralExpression(e)) {
      return e.properties.flatMap((p) => {
        if (ts.isShorthandPropertyAssignment(p)) return [p.name];
        if (ts.isPropertyAssignment(p)) return assignTargets(p.initializer);
        if (ts.isSpreadAssignment(p)) return assignTargets(p.expression);
        return [];
      });
    }
    return [];
  };

  /**
   * The `derives` attribute of a function: each local variable its body declares, mapped to the distinct locals its initializer and
   * every assignment to it (`=` or compound) in this function read. A destructuring target gets the whole right side's reads.
   * Parameters have no entry, and nested functions and classes are not descended into. A loop variable (`for (const x of xs)`,
   * `for (x in o)`, destructured or not) takes the reads of its iterable. A local that reads no local is omitted. Always present on a
   * function, `{}` when none remain: the key says the data-flow facts were emitted. The declaration holding a function (a const arrow,
   * a class property arrow) is unwrapped to the function, so the attribute is on the function. Keys and values are local keys (see
   * `localKey`): a name the function declares more than once is `name@line`, so two loops' `f` are two entries.
   */
  /**
   * The function a declaration holds: a function-like node, or the arrow or function expression a const, a class property or a
   * property of an object literal holds.
   */
  const functionOf = (node: ts.Node): ts.SignatureDeclaration | undefined => {
    if ((ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node) || ts.isPropertyAssignment(node)) && node.initializer !== undefined) {
      const init = unwrapAll(node.initializer);
      return ts.isArrowFunction(init) || ts.isFunctionExpression(init) ? init : undefined;
    }
    return ts.isFunctionLike(node) ? node : undefined;
  };

  /**
   * The `params` attribute: the parameter names in order, each name a destructured parameter binds included. Always present on a
   * function, `[]` when none: a model without it was emitted by a frontend that predates the attribute.
   */
  const paramsAttr = (node: ts.Node): { params: string[] } => {
    const names = (functionOf(node)?.parameters ?? []).flatMap((p) => bindingIdents(p.name));
    return { params: names.map((id) => localKey(id)) };
  };

  const derivesAttr = (node: ts.Node): { derives: Record<string, string[]> } => {
    const body = (functionOf(node) as { body?: ts.Node } | undefined)?.body;
    if (body === undefined) return { derives: {} };
    const entries = new Map<ts.Symbol, { name: string; reads: Set<string> }>();
    const assigns: Array<{ targets: ts.Identifier[]; value: ts.Expression }> = [];
    /** A declared local: its entry is created once, and each read it gets is added. */
    const declare = (id: ts.Identifier, reads: Iterable<string>): void => {
      const sym = project.checker.getSymbolAtLocation(id);
      if (sym === undefined) return;
      let e = entries.get(sym);
      if (e === undefined) {
        e = { name: localKey(id), reads: new Set() };
        entries.set(sym, e);
      }
      for (const r of reads) e.reads.add(r);
    };
    const walk = (n: ts.Node): void => {
      if (ts.isFunctionLike(n) || ts.isClassLike(n)) return;
      if (ts.isVariableDeclaration(n)) {
        const reads = n.initializer !== undefined ? localReads(n.initializer, true) : [];
        for (const id of bindingIdents(n.name)) declare(id, reads);
      } else if (ts.isForOfStatement(n) || ts.isForInStatement(n)) {
        // A loop variable takes the reads of the iterable it walks: a declared one here, or an assigned one (an expression) below.
        const reads = localReads(n.expression, true);
        if (ts.isVariableDeclarationList(n.initializer)) {
          for (const d of n.initializer.declarations) for (const id of bindingIdents(d.name)) declare(id, reads);
        } else {
          assigns.push({ targets: assignTargets(n.initializer), value: n.expression });
        }
      } else if (ts.isBinaryExpression(n) && ASSIGN_OPERATORS.has(n.operatorToken.kind)) {
        assigns.push({ targets: assignTargets(n.left), value: n.right });
      }
      ts.forEachChild(n, walk);
    };
    walk(body);
    for (const a of assigns) {
      const reads = localReads(a.value, true);
      for (const id of a.targets) {
        const sym = project.checker.getSymbolAtLocation(id);
        const e = sym === undefined ? undefined : entries.get(sym);
        if (e !== undefined) for (const r of reads) e.reads.add(r);
      }
    }
    const derives: Record<string, string[]> = {};
    for (const e of entries.values()) {
      if (e.reads.size === 0) continue;
      derives[e.name] = [...new Set([...(derives[e.name] ?? []), ...e.reads])];
    }
    return { derives };
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
            ...(decl.entity.anonymous ? { anonymous: true, callbackSlot: isCallbackSlot(node) } : {}),
            ...(decl.entity.module ? { module: true } : {}),
            ...(decl.entity.htmlEntry ? { htmlEntry: true } : {}),
            ...(decl.entity.nodeEntry ? { nodeEntry: true } : {}),
            ...(decl.entity.packageEntry ? { packageEntry: true } : {}),
            ...(decl.entity.programEntry !== undefined ? { programEntry: decl.entity.programEntry } : {}),
            ...derivesAttr(node),
            ...paramsAttr(node),
          },
          span,
          provenance: PROV,
        });
        // A lambda, or a named member made inside a function (a property or method of a literal, a method of a local class).
        // `fn` is the file or its module entry at top level, so top-level declarations get no edge. A nested declaration or a
        // function bound to a variable is not a member, so it gets none: its own call or value edge reaches it.
        const madeInFunction = fn !== rel && fn !== moduleId;
        if (decl.entity.anonymous || (madeInFunction && isUnboundMember(node))) {
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
      // The local the call's result goes into, if any: `cfg ← loadConfig()`.
      const binds = callBinds(call);
      // The call's data facts: the locals its receiver and arguments read, and the type of the one local its result is bound to.
      const bindIds = callBindIdents(call);
      const bindsType = bindIds?.length === 1 ? boundTypeText(bindIds[0]!) : undefined;
      const dataAttrs = { ...callReadsAttr(call), ...argReadsAttr(call), ...(bindsType !== undefined ? { bindsType } : {}) };
      const sym = project.checker.getSymbolAtLocation(nameOf(callee));
      const target = declOf(project, sym);
      // A call through a fixed registry runs whichever of its functions the key picks, so every one is a candidate. The registry
      // is asked only when the checker names no single function: no function target, or a member symbol of several
      // declarations (a union of the registry's literals, whose first declaration is only one of them). A call the checker
      // resolves directly keeps its direct edge. A registry key fixed to one entry is a direct call to that entry.
      const direct = target?.entity.type === "function" ? target : undefined;
      const ambiguous = direct === undefined || (sym?.declarations?.length ?? 0) >= 2;
      const registry = ambiguous ? registryFor(project, call, dependOn) : undefined;
      const callTarget = registry === undefined ? direct : registry.exact ? registry.targets[0] : undefined;
      if (callTarget !== undefined) {
        const callEdge: IREdge = {
          from: fn,
          to: callTarget.id,
          facet: "calls",
          kind: "calls.call",
          attrs: { callee: callee.getText(sf).slice(0, 200), callEnd: pos(sf, call.getEnd()), ...(binds !== undefined ? { binds } : {}), ...dataAttrs },
          span: spanOf(rel, sf, callee),
          provenance: PROV,
        };
        callEdges.set(call, callEdge);
        pushEdge(callEdge);
        dependOn(callTarget.rel);
      } else if (registry !== undefined) {
        const kept = registry.targets.slice(0, MAX_DISPATCH_TARGETS).map((t) => t.id);
        const [first, ...rest] = kept as [NodeId, ...NodeId[]];
        const truncated = registry.targets.length > MAX_DISPATCH_TARGETS;
        pushEdge({
          from: fn,
          to: { candidates: [first, ...rest] },
          facet: "calls",
          kind: "calls.call",
          attrs: { callee: callee.getText(sf).slice(0, 200), how: "registry", callEnd: pos(sf, call.getEnd()), ...(binds !== undefined ? { binds } : {}), ...dataAttrs, ...(truncated ? { truncated: true } : {}) },
          span: spanOf(rel, sf, callee),
          provenance: { frontend: FRONTEND_ID, confidence: "heuristic" },
        });
        for (const t of registry.targets) dependOn(t.rel);
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
            attrs: { callee: callee.getText(sf).slice(0, 200), how: "interface", callEnd: pos(sf, call.getEnd()), ...(binds !== undefined ? { binds } : {}), ...dataAttrs, ...(truncated ? { truncated: true } : {}) },
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
      // A message on a BroadcastChannel or MessagePort is a send on that channel, not a message to a Worker's inbox.
      const send = matchChannelSend(call, project.checker, chans);
      if (send) {
        push({
          id: uniqueId(`chan:${pos(sf, call.getStart(sf)).join(":")}`),
          facet: "concurrency",
          kind: "concurrency.channel-send",
          parent: owner,
          attrs: { channel: send.channel, api: send.api },
          span: spanOf(rel, sf, call),
          provenance: PROV,
        });
      }
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
      // A call on a platform binding the Worker's wrangler config declares: env.INDEX.get(…) reads that store.
      const store = deployEnv !== undefined ? matchStoreAccess(call, deployEnv.bindings, deployEnv.names) : undefined;
      if (store) {
        push({
          id: uniqueId(`store:${pos(sf, call.getStart(sf)).join(":")}`),
          facet: "effects",
          kind: store.kind,
          parent: owner,
          attrs: store.attrs,
          span: spanOf(rel, sf, call),
          provenance: PROV,
        });
      }
      // A message a worker or page posts to its peer: a step of its own, since the runtime has no call the project declares.
      if (!effect && !send && target === undefined && ts.isPropertyAccessExpression(callee) && callee.name.text === "postMessage") {
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
      if (!effect && callTarget !== undefined) {
        const fn = fnNodeOf(callTarget.node);
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
            const attrs = { ...m.attrs, via: callTarget.entity.name };
            push({
              id: uniqueId(`effect:${pos(sf, call.getStart(sf)).join(":")}`),
              facet: "effects",
              kind: m.kind,
              parent: owner,
              attrs,
              span: spanOf(rel, sf, call),
              provenance: PROV,
            });
            dependOn(callTarget.rel);
          }
        }
      }
      if (effect) {
        push({
          id: uniqueId(`effect:${pos(sf, call.getStart(sf)).join(":")}`),
          // The facet is the kind's first segment: effects for OS and I/O, sync for locks and atomics.
          facet: effect.kind.slice(0, effect.kind.indexOf(".")),
          kind: effect.kind,
          parent: owner,
          // A bound result (`const cfg = readConfigSync()`) carries where it goes, as a calls.call row does.
          attrs: { ...effect.attrs, ...(binds !== undefined ? { binds } : {}) },
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

    const flow = (tag: string, kind: string, attrs: Record<string, unknown>, at: ts.Node = node): string => {
      const id = uniqueId(`${tag}:${pos(sf, at.getStart(sf)).join(":")}`);
      push({ id, facet: "flow", kind, parent: owner, attrs, span: spanOf(rel, sf, at), provenance: PROV });
      return id;
    };
    const arm = (label: string, at: ts.Node) => {
      armIds.set(at, flow("arm", "flow.branch-arm", { label }, at));
    };
    const block = (label: string, at: ts.Node) => flow("block", "flow.block", { label }, at);

    if (ts.isIfStatement(node)) {
      flow("if", "flow.branch", { condition: node.expression.getText(sf).slice(0, 200), ...readsAttr(node.expression) });
      arm("then", node.thenStatement);
      if (node.elseStatement) arm("else", node.elseStatement);
    } else if (ts.isConditionalExpression(node)) {
      flow("cond", "flow.branch", { condition: node.condition.getText(sf).slice(0, 200), ...readsAttr(node.condition) });
      arm("then", node.whenTrue);
      arm("else", node.whenFalse);
    } else if (ts.isSwitchStatement(node)) {
      flow("switch", "flow.switch", { hasDefault: node.caseBlock.clauses.some((c) => ts.isDefaultClause(c)) });
      for (const clause of node.caseBlock.clauses) {
        arm(ts.isDefaultClause(clause) ? "default" : `case ${clause.expression.getText(sf).slice(0, 60)}`, clause);
      }
    } else if (ts.isForStatement(node)) {
      flow("loop", "flow.loop", { variant: "for", condition: node.condition?.getText(sf).slice(0, 200) ?? "", ...readsAttr(node.condition) });
      block("body", node.statement);
    } else if (ts.isForOfStatement(node)) {
      // The iterable is what the loop reads; the loop variable is declared, not read.
      flow("loop", "flow.loop", { variant: "for-of", condition: `${node.initializer.getText(sf)} of ${node.expression.getText(sf)}`.slice(0, 200), ...readsAttr(node.expression) });
      block("body", node.statement);
    } else if (ts.isForInStatement(node)) {
      flow("loop", "flow.loop", { variant: "for-in", condition: `${node.initializer.getText(sf)} in ${node.expression.getText(sf)}`.slice(0, 200), ...readsAttr(node.expression) });
      block("body", node.statement);
    } else if (ts.isWhileStatement(node)) {
      flow("loop", "flow.loop", { variant: "while", condition: node.expression.getText(sf).slice(0, 200), ...readsAttr(node.expression) });
      block("body", node.statement);
    } else if (ts.isDoStatement(node)) {
      flow("loop", "flow.loop", { variant: "do", condition: node.expression.getText(sf).slice(0, 200), ...readsAttr(node.expression) });
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
      // A new EventSource(url) is a server-sent events stream the page opens: a GET that connects to the URL.
      const stream = matchEventSource(node, imports, workerEnv);
      if (stream) {
        push({
          id: uniqueId(`effect:${pos(sf, node.getStart(sf)).join(":")}`),
          facet: "effects",
          kind: stream.kind,
          parent: owner,
          attrs: stream.attrs,
          span: spanOf(rel, sf, node),
          provenance: PROV,
        });
      }
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
    // A receive on a BroadcastChannel or MessagePort: an onmessage assignment or a "message" listener on one.
    const recv = matchChannelRecv(node, project.checker, chans);
    if (recv) {
      push({
        id: uniqueId(`chanrecv:${pos(sf, node.getStart(sf)).join(":")}`),
        facet: "concurrency",
        kind: "concurrency.channel-recv",
        parent: owner,
        attrs: { channel: recv.channel, api: recv.api },
        span: spanOf(rel, sf, node),
        provenance: PROV,
      });
    }
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      emitModule(rel, node.moduleSpecifier.text, node.moduleSpecifier, node.importClause?.isTypeOnly ?? false, false, "packaging.import");
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.exportClause;
      const elements = clause && ts.isNamedExports(clause) ? clause.elements : undefined;
      const names = elements ? elements.map((e) => (e.propertyName ?? e.name).text) : ["*"];
      const aliases = elements ? elements.map((e) => e.name.text) : ["*"];
      emitModule(rel, node.moduleSpecifier.text, node.moduleSpecifier, false, false, "packaging.re-export", names, aliases);
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
        // A Worker a wrangler config deploys runs on Cloudflare, under that config's name.
        const attrs = serve.attrs.framework === "worker" && deploy !== undefined
          ? { ...serve.attrs, platform: "cloudflare", ...(deploy.name !== undefined ? { name: deploy.name } : {}) }
          : serve.attrs;
        push({
          id: uniqueId(`serve:${pos(sf, node.getStart(sf)).join(":")}`),
          facet: "effects",
          kind: serve.kind,
          parent: owner,
          attrs,
          span: spanOf(rel, sf, node),
          provenance: PROV,
        });
      }
    }
    // A route table a file dispatches on by path: one served route per key (see matchDispatchTable).
    if (ts.isVariableStatement(node)) {
      matchDispatchTable(node, sf).forEach((serve, i) => {
        push({
          id: uniqueId(`serve:${pos(sf, node.getStart(sf)).join(":")}:${i}`),
          facet: "effects",
          kind: serve.kind,
          parent: owner,
          attrs: serve.attrs,
          span: spanOf(rel, sf, node),
          provenance: PROV,
        });
      });
    }

    ts.forEachChild(node, (child) => {
      visit(child, nextContainer, nextFn);
    });
  };
  visit(sf, rel, rel);

  // State facts need the arm ids and call edges the walk above produced, so they run after it.
  if (!sf.isDeclarationFile) {
    const state = emitState({
      project,
      rel,
      sf,
      moduleId,
      pos: (offset) => pos(sf, offset),
      spanOf: (n) => spanOf(rel, sf, n),
      declOf: (sym) => declOf(project, sym),
      uniqueId,
      armId: (n) => armIds.get(n),
      provenance: PROV,
    });
    for (const n of state.nodes) push(n);
    for (const [call, attrs] of state.callAttrs) {
      const edge = callEdges.get(call);
      if (edge) edge.attrs = { ...edge.attrs, ...attrs };
    }
    const data = emitData({
      project,
      rel,
      sf,
      moduleId,
      spanOf: (n) => spanOf(rel, sf, n),
      spanIn: (file, n) => spanOf(file, project.sourceFor(file) ?? sf, n),
      provenance: PROV,
      dependOn,
    });
    for (const n of data.nodes) push(n);
    for (const e of data.edges) pushEdge(e);
  }

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

