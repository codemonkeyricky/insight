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

/** How many same-file consts a path may be followed through before the search gives up. */
const MAX_CONST_HOPS = 8;

/** `fileURLToPath(import.meta.url)`: the path of the file that holds the call. */
function isFileUrlOfMeta(e: ts.Expression, imports: Map<string, ImportBinding>): boolean {
  if (!ts.isCallExpression(e) || exportName(e.expression, imports, ["url"]) !== "fileURLToPath") return false;
  return e.arguments.length === 1 && e.arguments[0] !== undefined && isImportMetaUrl(e.arguments[0]);
}

/**
 * The file-relative path an expression names: `new URL(p, import.meta.url)`, `fileURLToPath` of one,
 * `join` or `resolve` of `__dirname` (or `dirname(fileURLToPath(import.meta.url))`) with literal segments, or a template
 * of `__dirname` and a literal tail. An identifier is followed to the same-file `const` it names, and a join or resolve
 * may start from such a path, so `join(REPO_ROOT, "apps")` works when `REPO_ROOT` is a file-relative path too.
 */
function fileRelativePath(e: ts.Expression, imports: Map<string, ImportBinding>, env: WorkerEnv = {}, hops = 0): string | undefined {
  if (hops > MAX_CONST_HOPS) return undefined;
  if (ts.isIdentifier(e)) {
    const init = env.constOf?.(e);
    return init === undefined ? undefined : fileRelativePath(init, imports, env, hops + 1);
  }
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
    return e.arguments.length === 1 && only ? fileRelativePath(only, imports, env, hops + 1) : undefined;
  }
  const fn = exportName(e.expression, imports, ["path"]);
  const [first, ...rest] = e.arguments;
  if (fn === "dirname") return first !== undefined && rest.length === 0 && isFileUrlOfMeta(first, imports) ? "." : undefined;
  if ((fn !== "join" && fn !== "resolve") || !first || rest.length === 0) return undefined;
  const base = isDirArg(first, imports) ? "." : fileRelativePath(first, imports, env, hops + 1);
  if (base === undefined) return undefined;
  const segments = rest.map((a) => (ts.isStringLiteralLike(a) ? a.text : undefined));
  if (!segments.every((s): s is string => s !== undefined && isRelativePath(s))) return undefined;
  return [base, ...segments].join("/");
}

/**
 * The script a spawn argument names, when it names one statically. A plain relative literal is cwd-relative;
 * the forms `fileRelativePath` accepts are file-relative. An identifier is followed to its same-file `const` when
 * `env` says where that is; a variable it cannot follow, an absolute path or a URL with another base names none.
 */
export function scriptPath(arg: ts.Expression | undefined, imports: Map<string, ImportBinding>, env: WorkerEnv = {}, hops = 0): ScriptPath | undefined {
  if (!arg || hops > MAX_CONST_HOPS) return undefined;
  if (ts.isIdentifier(arg)) {
    const init = env.constOf?.(arg);
    return init === undefined ? undefined : scriptPath(init, imports, env, hops + 1);
  }
  if (ts.isStringLiteralLike(arg)) return isRelativePath(arg.text) ? { base: "cwd", path: arg.text } : undefined;
  const path = fileRelativePath(arg, imports, env);
  return path === undefined ? undefined : { base: "file", path };
}

/** Child-process calls whose second argument is the argument vector, so that a Node binary runs its first entry as a script. */
const NODE_ARGV_APIS = new Set(["child_process.spawn", "child_process.spawnSync", "child_process.execFile", "child_process.execFileSync"]);

/**
 * The script a Node child process runs: the first entry of `spawn(process.execPath, [script, ...])` and the same calls
 * from `child_process` that take a file and an argument vector. Undefined for any other command, such as `git`.
 */
