import { existsSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import ts from "typescript";
import type { IREdge, IRFinding, IRNode, IRRecord, NodeId, Provenance, Span, UnresolvedRef } from "@insight/ir";
import type { IRBatch } from "@insight/sdk";
import { importBindings, matchCall, matchEnvRead, matchSchedule, matchWorker, scriptPath, type ImportBinding, type ScriptPath } from "./effects.js";
import { scriptKind } from "./digest.js";

export const FRONTEND_ID = "frontend-typescript";
export const SOURCE_RE = /\.(?:[mc]?[jt]sx?)$/;
const PROV: Provenance = { frontend: FRONTEND_ID, confidence: "exact" };
type Confidence = Provenance["confidence"];

type Entity =
  | { type: "type"; name: string; typeKind: "class" | "interface" | "enum" | "alias" }
  | { type: "function"; name: string; async: boolean; generator: boolean; exported: boolean; anonymous: boolean };

interface Decl {
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
  sourceFor(rel: string): ts.SourceFile | undefined;
  /** Maps a path under the compiler's output directory to the same path under its source directory. Undefined for other paths. */
  mapOutput(rel: string): string | undefined;
}

const propName = (name: ts.PropertyName): string => name.getText();
const isFnInit = (n: ts.Expression): boolean => ts.isArrowFunction(n) || ts.isFunctionExpression(n);
const hasModifier = (node: ts.Node, kind: ts.SyntaxKind): boolean =>
  ts.canHaveModifiers(node) && (ts.getModifiers(node)?.some((m) => m.kind === kind) ?? false);

/** A function expression that its parent declaration names: the variable or class property it initializes. */
function namedByParent(node: ts.ArrowFunction | ts.FunctionExpression): boolean {
  const parent = node.parent;
  if (ts.isVariableDeclaration(parent)) return parent.initializer === node && ts.isIdentifier(parent.name);
  if (ts.isPropertyDeclaration(parent)) return parent.initializer === node;
  return false;
}

/** Decides whether a node becomes a structure node. Shared by the declaration pass and the emit pass. */
function classify(node: ts.Node, sf: ts.SourceFile): Entity | undefined {
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
  // A function expression that no declaration names is a lambda. It is named by where it starts, 1-based like an editor.
  if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && !namedByParent(node)) {
    const at = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    return fn(`λ${at.line + 1}:${at.character + 1}`, node, node, true);
  }
  return undefined;
}

