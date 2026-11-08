import { readFileSync } from "node:fs";
import ts from "typescript";

interface CatalogEntry {
  module: string;
  name: string;
  kind: string;
  api: string;
  attr?: string;
  arg?: number;
}

const catalog = JSON.parse(readFileSync(new URL("../data/effects.json", import.meta.url), "utf8")) as {
  entries: CatalogEntry[];
};

const byKey = new Map(catalog.entries.map((e) => [`${normalizeModule(e.module)}\0${e.name}`, e]));

export function normalizeModule(name: string): string {
  return name.startsWith("node:") ? name.slice(5) : name;
}

export interface ImportBinding {
  module: string;
  /** Set for a named import: the exported name. Unset for a namespace or default import. */
  name?: string;
}

/** Local names bound by import declarations at the top of a file. */
export function importBindings(sf: ts.SourceFile): Map<string, ImportBinding> {
  const out = new Map<string, ImportBinding>();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    const module = normalizeModule(st.moduleSpecifier.text);
    const clause = st.importClause;
    if (!clause) continue;
    if (clause.name) out.set(clause.name.text, { module });
    const named = clause.namedBindings;
    if (named && ts.isNamespaceImport(named)) out.set(named.name.text, { module });
    if (named && ts.isNamedImports(named)) {
      for (const el of named.elements) {
        out.set(el.name.text, { module, name: (el.propertyName ?? el.name).text });
      }
    }
  }
  return out;
}

export interface EffectMatch {
  kind: string;
  attrs: Record<string, unknown>;
}

const DYNAMIC = "<dynamic>";

function argValue(call: ts.CallExpression, index: number): string {
  if (index < 0) return DYNAMIC;
  const arg = call.arguments[index];
  return arg && ts.isStringLiteralLike(arg) ? arg.text : DYNAMIC;
}

/** Matches a call against the effects catalog, using the file's import bindings. */
export function matchCall(call: ts.CallExpression, imports: Map<string, ImportBinding>): EffectMatch | undefined {
  const callee = call.expression;
  let module: string | undefined;
  let name: string | undefined;
  if (ts.isIdentifier(callee)) {
    const b = imports.get(callee.text);
    if (b?.name !== undefined) {
      module = b.module;
      name = b.name;
    }
  } else if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
    const base = callee.expression.text;
    const b = imports.get(base);
    if (b && b.name === undefined) {
      module = b.module;
      name = callee.name.text;
    } else if (!b) {
      module = "";
      name = `${base}.${callee.name.text}`;
    }
  }
  if (module === undefined || name === undefined) return undefined;
  const entry = byKey.get(`${module}\0${name}`);
  if (!entry) return undefined;
  const attrs: Record<string, unknown> = { api: entry.api };
  if (entry.attr) attrs[entry.attr] = argValue(call, entry.arg ?? 0);
  return { kind: entry.kind, attrs };
}

/** process.env.NAME, read as a property access. Returns the name, or undefined. */
export function matchEnvRead(node: ts.PropertyAccessExpression, imports: Map<string, ImportBinding>): string | undefined {
  const inner = node.expression;
  if (!ts.isPropertyAccessExpression(inner) || inner.name.text !== "env") return undefined;
  if (!ts.isIdentifier(inner.expression) || inner.expression.text !== "process") return undefined;
  if (imports.has("process")) return undefined;
  return node.name.text;
}

/**
 * A script a spawn runs, named by a relative path. A `file` path is relative to the file that makes the call, which is
 * what `new URL(p, import.meta.url)` and `join(__dirname, p)` mean. A `cwd` path is a plain literal, which the runtime
 * resolves against the working directory.
 */
export interface ScriptPath {
  base: "file" | "cwd";
  /** A relative path such as `./w.js` or `../w.js`. Never absolute, and never a URL with a scheme. */
  path: string;
}

export interface WorkerMatch {
  api: string;
  /** The spawn node's target, as it has always been: the literal path, or <dynamic>. */
  target: string;
  /** The script the worker runs, when the call names one statically and relatively. */
  script?: ScriptPath;
}

const isImportMetaUrl = (e: ts.Expression): boolean =>
  ts.isPropertyAccessExpression(e) &&
  e.name.text === "url" &&
  ts.isMetaProperty(e.expression) &&
  e.expression.keywordToken === ts.SyntaxKind.ImportKeyword;

/** A path with no leading slash and no URL scheme: relative to some base. */
const isRelativePath = (p: string): boolean => p !== "" && !p.startsWith("/") && !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(p);

/** `__dirname`, or `import.meta.dirname`: the directory of the file that holds the call. */
function isDirArg(e: ts.Expression, imports: Map<string, ImportBinding>): boolean {
  if (ts.isIdentifier(e)) return e.text === "__dirname" && !imports.has("__dirname");
  return (
    ts.isPropertyAccessExpression(e) &&
    e.name.text === "dirname" &&
    ts.isMetaProperty(e.expression) &&
    e.expression.keywordToken === ts.SyntaxKind.ImportKeyword
  );
}