export function nodeScriptArgument(call: ts.CallExpression, api: string, imports: Map<string, ImportBinding>): ts.Expression | undefined {
  if (!NODE_ARGV_APIS.has(api)) return undefined;
  const [file, argv] = call.arguments;
  const isExecPath =
    file !== undefined &&
    ts.isPropertyAccessExpression(file) &&
    file.name.text === "execPath" &&
    ts.isIdentifier(file.expression) &&
    file.expression.text === "process" &&
    !imports.has("process");
  if (!isExecPath || argv === undefined) return undefined;
  let list: ts.Expression = argv;
  while (ts.isParenthesizedExpression(list) || ts.isAsExpression(list)) list = list.expression;
  return ts.isArrayLiteralExpression(list) ? list.elements[0] : undefined;
}

/**
 * What a worker call site needs beyond its own syntax: the initializer of a `const` an identifier names, and whether the
 * project itself declares an identifier (so it is not the browser's global of that name).
 */
export interface WorkerEnv {
  constOf?: (id: ts.Identifier) => ts.Expression | undefined;
  declared?: (id: ts.Identifier) => boolean;
}

/**
 * `new Worker(file)` from worker_threads, as a named or namespace import, or the browser's `new Worker(url)` and
 * `new SharedWorker(url)` globals. Returns the script the worker runs.
 */
export function matchWorker(node: ts.NewExpression, imports: Map<string, ImportBinding>, env: WorkerEnv = {}): WorkerMatch | undefined {
  const callee = node.expression;
  let isWorker = false;
  if (ts.isIdentifier(callee)) {
    const b = imports.get(callee.text);
    isWorker = b !== undefined && b.module === "worker_threads" && b.name === "Worker";
  } else if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.name.text === "Worker") {
    const b = imports.get(callee.expression.text);
    isWorker = b !== undefined && b.module === "worker_threads" && b.name === undefined;
  }
  if (!isWorker) return matchBrowserWorker(node, imports, env);
  const first = node.arguments?.[0];
  return {
    api: "worker_threads.Worker",
    target: first && ts.isStringLiteralLike(first) ? first.text : DYNAMIC,
    script: scriptPath(first, imports),
  };
}

/**
 * The script a browser worker's argument names: a relative string, or `new URL(p, import.meta.url)`. Both are relative to
 * the file that makes the call, as bundlers read them.
 */
function browserScriptPath(arg: ts.Expression | undefined, imports: Map<string, ImportBinding>): ScriptPath | undefined {
  if (!arg) return undefined;
  if (ts.isStringLiteralLike(arg)) return isRelativePath(arg.text) ? { base: "file", path: arg.text } : undefined;
  const path = fileRelativePath(arg, imports);
  return path === undefined ? undefined : { base: "file", path };
}