/** Assigns IDs to every declaration in a file: <file>#<qualified name>, with ~N for repeats. */
function assignDecls(rel: string, sf: ts.SourceFile, out: Map<ts.Node, Decl>): void {
  const counts = new Map<string, number>();
  const visit = (node: ts.Node, container: { qname: string } | undefined): void => {
    let next = container;
    const entity = classify(node, sf);
    if (entity) {
      const qname = container ? `${container.qname}.${entity.name}` : entity.name;
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

/**
 * Parses every project source file into one program, so calls and imports resolve across files.
 * `texts` maps absolute paths to contents. Files are read once per extraction run.
 */
export function buildProject(root: string, rels: string[], texts: Map<string, string>): Project {
  const options = compilerOptions(root);
  const abs = (rel: string) => join(root, rel);
  const relOf = (file: string) => relative(root, file).split(sep).join("/");
  const cache = new Map<string, ts.SourceFile>();
  const orig = ts.createCompilerHost(options, true);
  const host: ts.CompilerHost = {
    ...orig,
    getSourceFile(name, language, onError, shouldCreate) {
      const text = texts.get(name);
      if (text === undefined) return orig.getSourceFile(name, language, onError, shouldCreate);
      let sf = cache.get(name);
      if (!sf) {
        sf = createSource(name, relOf(name), text);
        cache.set(name, sf);
      }
      return sf;
    },
    fileExists: (f) => texts.has(f) || orig.fileExists(f),
    readFile: (f) => texts.get(f) ?? orig.readFile(f),
  };
  const roots = rels.map(abs);
  const program = ts.createProgram({ rootNames: roots, options, host });
  const checker = program.getTypeChecker();
  const decls = new Map<ts.Node, Decl>();
  for (const rel of rels) {
    const sf = program.getSourceFile(abs(rel));
    if (sf) assignDecls(rel, sf, decls);
  }
  return {
    root,
    rels: new Set(rels),
    program,
    checker,
    options,
    host,
    decls,
    sourceFor: (rel) => program.getSourceFile(abs(rel)),
    mapOutput: outputMapper(root, options, rels),
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
  // Every candidate is recorded, so that creating any of them re-extracts the file. The first hit in order wins.
  for (const group of [...plain, ...mapped]) tried.push(...group.names);
  for (const group of [...plain, ...mapped]) {
    const hit = group.names.find((name) => project.rels.has(name));
    if (hit !== undefined) return { to: hit, confidence: group.confidence, tried };
  }
  return { tried };
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
  return declNode ? project.decls.get(declNode) : undefined;
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
type Dispatch = "await" | "start" | "callback" | "timer" | "microtask";

/** Compiled output names its source, which TypeScript resolves to: `./w.js` is `w.ts` in the project. */
const SOURCE_FOR_OUTPUT: [string, string][] = [
  [".js", ".ts"],
  [".jsx", ".tsx"],
  [".mjs", ".mts"],
  [".cjs", ".cts"],
];

/** Records and dependencies for one file. */
export function emitFile(project: Project, rel: string): IRBatch {
  const sf = project.sourceFor(rel);
  if (!sf) return { file: rel, records: [] };
  const records: IRRecord[] = [];
  const deps = new Set<string>();
  const imports = importBindings(sf);
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
    const decl = project.decls.get(node);
    if (decl && decl.rel === rel) {
      const span = spanOf(rel, sf, node);
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
          parent: container,
          attrs: {
            name: decl.entity.name,
            qualifiedName: decl.qname,
            async: decl.entity.async,
            exported: decl.entity.exported,
            ...(decl.entity.anonymous ? { anonymous: true } : {}),
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
      nextContainer = decl.id;
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

    /** The project function a callback names: an inline function, or an identifier or property reference to one. */
    const callbackTarget = (arg: ts.Expression | undefined): Decl | undefined => {
      if (!arg) return undefined;
      const e = unwrap(arg);
      if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) {
        const inline = project.decls.get(e);
        return inline?.entity.type === "function" ? inline : undefined;
      }
      if (!(ts.isIdentifier(e) || ts.isPropertyAccessExpression(e))) return undefined;
      const target = declOf(project, project.checker.getSymbolAtLocation(nameOf(e)));
      return target?.entity.type === "function" ? target : undefined;
    };

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

    const emitCall = (call: ts.CallExpression) => {
      const callee = call.expression;
      const target = declOf(project, project.checker.getSymbolAtLocation(nameOf(callee)));
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
      }
      const effect = matchCall(call, imports);
      if (effect) {
        push({
          id: uniqueId(`effect:${pos(sf, call.getStart(sf)).join(":")}`),
          facet: "effects",
          kind: effect.kind,
          parent: container,
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
            parent: container,
            attrs: { target: effect.attrs.command, api: effect.attrs.api },
            span: spanOf(rel, sf, call),
            provenance: PROV,
          });
          // fork runs a script rather than a command, so a project file it names is the code the process runs.
          const forked = effect.attrs.api === "child_process.fork" ? scriptTarget(scriptPath(call.arguments[0], imports)) : undefined;
          if (forked !== undefined) {
            pushEdge({ from: spawnId, to: forked.to, facet: "concurrency", kind: "concurrency.spawns", attrs: { how: "process" }, span: spanOf(rel, sf, call), provenance: { frontend: FRONTEND_ID, confidence: forked.confidence } });
          }
        }
      }
    };

    const flow = (tag: string, kind: string, attrs: Record<string, unknown>, at: ts.Node = node) =>
      push({
        id: uniqueId(`${tag}:${pos(sf, at.getStart(sf)).join(":")}`),
        facet: "flow",
        kind,
        parent: container,
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
        parent: container,
        attrs: {},
        span: spanOf(rel, sf, node),
        provenance: PROV,
      });
    }

    if (ts.isNewExpression(node)) {
      const worker = matchWorker(node, imports);
      if (worker !== undefined) {
        const spawnId = uniqueId(`spawn:${pos(sf, node.getStart(sf)).join(":")}`);
        push({
          id: spawnId,
          facet: "concurrency",
          kind: "concurrency.spawn-thread",
          parent: container,
          attrs: { target: worker.target, api: worker.api },
          span: spanOf(rel, sf, node),
          provenance: PROV,
        });
        const script = scriptTarget(worker.script);
        if (script !== undefined) {
          pushEdge({ from: spawnId, to: script.to, facet: "concurrency", kind: "concurrency.spawns", attrs: { how: "thread" }, span: spanOf(rel, sf, node), provenance: { frontend: FRONTEND_ID, confidence: script.confidence } });
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
    } else if (ts.isPropertyAccessExpression(node)) {
      const name = matchEnvRead(node, imports);
      if (name !== undefined) {
        push({
          id: uniqueId(`env:${pos(sf, node.getStart(sf)).join(":")}`),
          facet: "effects",
          kind: "effects.env.read",
          parent: container,
          attrs: { api: "process.env", name },
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

