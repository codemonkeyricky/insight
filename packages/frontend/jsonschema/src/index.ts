import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import type { Detection, ExtractContext, Frontend, IRBatch, IRRecord, ProjectRoot } from "@insight/sdk";

/**
 * POC frontend for Insight's own IR JSON Schema files. It reads every schema document and kinds file it is given,
 * turns each $defs entry and each kinds entry into structure nodes, and links $refs, kinds to their attrs schemas,
 * kinds to their parents, and TypeScript files to the kinds they emit or read. Spans come from a text search, so
 * they are heuristics.
 */

const FRONTEND_ID = "frontend-jsonschema";
const KINDS_FILE = "packages/core/ir/schema/core.kinds.json";
const MAX_BYTES = 1024 * 1024;
/** Stat cap for the detect walk, and the cap on files whose contents detect reads. */
const MAX_WALK_FILES = 50000;
const MAX_READ_FILES = 2000;
/** Substrings a JSON file must contain to possibly be a schema, a kinds file or a $schema-bearing instance. */
const CANDIDATE_RE = /"\$schema"|"\$defs"|"definitions"|"kind"/;
/** A name that marks a schema or kinds file without reading it. */
const SCHEMA_NAME_RE = /(^|\/)([^/]*\.schema\.json|[^/]*\.kinds\.json|kinds\.json|[^/]*\.kind\.json)$/;
/** Directories whose JSON is never indexed. */
const IGNORED_DIRS = new Set(["node_modules", "dist", ".git", ".insight", ".claude", "build", "coverage", ".next", ".turbo", ".cache", "target", "out", "vendor", ".venv", "venv", "__pycache__"]);
/** Built-in filename table: instance files that follow a schema without saying so. */
const PLUGIN_MANIFEST_ID = "https://insight.dev/core/plugin-manifest.json";
const IR_CORE_ID = "https://insight.dev/ir/core.json";
const filenameSchemaId = (file: string): string | undefined => {
  const base = file.split("/").pop() ?? file;
  if (base === "insight-plugin.json") return PLUGIN_MANIFEST_ID;
  if (base.endsWith(".ir.json")) return IR_CORE_ID;
  return undefined;
};
/** A schema's $id with a trailing empty fragment removed, so "x.json#" and "x.json" match. */
const normId = (id: string): string => id.replace(/#+$/, "");
const ignoredPath = (file: string): boolean => file.split("/").slice(0, -1).some((d) => IGNORED_DIRS.has(d));
/** Test fixture and sample data never counts as a schema or kinds file (it can still be an instance). */
/** An absolute URI that no local $id could satisfy by changing: anything but a well-known json-schema.org meta-schema. */
const absoluteMiss = (ref: string): boolean => {
  if (!/^[a-z][a-z0-9+.-]*:/i.test(ref)) return false;
  try {
    const host = new URL(ref).hostname;
    return !(host === "json-schema.org" || host.endsWith(".json-schema.org"));
  } catch {
    return true;
  }
};
const fixturePath = (file: string): boolean => /(^|\/)(fixtures|samples)\//.test(file);

type DocClass = "schema" | "kinds" | "other";

/** Classifies parsed JSON: a schema document, a kinds file, or anything else. */
function classifyJson(json: unknown): DocClass {
  if (Array.isArray(json)) {
    const ok = json.length > 0 && json.every((e) => isObj(e) && typeof e.kind === "string" && typeof e.facet === "string" && typeof e.on === "string");
    return ok ? "kinds" : "other";
  }
  if (!isObj(json)) return "other";
  if (typeof json.$schema === "string" && json.$schema.includes("json-schema")) return "schema";
  for (const key of ["$defs", "definitions"]) {
    const v = json[key];
    if (isObj(v)) {
      const vals = Object.values(v);
      if (vals.length > 0 && vals.every(isObj)) return "schema";
    }
  }
  return "other";
}

type Schema = Record<string, unknown>;
type Span = { file: string; start: [number, number]; end: [number, number] };

const isObj = (v: unknown): v is Schema => typeof v === "object" && v !== null && !Array.isArray(v);
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const prov = (confidence: "exact" | "heuristic" | "inferred") => ({ frontend: FRONTEND_ID, confidence });

interface Prop {
  id: string;
  name: string;
  schema: unknown;
  required: boolean;
  line: number;
}

interface Def {
  id: string;
  file: string;
  name: string;
  root: boolean;
  schema: Schema;
  line: number;
  props: Prop[];
}

interface KindDecl {
  id: string;
  file: string;
  name: string;
  entry: Schema;
  line: number;
}

interface Doc {
  file: string;
  lines: string[];
  error?: string;
  cls: DocClass;
  /** The top-level $schema string of a non-schema, non-kinds document, if any. */
  dollarSchema?: string;
  schemaId?: string;
  defs: Def[];
  kinds: KindDecl[];
}

/** The first line at or after `from` that matches, or -1. */
function lineOf(lines: string[], re: RegExp, from = 0): number {
  for (let i = Math.max(0, from); i < lines.length; i++) if (re.test(lines[i] ?? "")) return i;
  return -1;
}

function spanAt(file: string, lines: string[], line: number): Span {
  const l = Math.max(0, line);
  return { file, start: [l, 0], end: [l, (lines[l] ?? "").length] };
}

function makeDef(file: string, lines: string[], key: string, name: string, schema: Schema, line: number, root: boolean): Def {
  const id = `${file}#def:${key}`;
  const req = Array.isArray(schema.required) ? schema.required.filter((x): x is string => typeof x === "string") : [];
  const props: Prop[] = [];
  const properties = isObj(schema.properties) ? schema.properties : {};
  for (const [p, ps] of Object.entries(properties)) {
    const pl = lineOf(lines, new RegExp(`"${escapeRe(p)}"\\s*:`), Math.max(0, line));
    props.push({ id: `${id}/prop:${p}`, name: p, schema: ps, required: req.includes(p), line: pl < 0 ? Math.max(0, line) : pl });
  }
  return { id, file, name, root, schema, line: Math.max(0, line), props };
}

function parseDoc(file: string, text: string): Doc {
  const lines = text.split("\n");
  const doc: Doc = { file, lines, cls: "other", defs: [], kinds: [] };
  if (text.length > MAX_BYTES || ignoredPath(file)) return doc;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    doc.error = (err as Error).message;
    return doc;
  }
  let cls = classifyJson(json);
  if (fixturePath(file) || file.endsWith(".ir.json")) cls = "other";
  doc.cls = cls;
  if (cls === "kinds" && Array.isArray(json)) {
    for (const entry of json) {
      if (!isObj(entry) || typeof entry.kind !== "string") continue;
      const name = entry.kind;
      const line = lineOf(lines, new RegExp(`"kind"\\s*:\\s*"${escapeRe(name)}"`));
      doc.kinds.push({ id: `${file}#kind:${name}`, file, name, entry, line: Math.max(0, line) });
    }
    return doc;
  }
  if (!isObj(json)) return doc;
  if (cls === "other") {
    if (typeof json.$schema === "string") doc.dollarSchema = json.$schema;
    return doc;
  }
  if (typeof json.$id === "string") doc.schemaId = normId(json.$id);
  const title = typeof json.title === "string" ? json.title : (file.split("/").pop() ?? file);
  doc.defs.push(makeDef(file, lines, "$root", title, json, 0, true));
  for (const section of ["$defs", "definitions"]) {
    const sec = json[section];
    if (!isObj(sec)) continue;
    const defsLine = Math.max(0, lineOf(lines, new RegExp(`"${escapeRe(section)}"\\s*:`)));
    for (const [name, schema] of Object.entries(sec)) {
      if (!isObj(schema) || doc.defs.some((d) => d.id === `${file}#def:${name}`)) continue;
      const line = lineOf(lines, new RegExp(`"${escapeRe(name)}"\\s*:`), defsLine);
      doc.defs.push(makeDef(file, lines, name, name, schema, line, false));
    }
  }
  return doc;
}