/** `new Worker(...)` or `new SharedWorker(...)` as the browser global: a name the file neither imports nor declares. */
function matchBrowserWorker(node: ts.NewExpression, imports: Map<string, ImportBinding>, env: WorkerEnv): WorkerMatch | undefined {
  const callee = node.expression;
  if (!ts.isIdentifier(callee) || (callee.text !== "Worker" && callee.text !== "SharedWorker")) return undefined;
  if (imports.has(callee.text) || env.declared?.(callee)) return undefined;
  const first = node.arguments?.[0];
  // A const that holds the argument is followed once: `const url = new URL(...); new Worker(url)`.
  const arg = first !== undefined && ts.isIdentifier(first) ? (env.constOf?.(first) ?? first) : first;
  const script = browserScriptPath(arg, imports);
  return {
    api: callee.text,
    target: arg !== undefined && ts.isStringLiteralLike(arg) ? arg.text : (script?.path ?? DYNAMIC),
    script,
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

/** The expression with every wrapper removed: parentheses, `as`, `<T>` and `!`. */
function unwrapAll(e: ts.Expression): ts.Expression {
  let inner = e;
  while (ts.isParenthesizedExpression(inner) || ts.isAsExpression(inner) || ts.isTypeAssertionExpression(inner) || ts.isNonNullExpression(inner)) {
    inner = inner.expression;
  }
  return inner;
}

/** A placeholder for a template substitution inside a URL or route path while the text is being built. */
const SUB = "￼";
/** What a substitution becomes in a route path or URL path. */
const PARAM = ":param";

/** `process.env.NAME` or `import.meta.env.NAME`, read as a property access. Returns the name. */
function envVarOf(e: ts.Expression, imports: Map<string, ImportBinding>): string | undefined {
  if (!ts.isPropertyAccessExpression(e)) return undefined;
  const inner = e.expression;
  if (!ts.isPropertyAccessExpression(inner) || inner.name.text !== "env") return undefined;
  if (ts.isIdentifier(inner.expression) && inner.expression.text === "process" && !imports.has("process")) return e.name.text;
  if (ts.isMetaProperty(inner.expression) && inner.expression.keywordToken === ts.SyntaxKind.ImportKeyword) return e.name.text;
  return undefined;
}

/**
 * The first env variable read anywhere inside a node. With `follow`, an identifier is followed once to the same-file const
 * it names, and that const's initializer is searched too (not followed further).
 */
function findEnv(node: ts.Node, imports: Map<string, ImportBinding>, env: WorkerEnv, follow: boolean): string | undefined {
  if (ts.isExpression(node)) {
    const name = envVarOf(node, imports);
    if (name !== undefined) return name;
  }
  if (follow && ts.isIdentifier(node)) {
    const init = env.constOf?.(node);
    if (init !== undefined) return findEnv(init, imports, env, false);
  }
  let found: string | undefined;
  ts.forEachChild(node, (child) => {
    found = findEnv(child, imports, env, follow);
    return found !== undefined;
  });
  return found;
}

/** The initializer of a same-file const an identifier names, if it has one. */
function constInit(e: ts.Expression, env: WorkerEnv): ts.Expression | undefined {
  return ts.isIdentifier(e) ? env.constOf?.(e) : undefined;
}

/** A URL as written: its text with substitutions as SUB, and whether it begins with one that is an env read. */
export interface UrlText {
  text: string;
  leadEnv: boolean;
  /** The env variable the URL reads, when a hooked substitution carried one. */
  env?: string;
}

/** Resolves an expression the caller binds (a wrapper's parameter) to a URL; undefined leaves it to the normal rules. */
export type UrlHook = (e: ts.Expression) => UrlText | undefined;

/**
 * The text of a URL expression. An identifier is followed to its const once (`follow`); a substitution's env read
 * is found by the caller, so the text here only needs the shape.
 */
export function urlText(e0: ts.Expression, imports: Map<string, ImportBinding>, env: WorkerEnv, follow: boolean, hook?: UrlHook): UrlText | undefined {
  const e = unwrapAll(e0);
  const hooked = hook?.(e);
  if (hooked !== undefined) return hooked;
  if (ts.isStringLiteralLike(e)) return { text: e.text, leadEnv: false };
  if (ts.isNoSubstitutionTemplateLiteral(e)) return { text: e.text, leadEnv: false };
  if (ts.isTemplateExpression(e)) {
    let text = e.head.text;
    let hitEnv: string | undefined;
    let leadHit: UrlText | undefined;
    e.templateSpans.forEach((span, i) => {
      const hit = hook?.(unwrapAll(span.expression));
      if (hit !== undefined) {
        if (i === 0) leadHit = hit;
        if (hitEnv === undefined) hitEnv = hit.env;
        text += hit.text + span.literal.text;
        return;
      }
      // A substituted same-file const that holds a string is written in place, so `${KV_API}/x` reads as its host.
      text += (constString(span.expression, env) ?? SUB) + span.literal.text;
    });
    const first = e.templateSpans[0];
    const leadEnv =
      e.head.text === "" && first !== undefined
        ? leadHit !== undefined
          ? leadHit.leadEnv
          : envOf(first.expression, imports, env) !== undefined
        : false;
    return hitEnv === undefined ? { text, leadEnv } : { text, leadEnv, env: hitEnv };
  }
  if (ts.isNewExpression(e)) {
    if (!ts.isIdentifier(e.expression) || e.expression.text !== "URL") return undefined;
    const [first] = e.arguments ?? [];
    return first === undefined ? undefined : urlText(first, imports, env, follow, hook);
  }
  if (ts.isIdentifier(e) && follow) {
    const init = constInit(e, env);
    return init === undefined ? undefined : urlText(init, imports, env, false, hook);
  }
  return undefined;
}

/** The string a substitution names: a string literal, or a same-file const whose initializer is one. */
function constString(e0: ts.Expression, env: WorkerEnv): string | undefined {
  const e = unwrapAll(e0);
  if (ts.isStringLiteralLike(e)) return e.text;
  const init = constInit(e, env);
  return init !== undefined && ts.isStringLiteralLike(unwrapAll(init)) ? (unwrapAll(init) as ts.StringLiteralLike).text : undefined;
}

/** The env variable an expression reads: anywhere inside it, or inside the one-hop const each identifier in it names. */
function envOf(e: ts.Expression, imports: Map<string, ImportBinding>, env: WorkerEnv): string | undefined {
  return findEnv(e, imports, env, true);
}

/** A URL path: the query and fragment dropped, substitutions as :param. Undefined when nothing is left. */
function urlPath(s: string): string | undefined {
  const p = s.split(/[?#]/)[0] ?? "";
  if (p === "") return undefined;
  return p.split(SUB).join(PARAM);
}

export interface FetchMatch {
  kind: "effects.net.connect";
  attrs: Record<string, unknown>;
}

const GLOBAL_FETCH_BASES = new Set(["globalThis", "window", "self"]);

/**
 * A `fetch`-like call: the global fetch (exact), or any callee whose name contains `fetch` (any case) with at least one
 * argument (inferred, e.g. `deps.fetch(url)`, `fetchFn(url)`, `fetchImpl(url)`). Its URL is read from the first argument, its method from the second.
 */
export interface FetchHooks {
  /** Gives the URL an argument-bound name stands for. */
  url?: UrlHook;
  /** Gives the method an argument-bound name stands for, when the argument is a string. */
  method?: (e: ts.Expression) => string | undefined;
}

export function matchFetch(call: ts.CallExpression, imports: Map<string, ImportBinding>, env: WorkerEnv = {}, hooks: FetchHooks = {}): FetchMatch | undefined {
  const callee = unwrapAll(call.expression) as ts.Expression;
  let name: string | undefined;
  let exact = false;
  if (ts.isIdentifier(callee)) {
    name = callee.text;
    exact = name === "fetch" && !imports.has("fetch") && !env.declared?.(callee);
  } else if (ts.isPropertyAccessExpression(callee)) {
    name = callee.name.text;
    const base = callee.expression;
    exact =
      name === "fetch" &&
      ts.isIdentifier(base) &&
      GLOBAL_FETCH_BASES.has(base.text) &&
      !imports.has(base.text) &&
      !env.declared?.(base);
  }
  if (name === undefined) return undefined;
  if (!exact && !/fetch/i.test(name)) return undefined;
  const [urlArg, opts] = call.arguments;
  if (urlArg === undefined) return undefined;

  const attrs: Record<string, unknown> = { api: callee.getText().slice(0, 40) };
  const found = urlText(urlArg, imports, env, true, hooks.url);
  const envName = found?.env ?? envOf(urlArg, imports, env);
  if (found === undefined) {
    attrs.host = DYNAMIC;
  } else {
    const text = found.text;
    if (text.startsWith(SUB)) {
      const rest = text.slice(1);
      if (found.leadEnv) {
        attrs.host = DYNAMIC;
        const path = rest.startsWith("/") ? urlPath(rest) : undefined;
        if (path !== undefined) attrs.path = path;
      } else if (rest.startsWith("/") && !rest.startsWith("//")) {
        attrs.relative = true;
        attrs.path = urlPath(rest);
      } else {
        attrs.host = DYNAMIC;
      }
    } else if (/^https?:\/\//.test(text)) {
      const m = /^https?:\/\/([^/?#]*)([\s\S]*)$/.exec(text);
      const authority = m?.[1] ?? "";
      attrs.host = authority === "" || authority.includes(SUB) ? DYNAMIC : authority;
      const path = urlPath(m?.[2] ?? "");
      if (path !== undefined) attrs.path = path;
    } else if (text.startsWith("/") && !text.startsWith("//")) {
      attrs.relative = true;
      attrs.path = urlPath(text);
    } else {
      attrs.host = DYNAMIC;
    }
  }
  if (attrs.path === undefined) delete attrs.path;
  if (envName !== undefined) attrs.env = envName;

  // The method: the second argument's `method` string, GET when the options object omits it, and absent when it is not literal.
  if (opts === undefined) {
    attrs.method = "GET";
  } else {
    const o = unwrapAll(opts);
    if (ts.isObjectLiteralExpression(o)) {
      const hasSpread = o.properties.some((p) => ts.isSpreadAssignment(p));
      // `method: x` and the shorthand `{ method }` both name a value; the shorthand's name is the value.
      const prop = o.properties.find(
        (p): p is ts.PropertyAssignment | ts.ShorthandPropertyAssignment =>
          (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && p.name.text === "method",
      );
      if (prop === undefined) {
        if (!hasSpread) attrs.method = "GET";
      } else {
        const value = ts.isShorthandPropertyAssignment(prop) ? prop.name : unwrapAll(prop.initializer);
        if (ts.isStringLiteralLike(value)) attrs.method = value.text.toUpperCase();
        else {
          const m = hooks.method?.(value);
          if (m !== undefined) attrs.method = m;
        }
      }
    }
  }
  attrs.confidence = exact ? "exact" : "inferred";
  return { kind: "effects.net.connect", attrs };
}

export interface ServeMatch {
  kind: "effects.net.serve";
  attrs: Record<string, unknown>;
}

const ROUTE_METHODS = new Set(["get", "post", "put", "delete", "patch", "head", "options", "all"]);
const ROUTER_NAMES = new Set(["app", "server", "router", "fastify", "api"]);
const HTTP_EXPORTS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]);

/** The server framework a file imports, if any. */
export function serverFramework(imports: Map<string, ImportBinding>): string | undefined {
  for (const b of imports.values()) {
    const m = b.module;
    if (m === "fastify" || m.startsWith("@fastify/")) return "fastify";
    if (m === "express") return "express";
    if (m === "hono" || m.startsWith("hono/")) return "hono";
    if (m === "koa-router" || m === "@koa/router") return "koa-router";
  }
  return undefined;
}

/** A route path as written: a string or template literal, with substitutions as :param. Undefined for anything else. */
function routePath(e0: ts.Expression): string | undefined {
  const e = unwrapAll(e0);
  if (ts.isStringLiteralLike(e)) return e.text;
  if (ts.isTemplateExpression(e)) {
    let text = e.head.text;
    for (const span of e.templateSpans) text += PARAM + span.literal.text;
    return text;
  }
  return undefined;
}

/** The name of a handler argument when it is obvious: an identifier, or the property a member access names. */
function handlerName(e0: ts.Expression): string | undefined {
  const e = unwrapAll(e0);
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return undefined;
}

/**
 * An HTTP route registered on a server object: `X.get|post|…(path, …handler)` and `X.route({method, url|path})`. The call
 * counts when the file imports a server framework, or when X is named like a server and is not an import.
 */
export function matchServe(call: ts.CallExpression, imports: Map<string, ImportBinding>): ServeMatch | undefined {
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee) || !ts.isIdentifier(callee.expression)) return undefined;
  const base = callee.expression.text;
  const name = callee.name.text;
  const framework = serverFramework(imports);
  const named = !imports.has(base) && ROUTER_NAMES.has(base);
  if (framework === undefined && !named) return undefined;
  const serving = framework ?? "http";

  if (ROUTE_METHODS.has(name)) {
    const [pathArg, ...rest] = call.arguments;
    if (pathArg === undefined || rest.length === 0) return undefined;
    const path = routePath(pathArg);
    if (path === undefined || !path.startsWith("/")) return undefined;
    const last = rest[rest.length - 1];
    const handler = last === undefined ? undefined : handlerName(last);
    return {
      kind: "effects.net.serve",
      attrs: {
        framework: serving,
        method: name === "all" ? "ALL" : name.toUpperCase(),
        path,
        ...(handler !== undefined ? { handler } : {}),
      },
    };
  }

  if (name === "route") {
    const [opts] = call.arguments;
    const o = opts === undefined ? undefined : unwrapAll(opts);
    if (o === undefined || !ts.isObjectLiteralExpression(o)) return undefined;
    const str = (key: string): string | undefined => {
      const p = o.properties.find(
        (q): q is ts.PropertyAssignment => ts.isPropertyAssignment(q) && ts.isIdentifier(q.name) && q.name.text === key,
      );
      if (p === undefined) return undefined;
      const v = unwrapAll(p.initializer);
      return ts.isStringLiteralLike(v) ? v.text : undefined;
    };
    const method = str("method");
    const path = str("url") ?? str("path");
    if (method === undefined || path === undefined || !path.startsWith("/")) return undefined;
    return { kind: "effects.net.serve", attrs: { framework: serving, method: method.toUpperCase(), path } };
  }
  return undefined;
}

/**
 * A route a file exports under an HTTP verb name: `export function POST` or `export const GET`. The URL comes from the
 * deployment, not the code, so the path is empty and the framework is "export".
 */
export function matchExportRoute(node: ts.Node): ServeMatch[] {
  const exported = (n: ts.Node): boolean => ts.canHaveModifiers(n) && (ts.getModifiers(n) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  // `export { handler as POST }`: the exported name is the verb, whatever the local function is called.
  if (ts.isExportDeclaration(node) && node.moduleSpecifier === undefined && node.exportClause && ts.isNamedExports(node.exportClause)) {
    return node.exportClause.elements
      .filter((el) => HTTP_EXPORTS.has(el.name.text))
      .map((el) => ({ kind: "effects.net.serve" as const, attrs: { framework: "export", method: el.name.text, path: "" } }));
  }
  // `export default { fetch(req) {...} }` or `export default { async fetch }`: a Worker, which answers every path.
  if (ts.isExportAssignment(node) && !node.isExportEquals) {
    const o = unwrapAll(node.expression);
    const hasFetch = ts.isObjectLiteralExpression(o) && o.properties.some(
      (p) =>
        (ts.isMethodDeclaration(p) || ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
        (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) &&
        p.name.text === "fetch",
    );
    return hasFetch ? [{ kind: "effects.net.serve", attrs: { framework: "worker", method: "*", path: "/*" } }] : [];
  }
  if (ts.isFunctionDeclaration(node) && node.name !== undefined && exported(node) && HTTP_EXPORTS.has(node.name.text)) {
    return [{ kind: "effects.net.serve", attrs: { framework: "export", method: node.name.text, path: "" } }];
  }
  if (ts.isVariableStatement(node) && exported(node)) {
    const out: ServeMatch[] = [];
    for (const d of node.declarationList.declarations) {
      if (ts.isIdentifier(d.name) && HTTP_EXPORTS.has(d.name.text)) {
        out.push({ kind: "effects.net.serve", attrs: { framework: "export", method: d.name.text, path: "" } });
      }
    }
    return out;
  }
  return [];
}
