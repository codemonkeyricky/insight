import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Detection, ExtractContext, Frontend, IRBatch, IRRecord, ProjectRoot } from "@insight/sdk";

/**
 * POC frontend for Insight's own IR JSON Schema files. It reads every schema document and kinds file it is given,
 * turns each $defs entry and each kinds entry into structure nodes, and links $refs, kinds to their attrs schemas,
 * kinds to their parents, and TypeScript files to the kinds they emit or read. Spans come from a text search, so
 * they are heuristics.
 */

const FRONTEND_ID = "frontend-jsonschema";
const KINDS_FILE = "packages/core/ir/schema/core.kinds.json";

type Schema = Record<string, unknown>;
type Span = { file: string; start: [number, number]; end: [number, number] };

const isObj = (v: unknown): v is Schema => typeof v === "object" && v !== null && !Array.isArray(v);
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const prov = (confidence: "exact" | "heuristic") => ({ frontend: FRONTEND_ID, confidence });

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
  const doc: Doc = { file, lines, defs: [], kinds: [] };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    doc.error = (err as Error).message;
    return doc;
  }
  if (Array.isArray(json)) {
    for (const entry of json) {
      if (!isObj(entry) || typeof entry.kind !== "string") continue;
      const name = entry.kind;
      const line = lineOf(lines, new RegExp(`"kind"\\s*:\\s*"${escapeRe(name)}"`));
      doc.kinds.push({ id: `${file}#kind:${name}`, file, name, entry, line: Math.max(0, line) });
    }
    return doc;
  }
  if (!isObj(json)) return doc;
  if (typeof json.$id === "string") doc.schemaId = json.$id;
  const title = typeof json.title === "string" ? json.title : (file.split("/").pop() ?? file);
  doc.defs.push(makeDef(file, lines, "$root", title, json, 0, true));
  const defsLine = Math.max(0, lineOf(lines, /"\$defs"\s*:/));
  if (isObj(json.$defs)) {
    for (const [name, schema] of Object.entries(json.$defs)) {
      if (!isObj(schema)) continue;
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
  if (s.items !== undefined) return "array";
  if (s.oneOf !== undefined) return "oneOf";
  if (s.anyOf !== undefined) return "anyOf";
  return "any";
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

const TS_RE = /\.tsx?$/;
const TS_SKIP = /\/dist\/|\/node_modules\/|\/test\/|\.test\.|\/generated\//;
const KIND_TOKEN = /["'`]((?:structure|packaging|flow|calls|concurrency|sync|effects|state|x-[a-z0-9-]+)\.[a-z0-9-]+(?:\.[a-z0-9-]+)*)["'`]/g;
const EMIT_BEFORE = /kind\s*:\s*$/;

/** Scans the TypeScript files under packages/ and apps/ for quoted kind names. Each file keeps one hit per (kind, how). */
async function scanTs(ctx: ExtractContext): Promise<TsScan> {
  const files = ctx
    .listFiles()
    .filter((f) => (f.startsWith("packages/") || f.startsWith("apps/")) && TS_RE.test(f) && !TS_SKIP.test(`/${f}`));
  const hits = new Map<string, Hit[]>();
  for (const f of files) {
    let text: string;
    try {
      text = await ctx.readFile(f);
    } catch {
      continue;
    }
    const seen = new Set<string>();
    const out: Hit[] = [];
    for (const m of text.matchAll(KIND_TOKEN)) {
      const kind = m[1] ?? "";
      const idx = m.index ?? 0;
      const how: "emit" | "read" = EMIT_BEFORE.test(text.slice(Math.max(0, idx - 40), idx)) ? "emit" : "read";
      const key = `${kind}|${how}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const before = text.slice(0, idx);
      const line = before.split("\n").length - 1;
      const col = idx - (before.lastIndexOf("\n") + 1);
      out.push({ kind, how, span: { file: f, start: [line, col], end: [line, col + m[0].length] } });
    }
    if (out.length > 0) hits.set(f, out);
  }
  return { files, hits };
}

function buildBatch(doc: Doc, byId: Map<string, string>, defById: Map<string, Def>, kindIdByName: Map<string, string>, ts: TsScan | undefined, ctx: ExtractContext): IRBatch {
  const records: IRRecord[] = [];
  const { file, lines } = doc;

  if (doc.error !== undefined) {
    records.push({ finding: { severity: "warning", message: `not valid JSON: ${doc.error}`, span: spanAt(file, lines, 0), provenance: prov("exact") } });
    return { file, records };
  }

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

  /** Resolves a $ref; logs and returns undefined when it cannot. Cross-file refs also get a packaging.import edge. */
  const seenImports = new Set<string>();
  const resolve = (ref: string, from: string, fromPropName: string): string | undefined => {
    const hash = ref.indexOf("#");
    const doc0 = hash < 0 ? ref : ref.slice(0, hash);
    const frag = hash < 0 ? "" : ref.slice(hash + 1);
    const targetFile = doc0 === "" ? file : byId.get(doc0);
    const key = frag === "" ? "$root" : frag.startsWith("/$defs/") ? frag.slice("/$defs/".length) : undefined;
    const id = targetFile !== undefined && key !== undefined ? `${targetFile}#def:${key}` : undefined;
    if (id === undefined || targetFile === undefined || !defById.has(id)) {
      ctx.log(`${file}: unresolved $ref "${ref}"${fromPropName ? ` in ${fromPropName}` : ""} (${from})`);
      return undefined;
    }
    if (targetFile !== file && !seenImports.has(targetFile)) {
      seenImports.add(targetFile);
      records.push({
        edge: { from: file, to: targetFile, facet: "packaging", kind: "packaging.import", attrs: { specifier: doc0 }, provenance: prov("exact") },
      } as IRRecord);
    }
    return id;
  };

  if (doc.kinds.length === 0) {
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
    return { file, records };
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
    if (typeof e.extends === "string") {
      const parent = kindIdByName.get(e.extends);
      if (parent !== undefined) xEdge(k.id, parent, "x-schema.extends");
      else xEdge(k.id, { unresolved: { scheme: "x-schema.kind", text: e.extends } }, "x-schema.extends");
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
  return { file, records, ...(ts ? { dependsOn: ts.files } : {}) };
}

export const frontend: Frontend = {
  id: FRONTEND_ID,
  version: "0.1.0",
  provides: ["structure", "packaging", "x-schema"],

  async detect(root: ProjectRoot): Promise<Detection | null> {
    return existsSync(join(root.path, KINDS_FILE)) ? { reason: `found ${KINDS_FILE}` } : null;
  },

  async *extract(ctx: ExtractContext): AsyncIterable<IRBatch> {
    // First pass: read and parse every file, and build the cross-file indexes.
    const docs = new Map<string, Doc>();
    for (const file of ctx.files) {
      let text: string;
      try {
        text = await ctx.readFile(file);
      } catch (err) {
        docs.set(file, { file, lines: [], defs: [], kinds: [], error: (err as Error).message });
        continue;
      }
      docs.set(file, parseDoc(file, text));
    }
    const byId = new Map<string, string>();
    const defById = new Map<string, Def>();
    const kindIdByName = new Map<string, string>();
    for (const d of docs.values()) {
      if (d.schemaId !== undefined) byId.set(d.schemaId, d.file);
      for (const def of d.defs) defById.set(def.id, def);
      for (const k of d.kinds) if (!kindIdByName.has(k.name)) kindIdByName.set(k.name, k.id);
    }

    // Second pass: one batch per file.
    let scan: TsScan | undefined;
    for (const file of ctx.files) {
      const doc = docs.get(file);
      if (!doc) continue;
      if (doc.kinds.length > 0 && scan === undefined) scan = await scanTs(ctx);
      yield buildBatch(doc, byId, defById, kindIdByName, doc.kinds.length > 0 ? scan : undefined, ctx);
    }
  },
};

export default frontend;