/** The schema's own type, as a short label: a $ref shows the name it points at. */
function typeOf(s: unknown): string {
  if (!isObj(s)) return "any";
  if (typeof s.$ref === "string") return `$ref ${s.$ref.split("/").pop() ?? s.$ref}`;
  if (Array.isArray(s.enum)) return "enum";
  if (typeof s.type === "string") return s.type;
  if (Array.isArray(s.type)) return s.type.join("|");
  if (s.items !== undefined) {
    const it = typeOf(s.items);
    return it === "any" ? "array" : `${it.replace(/^\$ref /, "")}[]`;
  }
  if (s.oneOf !== undefined) return "oneOf";
  if (s.anyOf !== undefined) return "anyOf";
  return "any";
}

/** The enum values of a schema, or of the items of an array schema. */
function enumOf(s: unknown): string[] | undefined {
  if (!isObj(s)) return undefined;
  if (Array.isArray(s.enum)) return s.enum.map((x) => String(x));
  if (isObj(s.items)) return enumOf(s.items);
  const alt = Array.isArray(s.oneOf) ? s.oneOf : Array.isArray(s.anyOf) ? s.anyOf : [];
  const consts = alt.filter((x): x is Schema => isObj(x) && x.const !== undefined).map((x) => String(x.const));
  return consts.length > 0 && consts.length === alt.length ? consts : undefined;
}

