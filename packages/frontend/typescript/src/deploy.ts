import { posix } from "node:path";

/** A wrangler config file: wrangler.toml, or wrangler.json and wrangler.jsonc. */
export const WRANGLER_RE = /(^|\/)wrangler\.(toml|json|jsonc)$/;

/** What a wrangler config declares: the Worker's name and entry, and the platform bindings the code reaches through env. */
export interface WranglerInfo {
  name?: string;
  main?: string;
  kv: { binding: string; id?: string }[];
  r2: { binding: string; bucket?: string }[];
  d1: { binding: string; database?: string }[];
}

/** The store service each wrangler binding list names. */
export const WRANGLER_STORES = { kv: "cloudflare-kv", r2: "cloudflare-r2", d1: "cloudflare-d1" } as const;

/** A Worker entry file a wrangler config deploys: its name, and each binding name mapped to the store service it is. */
export interface WorkerDeploy {
  name?: string;
  bindings: Map<string, string>;
}

const EMPTY = (): WranglerInfo => ({ kv: [], r2: [], d1: [] });

/** The binding lists of a wrangler config. */
type BindingList = keyof Pick<WranglerInfo, "kv" | "r2" | "d1">;

/** The `[[table]]` (or inline-array) names a TOML wrangler file uses for its bindings, and the list each feeds. */
const TOML_TABLES: Record<string, BindingList> = {
  kv_namespaces: "kv",
  r2_buckets: "r2",
  d1_databases: "d1",
};

/** The list a TOML table name feeds, or undefined: an own key only, so a prototype member (constructor, valueOf) is no table. */
const tomlTable = (name: string): BindingList | undefined => (Object.hasOwn(TOML_TABLES, name) ? TOML_TABLES[name] : undefined);

/** A TOML basic or literal string value at the start of text, or undefined for any other value. */
function tomlString(value: string): string | undefined {
  const basic = /^"((?:[^"\\]|\\.)*)"/.exec(value);
  if (basic) return basic[1];
  const literal = /^'([^']*)'/.exec(value);
  return literal ? literal[1] : undefined;
}

/** Adds one binding (a `[[table]]`'s keys, or an inline table's) to the list its table feeds. */
function addBinding(info: WranglerInfo, list: BindingList, entry: Record<string, string>): void {
  if (entry.binding === undefined) return;
  if (list === "kv") info.kv.push({ binding: entry.binding, id: entry.id });
  else if (list === "r2") info.r2.push({ binding: entry.binding, bucket: entry.bucket_name });
  else info.d1.push({ binding: entry.binding, database: entry.database_name });
}

/**
 * The net count of open brackets in a TOML value's text, outside strings and `#` comments (a comment runs to the line's end).
 * Zero when an inline array is closed.
 */
function bracketDepth(text: string): number {
  let depth = 0;
  let quote: string | undefined;
  for (let i = 0; i < text.length; i++) {
    const c = text[i] ?? "";
    if (quote !== undefined) {
      if (c === "\\" && quote === '"') i++;
      else if (c === quote) quote = undefined;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "#") {
      const newline = text.indexOf("\n", i);
      if (newline === -1) break;
      i = newline;
    } else if (c === "[") depth++;
    else if (c === "]") depth--;
  }
  return depth;
}