/** The export a callee names, when that export comes from one of `modules`: a named import, or a member of a namespace or default import. */
function exportName(callee: ts.Expression, imports: Map<string, ImportBinding>, modules: string[]): string | undefined {
  if (ts.isIdentifier(callee)) {
    const b = imports.get(callee.text);
    if (b && b.name !== undefined && modules.includes(b.module)) return b.name;
    return undefined;
  }
  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
    const b = imports.get(callee.expression.text);
    if (b && b.name === undefined && modules.includes(b.module)) return callee.name.text;
  }
  return undefined;
}

/**
 * The file-relative path an expression names: `new URL(p, import.meta.url)`, `fileURLToPath` of one,
 * `join` or `resolve` of `__dirname` with literal segments, or a template of `__dirname` and a literal tail.
 */
function fileRelativePath(e: ts.Expression, imports: Map<string, ImportBinding>): string | undefined {
  if (ts.isNewExpression(e)) {
    if (!ts.isIdentifier(e.expression) || e.expression.text !== "URL") return undefined;
    const [path, base] = e.arguments ?? [];
    return path && base && ts.isStringLiteralLike(path) && isImportMetaUrl(base) && isRelativePath(path.text)
      ? path.text
      : undefined;
  }
  if (ts.isTemplateExpression(e)) {
    const span = e.templateSpans[0];
    if (e.head.text === "" && e.templateSpans.length === 1 && span && isDirArg(span.expression, imports) && span.literal.text.startsWith("/")) {
      return `.${span.literal.text}`;
    }
    return undefined;
  }
  if (!ts.isCallExpression(e)) return undefined;
  if (exportName(e.expression, imports, ["url"]) === "fileURLToPath") {
    const [only] = e.arguments;
    return e.arguments.length === 1 && only ? fileRelativePath(only, imports) : undefined;
  }
  const fn = exportName(e.expression, imports, ["path"]);
  const [dir, ...rest] = e.arguments;
  if ((fn !== "join" && fn !== "resolve") || !dir || !isDirArg(dir, imports) || rest.length === 0) return undefined;
  const segments = rest.map((a) => (ts.isStringLiteralLike(a) ? a.text : undefined));
  if (!segments.every((s): s is string => s !== undefined && isRelativePath(s))) return undefined;
  return [".", ...segments].join("/");
}

/**
 * The script a spawn argument names, when it names one statically. A plain relative literal is cwd-relative;
 * the forms `fileRelativePath` accepts are file-relative. A variable, an absolute path or a URL with another base names none.
 */
export function scriptPath(arg: ts.Expression | undefined, imports: Map<string, ImportBinding>): ScriptPath | undefined {
  if (!arg) return undefined;
  if (ts.isStringLiteralLike(arg)) return isRelativePath(arg.text) ? { base: "cwd", path: arg.text } : undefined;
  const path = fileRelativePath(arg, imports);
  return path === undefined ? undefined : { base: "file", path };
}

/** `new Worker(file)` from worker_threads, as a named or namespace import. Returns the script it runs. */
export function matchWorker(node: ts.NewExpression, imports: Map<string, ImportBinding>): WorkerMatch | undefined {
  const callee = node.expression;
  let isWorker = false;
  if (ts.isIdentifier(callee)) {
    const b = imports.get(callee.text);
    isWorker = b !== undefined && b.module === "worker_threads" && b.name === "Worker";
  } else if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.name.text === "Worker") {
    const b = imports.get(callee.expression.text);
    isWorker = b !== undefined && b.module === "worker_threads" && b.name === undefined;
  }
  if (!isWorker) return undefined;
  const first = node.arguments?.[0];
  return {
    api: "worker_threads.Worker",
    target: first && ts.isStringLiteralLike(first) ? first.text : DYNAMIC,
    script: scriptPath(first, imports),
  };
}

/** A call that hands a callback to the runtime to run later. `callbacks` lists the argument positions that may hold one. */
export interface ScheduleMatch {
  how: "timer" | "microtask" | "callback";
  callbacks: number[];
}

const TIMER_GLOBALS = new Set(["setTimeout", "setInterval", "setImmediate"]);

/**
 * Matches a call that schedules a callback: the timer and microtask globals, `process.nextTick`, and the
 * Promise methods `then`, `catch` and `finally`. A name the file imports is not the global, so it does not match.
 */
export function matchSchedule(call: ts.CallExpression, imports: Map<string, ImportBinding>): ScheduleMatch | undefined {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) {
    if (imports.has(callee.text)) return undefined;
    if (TIMER_GLOBALS.has(callee.text)) return { how: "timer", callbacks: [0] };
    if (callee.text === "queueMicrotask") return { how: "microtask", callbacks: [0] };
    return undefined;
  }
  if (!ts.isPropertyAccessExpression(callee)) return undefined;
  const name = callee.name.text;
  // then takes onFulfilled and onRejected; catch and finally take one callback.
  if (name === "then") return { how: "callback", callbacks: [0, 1] };
  if (name === "catch" || name === "finally") return { how: "callback", callbacks: [0] };
  if (name === "nextTick" && ts.isIdentifier(callee.expression) && callee.expression.text === "process" && !imports.has("process")) {
    return { how: "microtask", callbacks: [0] };
  }
  return undefined;
}