/** Every $ref under a schema node. With skipTopProps, the top level's own `properties` is left out (props carry their own). */
function collectRefs(node: unknown, skipTopProps: boolean): string[] {
  const out: string[] = [];
  const walk = (v: unknown, top: boolean): void => {
    if (Array.isArray(v)) {
      for (const x of v) walk(x, false);
      return;
    }
    if (!isObj(v)) return;
    for (const [k, x] of Object.entries(v)) {
      if (k === "$ref" && typeof x === "string") out.push(x);
      else if (top && k === "properties" && skipTopProps) continue;
      else if (top && (k === "$defs" || k === "definitions")) continue; // the definitions are indexed on their own
      else walk(x, false);
    }
  };
  walk(node, true);
  return out;
}

/** The text in a span's first line that the span names; used to size the uses-kind hits. */
interface Hit {
  kind: string;
  how: "emit" | "read";
  span: Span;
}

interface TsScan {
  files: string[];
  hits: Map<string, Hit[]>;
}

const TS_RE = /\.(?:tsx?|js|mjs|cjs)$/;
const TS_SKIP = /\/dist\/|\/node_modules\/|\/test\/|\.test\.|\/generated\//;
const KIND_TOKEN = /["'`]((?:structure|packaging|flow|calls|concurrency|sync|effects|state|x-[a-z0-9-]+)\.[a-z0-9-]+(?:\.[a-z0-9-]+)*)["'`]/g;
const EMIT_BEFORE = /kind\s*:\s*$/;
/** A positional emit call on the same line, e.g. emitNode(call, container, "sync", "sync.condvar", ...). */
const EMIT_CALL_BEFORE = /\bemit\w*\([^)]*$/;
/** Any call whose argument list is still open at the literal, e.g. flow(ctx, "flow.return", ...). */
const ANY_CALL_BEFORE = /[A-Za-z_$][\w$]*\([^()]*$/;
/** Comparison operands and `case` labels are reads, not emits. */
const COMPARE_BEFORE = /(?:===|!==|==|!=)\s*$|\bcase\s+$/;
/** Query and read helpers: a kind passed to one of these is looked up, not produced. */
const READ_CALL_BEFORE = /(?:\.(?:includes|has|get|filter|find|some|every|indexOf|startsWith|delete)|\b(?:nodesOfKind|edgesOfKind|byKind|ofKind|isKind|hasKind))\([^()]*$/;

/** Scans the TypeScript and JavaScript files under packages/ and apps/ for quoted kind names. Each file keeps one hit per (kind, how). */
async function scanTs(ctx: ExtractContext): Promise<TsScan> {
  const files = ctx
    .listFiles()
    .filter((f) => (f.startsWith("packages/") || f.startsWith("apps/")) && TS_RE.test(f) && !TS_SKIP.test(`/${f}`) && !f.startsWith("packages/frontend/jsonschema/"));
  const hits = new Map<string, Hit[]>();
  for (const f of files) {
    let text: string;
    try {
      text = await ctx.readFile(f);
    } catch {
      continue;
    }
    const starts = [0];
    for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
    /** Index of the last line start at or before `idx`. */
    const lineAt = (idx: number): number => {
      let lo = 0;
      let hi = starts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if ((starts[mid] as number) <= idx) lo = mid;
        else hi = mid - 1;
      }
      return lo;
    };
    const seen = new Set<string>();
    const out: Hit[] = [];
    for (const m of text.matchAll(KIND_TOKEN)) {
      const kind = m[1] ?? "";
      const idx = m.index ?? 0;
      const line = lineAt(idx);
      const lineStart = starts[line] as number;
      const linePrefix = text.slice(lineStart, idx);
      const how: "emit" | "read" =
        EMIT_BEFORE.test(text.slice(Math.max(0, idx - 40), idx)) ||
        EMIT_CALL_BEFORE.test(linePrefix) ||
        (ANY_CALL_BEFORE.test(linePrefix) && !COMPARE_BEFORE.test(linePrefix) && !READ_CALL_BEFORE.test(linePrefix))
          ? "emit"
          : "read";
      const key = `${kind}|${how}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const col = idx - lineStart;
      out.push({ kind, how, span: { file: f, start: [line, col], end: [line, col + m[0].length] } });
    }
    if (out.length > 0) hits.set(f, out);
  }
  return { files, hits };
}

/** Cross-file indexes shared by every batch of one run. */
interface Run {
  byId: Map<string, string>;
  defById: Map<string, Def>;
  kindIdByName: Map<string, string>;
  /** The file that declares each kind name (first in sorted order). */
  kindFileByName: Map<string, string>;
  kindsFiles: string[];
  /** Every JSON file the run loaded: what a failed $id lookup could be satisfied by if one of them changed. */
  allDocFiles: string[];
  /** Files that must be re-extracted together when a duplicate $id appears, changes or goes away. */
  dupDeps: Map<string, Set<string>>;
}

function buildBatch(doc: Doc, run: Run, ts: TsScan | undefined, ctx: ExtractContext, dupId?: string): IRBatch {
  const { byId, defById, kindIdByName } = run;
  const records: IRRecord[] = [];
  const { file, lines } = doc;
  /** Schema files this file points into, including expected paths that do not exist yet. */
  const imported = new Set<string>();
  /** Set when an $id-based lookup failed: any schema file could satisfy it later. */
  let dependOnAll = false;

  // Unparseable, oversized, ignored or non-schema JSON yields nothing.
  if (doc.error !== undefined || doc.cls === "other") return { file, records };

  const node = (id: string, parent: string, kind: string, attrs: Schema, span: Span) =>
    records.push({ node: { id, facet: "structure", kind, attrs, parent, span, provenance: prov("exact") } });
  const xEdge = (from: string, to: string | { unresolved: { scheme: string; text: string } }, kind: string, attrs?: Schema, span?: Span) =>
    records.push({
      edge: {
        from,
        to,
        facet: "x-schema",
        kind,
        provenance: prov(kind === "x-schema.uses-kind" ? "heuristic" : "exact"),
        ...(attrs ? { attrs } : {}),
        ...(span ? { span } : {}),
      },
    } as IRRecord);

  /** Resolves a $ref; logs and returns undefined when it cannot. Every cross-file target, found or not, is recorded as a dependency. */
  const resolve = (ref: string, from: string, fromPropName: string): string | undefined => {
    const hash = ref.indexOf("#");
    const doc0 = normId(hash < 0 ? ref : ref.slice(0, hash));
    const frag = hash < 0 ? "" : ref.slice(hash + 1);
    let targetFile: string | undefined;
    if (doc0 === "") targetFile = file;
    else {
      targetFile = byId.get(doc0);
      if (targetFile === undefined && absoluteMiss(doc0)) dependOnAll = true;
      if (targetFile === undefined && !/^[a-z][a-z0-9+.-]*:/i.test(doc0)) {
        const rel = posix.normalize(posix.join(posix.dirname(file), doc0));
        if (!rel.startsWith("..")) targetFile = rel;
      }
    }
    // A target that does not resolve yet still counts: adding the file later re-extracts this one.
    if (targetFile !== undefined && targetFile !== file) imported.add(targetFile);
    const key =
      frag === "" || frag === "/"
        ? "$root"
        : frag.startsWith("/$defs/")
          ? frag.slice("/$defs/".length)
          : frag.startsWith("/definitions/")
            ? frag.slice("/definitions/".length)
            : undefined;
    const id = targetFile !== undefined && key !== undefined ? `${targetFile}#def:${key.replace(/~1/g, "/").replace(/~0/g, "~")}` : undefined;
    if (id === undefined || targetFile === undefined || !defById.has(id)) {
      ctx.log(`${file}: unresolved $ref "${ref}"${fromPropName ? ` in ${fromPropName}` : ""} (${from})`);
      return undefined;
    }
    return id;
  };

  if (doc.kinds.length === 0) {
    if (dupId !== undefined) {
      const line = Math.max(0, lineOf(lines, /"\$id"\s*:/));
      records.push({ finding: { severity: "warning", message: dupId, span: spanAt(file, lines, line), provenance: prov("exact") } });
    }
    for (const def of doc.defs) {
      const defAttrs: Schema = { name: def.name, typeKind: "struct" };
      if (def.root && doc.schemaId) defAttrs.schemaId = doc.schemaId;
      if (typeof def.schema.description === "string") defAttrs.description = def.schema.description;
      node(def.id, file, "x-schema.def", defAttrs, spanAt(file, lines, def.line));

      const dedupe = new Set<string>();
      for (const ref of collectRefs(def.schema, true)) {
        const to = resolve(ref, def.id, "");
        if (to !== undefined && !dedupe.has(to)) {
          dedupe.add(to);
          xEdge(def.id, to, "x-schema.ref");
        }
      }
      for (const prop of def.props) {
        const pattrs: Schema = { name: prop.name, type: typeOf(prop.schema), required: prop.required };
        if (isObj(prop.schema) && typeof prop.schema.description === "string") pattrs.description = prop.schema.description;
        const en = enumOf(prop.schema);
        if (en) pattrs.enum = en;
        node(prop.id, def.id, "x-schema.property", pattrs, spanAt(file, lines, prop.line));
        const pdedupe = new Set<string>();
        for (const ref of collectRefs(prop.schema, false)) {
          const to = resolve(ref, prop.id, prop.name);
          if (to !== undefined && !pdedupe.has(to)) {
            pdedupe.add(to);
            xEdge(prop.id, to, "x-schema.ref");
          }
        }
      }
    }
    for (const d of run.dupDeps.get(file) ?? []) imported.add(d);
    if (dependOnAll) for (const f of run.allDocFiles) if (f !== file) imported.add(f);
    return { file, records, ...(imported.size > 0 ? { dependsOn: [...imported].sort() } : {}) };
  }

  // A kinds file: one x-schema.kind per declared kind.
  for (const k of doc.kinds) {
    const e = k.entry;
    const kattrs: Schema = { name: k.name, typeKind: "struct", facet: String(e.facet ?? ""), on: String(e.on ?? "") };
    if (typeof e.description === "string") kattrs.description = e.description;
    node(k.id, file, "x-schema.kind", kattrs, spanAt(file, lines, k.line));

    if (isObj(e.attrs) && typeof e.attrs.$ref === "string") {
      const to = resolve(e.attrs.$ref, k.id, `${k.name}.attrs`);
      if (to !== undefined) xEdge(k.id, to, "x-schema.attrs");
    }
    if (isObj(e.attrs) && isObj(e.attrs.properties)) {
      // Inline attrs (plugin kinds): the properties hang directly off the kind.
      const req = Array.isArray(e.attrs.required) ? e.attrs.required.filter((x): x is string => typeof x === "string") : [];
      for (const [pn, ps] of Object.entries(e.attrs.properties)) {
        const pl = lineOf(lines, new RegExp(`"${escapeRe(pn)}"\\s*:`), k.line);
        const pattrs: Schema = { name: pn, type: typeOf(ps), required: req.includes(pn) };
        if (isObj(ps) && typeof ps.description === "string") pattrs.description = ps.description;
        const en = enumOf(ps);
        if (en) pattrs.enum = en;
        node(`${k.id}/prop:${pn}`, k.id, "x-schema.property", pattrs, spanAt(file, lines, pl < 0 ? k.line : pl));
      }
    }
    if (typeof e.extends === "string") {
      const parent = kindIdByName.get(e.extends);
      const parentFile = run.kindFileByName.get(e.extends);
      if (parent !== undefined) {
        xEdge(k.id, parent, "x-schema.extends");
        if (parentFile !== undefined && parentFile !== file) imported.add(parentFile);
      } else {
        // Unresolved: a rename or addition in any kinds file could resolve it.
        for (const f of run.kindsFiles) if (f !== file) imported.add(f);
        xEdge(k.id, { unresolved: { scheme: "x-schema.kind", text: e.extends } }, "x-schema.extends");
      }
    }
  }

  // uses-kind: a TypeScript file that names one of this file's kinds.
  const declared = new Map(doc.kinds.map((k) => [k.name, k.id] as const));
  for (const [tsFile, hits] of ts?.hits ?? []) {
    for (const hit of hits) {
      const kid = declared.get(hit.kind);
      if (kid === undefined) continue;
      xEdge(tsFile, kid, "x-schema.uses-kind", { how: hit.how }, hit.span);
    }
  }
  const deps = [
    ...new Set([
      ...(ts?.files ?? []),
      ...imported,
      ...(run.dupDeps.get(file) ?? []),
      ...(dependOnAll ? run.allDocFiles.filter((f) => f !== file) : []),
    ]),
  ].sort();
  return { file, records, ...(deps.length > 0 ? { dependsOn: deps } : {}) };
}

/** A schema-bearing document by file: its root def id is `${file}#def:$root`. */
function rootId(file: string): string {
  return `${file}#def:$root`;
}

/** The instance's validated-by edge or "unknown $schema" finding. Empty when the file follows no known schema. */
function buildInstance(doc: Doc, byId: Map<string, string>, schemaFiles: Set<string>, allDocFiles: string[]): IRBatch {
  const { file, lines } = doc;
  const records: IRRecord[] = [];
  const ds = doc.dollarSchema;
  let target: string | undefined;
  let via: "$schema" | "filename" = "$schema";
  let finding: string | undefined;
  let missing: string | undefined;
  let dependOnAll = false;
  if (ds !== undefined) {
    const bare = normId(ds);
    target = byId.get(bare) ?? byId.get(ds);
    if (target === undefined && absoluteMiss(ds)) dependOnAll = true;
    if (target === undefined && !/^[a-z][a-z0-9+.-]*:/i.test(ds)) {
      const rel = posix.normalize(posix.join(posix.dirname(file), bare));
      if (schemaFiles.has(rel)) target = rel;
      else {
        if (!fixturePath(file)) finding = `unknown $schema "${ds}" (no schema file at ${rel})`;
        if (!rel.startsWith("..")) missing = rel;
      }
    }
  }
  if (target === undefined && finding === undefined) {
    const id = filenameSchemaId(file);
    const f = id !== undefined ? byId.get(id) : undefined;
    if (id !== undefined && f === undefined) dependOnAll = true;
    if (f !== undefined) {
      target = f;
      via = "filename";
    }
  }
  if (finding !== undefined) {
    const line = Math.max(0, lineOf(lines, /"\$schema"\s*:/));
    records.push({ finding: { severity: "info", message: finding, span: spanAt(file, lines, line), provenance: prov("exact") } });
    const fdeps = new Set<string>(dependOnAll ? allDocFiles.filter((f) => f !== file) : []);
    if (missing !== undefined) fdeps.add(missing);
    return { file, records, ...(fdeps.size > 0 ? { dependsOn: [...fdeps].sort() } : {}) };
  }
  if (target === undefined) {
    const nd = dependOnAll ? allDocFiles.filter((f) => f !== file).sort() : [];
    return { file, records, ...(nd.length > 0 ? { dependsOn: nd } : {}) };
  }
  const line = via === "$schema" ? Math.max(0, lineOf(lines, /"\$schema"\s*:/)) : 0;
  records.push({
    edge: {
      from: file,
      to: rootId(target),
      facet: "x-schema",
      kind: "x-schema.validated-by",
      attrs: { via },
      span: spanAt(file, lines, line),
      provenance: prov(via === "filename" ? "inferred" : "exact"),
    },
  } as IRRecord);
  return { file, records, dependsOn: [target] };
}

/**
 * True when the project has a schema or kinds file. Two bounded passes over one walk: a name-only check that stops at
 * the first hit, then (if the names found nothing) a content check of at most MAX_READ_FILES small JSON files.
 */
function walkForSchemas(root: string): { hit: string | null; capped: boolean; walkCapped?: boolean } {
  let seen = 0;
  const jsonFiles: string[] = [];
  const stack: string[] = [""];
  while (stack.length > 0 && seen <= MAX_WALK_FILES) {
    const rel = stack.pop() as string;
    let entries;
    try {
      entries = readdirSync(rel === "" ? root : join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const childRel = rel === "" ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) {
        if (!IGNORED_DIRS.has(e.name)) stack.push(childRel);
      } else if (e.isFile() && e.name.endsWith(".json")) {
        seen++;
        if (fixturePath(childRel)) continue;
        if (SCHEMA_NAME_RE.test(childRel)) return { hit: childRel, capped: false };
        jsonFiles.push(childRel);
      }
    }
  }
  const walkCapped = stack.length > 0 && seen > MAX_WALK_FILES;
  let read = 0;
  for (const childRel of jsonFiles) {
    if (read >= MAX_READ_FILES) return { hit: null, capped: true, walkCapped };
    try {
      const abs = join(root, childRel);
      if (statSync(abs).size > MAX_BYTES) continue;
      read++;
      const text = readFileSync(abs, "utf8");
      if (!CANDIDATE_RE.test(text)) continue;
      if (classifyJson(JSON.parse(text)) !== "other") return { hit: childRel, capped: false };
    } catch {
      // unreadable or not JSON
    }
  }
  return { hit: null, capped: false, walkCapped };
}

export const frontend: Frontend = {
  id: FRONTEND_ID,
  version: "0.2.0",
  provides: ["structure", "x-schema"],

  async detect(root: ProjectRoot): Promise<Detection | null> {
    if (existsSync(join(root.path, KINDS_FILE))) return { reason: `found ${KINDS_FILE}` };
    const { hit, capped, walkCapped } = walkForSchemas(root.path);
    if (hit === null && walkCapped) process.stderr.write(`${FRONTEND_ID}: directory walk stopped after ${MAX_WALK_FILES} JSON files, so a schema further on was not looked for\n`);
    if (hit === null && capped) process.stderr.write(`${FRONTEND_ID}: no schema file by name; content scan stopped after ${MAX_READ_FILES} JSON files, so a schema further on was not looked for\n`);
    return hit !== null ? { reason: `found JSON Schema or kinds file ${hit}` } : null;
  },

  async *extract(ctx: ExtractContext): AsyncIterable<IRBatch> {
    // First pass: read and parse every JSON file of the project (not only ctx.files, so an incremental run still
    // sees the schemas that instances and $refs point at) and build the cross-file indexes.
    const docs = new Map<string, Doc>();
    const load = async (file: string): Promise<void> => {
      if (docs.has(file)) return;
      let text: string;
      try {
        const abs = join(ctx.root.path, file);
        if (statSync(abs).size > MAX_BYTES) {
          docs.set(file, { file, lines: [], cls: "other", defs: [], kinds: [] });
          return;
        }
        text = await ctx.readFile(file);
      } catch (err) {
        docs.set(file, { file, lines: [], cls: "other", defs: [], kinds: [], error: (err as Error).message });
        return;
      }
      // Cheap prefilter: skip the split and parse unless the text could be a schema, a kinds file or an instance.
      if (!CANDIDATE_RE.test(text) && filenameSchemaId(file) === undefined) {
        docs.set(file, { file, lines: [], cls: "other", defs: [], kinds: [] });
        return;
      }
      docs.set(file, parseDoc(file, text));
    };
    for (const file of ctx.files) await load(file);
    for (const file of ctx.listFiles()) if (file.endsWith(".json") && !ignoredPath(file) && !fixturePath(file)) await load(file);
    const byId = new Map<string, string>();
    const defById = new Map<string, Def>();
    const kindIdByName = new Map<string, string>();
    const schemaFiles = new Set<string>();
    const dupIds = new Map<string, string>();
    const dupDeps = new Map<string, Set<string>>();
    const kindFileByName = new Map<string, string>();
    const kindsFiles: string[] = [];
    const link = (a: string, b: string): void => {
      if (!dupDeps.has(a)) dupDeps.set(a, new Set());
      dupDeps.get(a)?.add(b);
    };
    for (const d of [...docs.values()].sort((x, y) => (x.file < y.file ? -1 : x.file > y.file ? 1 : 0))) {
      if (d.schemaId !== undefined) {
        const first = byId.get(d.schemaId);
        if (first === undefined) byId.set(d.schemaId, d.file);
        else {
          dupIds.set(d.file, `duplicate $id ${d.schemaId} (also declared in ${first})`);
          link(d.file, first);
          link(first, d.file);
        }
      }
      if (d.cls === "schema") schemaFiles.add(d.file);
      for (const def of d.defs) defById.set(def.id, def);
      if (d.kinds.length > 0) kindsFiles.push(d.file);
      for (const k of d.kinds)
        if (!kindIdByName.has(k.name)) {
          kindIdByName.set(k.name, k.id);
          kindFileByName.set(k.name, d.file);
        }
    }

    const allDocFiles = [...docs.keys()].sort();
    const run: Run = { byId, defById, kindIdByName, kindFileByName, kindsFiles, allDocFiles, dupDeps };

    // Second pass: exactly one batch per requested file.
    let scan: TsScan | undefined;
    for (const file of ctx.files) {
      const doc = docs.get(file);
      if (!doc) {
        yield { file, records: [] };
        continue;
      }
      // An unparseable file can still follow a schema by name (*.ir.json is newline-delimited JSON).
      if (doc.cls === "other" && (doc.error === undefined || filenameSchemaId(file) !== undefined)) {
        yield buildInstance(doc, byId, schemaFiles, allDocFiles);
        continue;
      }
      if (doc.kinds.length > 0 && scan === undefined) scan = await scanTs(ctx);
      yield buildBatch(doc, run, doc.kinds.length > 0 ? scan : undefined, ctx, dupIds.get(file));
    }
  },
};

export default frontend;