/** The entries of an inline array of tables, `[ { binding = "A", id = "1" }, { binding = "B" } ]`: each table's string values. */
function inlineTables(body: string): Record<string, string>[] {
  const out: Record<string, string>[] = [];
  for (const table of body.matchAll(/\{([^{}]*)\}/g)) {
    const entry: Record<string, string> = {};
    for (const pair of (table[1] ?? "").matchAll(/([A-Za-z0-9_-]+)\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')/g)) {
      const value = tomlString(pair[2] ?? "");
      if (value !== undefined) entry[pair[1] ?? ""] = value;
    }
    out.push(entry);
  }
  return out;
}

/**
 * The wrangler fields this reads from a TOML config: top-level name and main, and the entries of the binding tables, either
 * `[[table]]` sections or inline arrays (`kv_namespaces = [ { binding = "X" } ]`, possibly over several lines). Keys under any
 * other table (vars, env.*, triggers) are ignored, so a binding is only one the config declares at top level.
 */
function parseToml(text: string): WranglerInfo {
  const info = EMPTY();
  const lines = text.split(/\r?\n/);
  let topLevel = true;
  let list: BindingList | undefined;
  let entry: Record<string, string> | undefined;
  const flush = (): void => {
    if (list !== undefined && entry !== undefined) addBinding(info, list, entry);
    list = undefined;
    entry = undefined;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? "").trim();
    if (line === "" || line.startsWith("#")) continue;
    const arrayTable = /^\[\[\s*([A-Za-z0-9_.-]+)\s*\]\]/.exec(line);
    const table = /^\[\s*([A-Za-z0-9_.-]+)\s*\]/.exec(line);
    if (arrayTable || table) {
      flush();
      topLevel = false;
      const name = (arrayTable ?? table)?.[1] ?? "";
      const feeds = arrayTable ? tomlTable(name) : undefined;
      if (feeds !== undefined) {
        list = feeds;
        entry = {};
      }
      continue;
    }
    const inline = /^(kv_namespaces|r2_buckets|d1_databases)\s*=\s*(\[.*)$/.exec(line);
    if (inline && topLevel) {
      let body = inline[2] ?? "";
      while (bracketDepth(body) > 0 && i + 1 < lines.length) body += `\n${lines[++i] ?? ""}`;
      const target = tomlTable(inline[1] ?? "");
      if (target !== undefined) for (const t of inlineTables(body)) addBinding(info, target, t);
      continue;
    }
    const key = /^([A-Za-z0-9_-]+)\s*=\s*(.*)$/.exec(line);
    if (!key) continue;
    const [, k, rest] = key;
    const value = tomlString(rest ?? "");
    if (value === undefined) continue;
    if (topLevel) {
      if (k === "name") info.name = value;
      else if (k === "main") info.main = value;
    } else if (entry !== undefined) {
      entry[k ?? ""] = value;
    }
  }
  flush();
  return info;
}

/** Removes // and /* *\/ comments outside strings, so JSONC parses as JSON. String contents are copied as they are. */
function stripJsonc(text: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i] ?? "";
    if (inString) {
      out += c;
      if (c === "\\") out += text[++i] ?? "";
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 1;
    } else {
      out += c;
    }
  }
  return dropTrailingCommas(out);
}

/** Removes a comma that a `}` or `]` follows, outside strings only: a string that holds ", }" keeps its text. */
function dropTrailingCommas(text: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i] ?? "";
    if (inString) {
      out += c;
      if (c === "\\") out += text[++i] ?? "";
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    if (c === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j] ?? "")) j++;
      if (text[j] === "}" || text[j] === "]") continue;
    }
    out += c;
  }
  return out;
}

/** The wrangler fields this reads from a JSON or JSONC config. A file that does not parse declares nothing. */
function parseJson(text: string): WranglerInfo {
  const info = EMPTY();
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(stripJsonc(text)) as Record<string, unknown>;
  } catch {
    return info;
  }
  const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
  const entries = (v: unknown): Record<string, unknown>[] =>
    Array.isArray(v) ? v.filter((e): e is Record<string, unknown> => typeof e === "object" && e !== null) : [];
  info.name = str(doc.name);
  info.main = str(doc.main);
  for (const e of entries(doc.kv_namespaces)) {
    const binding = str(e.binding);
    if (binding !== undefined) info.kv.push({ binding, id: str(e.id) });
  }
  for (const e of entries(doc.r2_buckets)) {
    const binding = str(e.binding);
    if (binding !== undefined) info.r2.push({ binding, bucket: str(e.bucket_name) });
  }
  for (const e of entries(doc.d1_databases)) {
    const binding = str(e.binding);
    if (binding !== undefined) info.d1.push({ binding, database: str(e.database_name) });
  }
  return info;
}

/** The fields of a wrangler config, read by its file's extension: .json and .jsonc as JSON (with comments), anything else as TOML. */
export function parseWrangler(text: string, file: string): WranglerInfo {
  return /\.jsonc?$/i.test(file) ? parseJson(text) : parseToml(text);
}

/** The entry file names a Worker may have when its config names no main, in the order wrangler tries them. */
const DEFAULT_MAINS = ["index.js", "index.ts", "src/index.js", "src/index.ts"];

/**
 * The Worker entry files the configs deploy, keyed by project-relative path. A config's main is relative to its folder;
 * without one, the first of the default entries the project has. A main outside the project's sources is not an entry.
 */
export function workerEntries(wranglers: Map<string, WranglerInfo>, rels: Set<string>): Map<string, WorkerDeploy> {
  const out = new Map<string, WorkerDeploy>();
  for (const [dir, info] of wranglers) {
    const candidates = info.main !== undefined ? [info.main] : DEFAULT_MAINS;
    const main = candidates.map((c) => posix.normalize(posix.join(dir, c))).find((p) => rels.has(p));
    if (main === undefined || out.has(main)) continue;
    const bindings = new Map<string, string>();
    for (const b of info.kv) bindings.set(b.binding, WRANGLER_STORES.kv);
    for (const b of info.r2) bindings.set(b.binding, WRANGLER_STORES.r2);
    for (const b of info.d1) bindings.set(b.binding, WRANGLER_STORES.d1);
    out.set(main, { ...(info.name !== undefined ? { name: info.name } : {}), bindings });
  }
  return out;
}
