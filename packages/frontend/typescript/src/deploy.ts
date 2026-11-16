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

/** The `[[table]]` names a TOML wrangler file uses for its bindings, and the list each feeds. */
const TOML_TABLES: Record<string, keyof Pick<WranglerInfo, "kv" | "r2" | "d1">> = {
  kv_namespaces: "kv",
  r2_buckets: "r2",
  d1_databases: "d1",
};

/** A TOML basic or literal string value at the start of text, or undefined for any other value. */
function tomlString(value: string): string | undefined {
  const basic = /^"((?:[^"\\]|\\.)*)"/.exec(value);
  if (basic) return basic[1];
  const literal = /^'([^']*)'/.exec(value);
  return literal ? literal[1] : undefined;
}

/**
 * The wrangler fields this reads from a TOML config: top-level name and main, and the entries of the binding tables. Keys
 * under any other table (vars, env.*, triggers) are ignored, so a binding is only one the config declares at top level.
 */
function parseToml(text: string): WranglerInfo {
  const info = EMPTY();
  let topLevel = true;
  let list: keyof Pick<WranglerInfo, "kv" | "r2" | "d1"> | undefined;
  let entry: Record<string, string> | undefined;
  const flush = (): void => {
    if (list !== undefined && entry !== undefined && entry.binding !== undefined) {
      if (list === "kv") info.kv.push({ binding: entry.binding, id: entry.id });
      else if (list === "r2") info.r2.push({ binding: entry.binding, bucket: entry.bucket_name });
      else info.d1.push({ binding: entry.binding, database: entry.database_name });
    }
    list = undefined;
    entry = undefined;
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const arrayTable = /^\[\[\s*([A-Za-z0-9_.-]+)\s*\]\]/.exec(line);
    const table = /^\[\s*([A-Za-z0-9_.-]+)\s*\]/.exec(line);
    if (arrayTable || table) {
      flush();
      topLevel = false;
      const name = (arrayTable ?? table)?.[1] ?? "";
      if (arrayTable && TOML_TABLES[name] !== undefined) {
        list = TOML_TABLES[name];
        entry = {};
      }
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

/** Removes // and /* *\/ comments outside strings, and trailing commas, so JSONC parses as JSON. */
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
  return out.replace(/,(\s*[}\]])/g, "$1");
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

/** The fields of a wrangler config. A JSON or JSONC file starts with an object; anything else is read as TOML. */
export function parseWrangler(text: string): WranglerInfo {
  return text.trimStart().startsWith("{") ? parseJson(text) : parseToml(text);
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
