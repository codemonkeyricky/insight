import { edgeTargets, type IRView, type Lens, type LensFinding, type LensResult, type LensView, type SchemaDiagramView, type SchemaEntity, type SchemaField, type TableView, type ViewSpan } from "@insight/sdk";
import type { IREdge, IRNode } from "@insight/ir";

const LENS_ID = "lens-ir-schema";
const KIND = "x-schema.kind";
const DEF = "x-schema.def";
const PROP = "x-schema.property";
const VALIDATED = "x-schema.validated-by";

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const nameOf = (n: IRNode | undefined): string => str(n?.attrs.name);

/** The package a TypeScript file belongs to: packages/<group>/<name> -> <group>/<name>, apps/<name> -> apps/<name>. */
function pkgOf(file: string): string {
  const p = file.split("/");
  if (p[0] === "packages" && p.length >= 3) return `${p[1]}/${p[2]}`;
  if (p[0] === "apps" && p.length >= 2) return `apps/${p[1]}`;
  return file;
}

function unresolvedText(e: IREdge): string {
  const to = e.to as unknown;
  if (typeof to === "object" && to !== null && "unresolved" in to) {
    return String((to as { unresolved: { text: string } }).unresolved.text);
  }
  return "";
}

export const lensIrSchema: Lens = {
  id: LENS_ID,
  title: "Schema",
  requires: ["structure", "x-schema"],

  async run(ir: IRView): Promise<LensResult> {
    const kinds = ir.nodes({ kind: KIND }).sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
    const defs = ir.nodes({ kind: DEF });
    const props = ir.nodes({ kind: PROP });
    const attrsEdges = ir.edges({ kind: "x-schema.attrs" });
    const extendsEdges = ir.edges({ kind: "x-schema.extends" });
    const usesEdges = ir.edges({ kind: "x-schema.uses-kind" });
    const refEdges = ir.edges({ kind: "x-schema.ref" });
    const validatedEdges = ir.edges({ kind: VALIDATED });

    const nodeName = (id: string): string => nameOf(ir.node(id));
    const targetOf = (e: IREdge): string | undefined => edgeTargets(e).nodes[0];

    const attrsDef = new Map<string, string>();
    for (const e of attrsEdges) {
      const t = targetOf(e);
      if (t !== undefined) attrsDef.set(e.from, t);
    }
    const extendsOf = new Map<string, string>();
    for (const e of extendsEdges) {
      const t = targetOf(e);
      const name = t !== undefined ? nodeName(t) : unresolvedText(e);
      if (name) extendsOf.set(e.from, name);
    }
    const emitBy = new Map<string, Set<string>>();
    const readBy = new Map<string, Set<string>>();
    for (const e of usesEdges) {
      const t = targetOf(e);
      if (t === undefined) continue;
      const map = str(e.attrs?.how) === "emit" ? emitBy : readBy;
      const set = map.get(t) ?? new Set<string>();
      set.add(pkgOf(e.from));
      map.set(t, set);
    }
    const list = (m: Map<string, Set<string>>, id: string): string | null => {
      const s = m.get(id);
      return s && s.size > 0 ? [...s].sort().join(", ") : null;
    };

    // Required and optional attrs: the property children of the attrs def.
    const propNames = (defId: string | undefined, required: boolean): string[] => {
      if (defId === undefined) return [];
      return ir
        .children(defId, { kind: PROP })
        .filter((p) => (p.attrs.required === true) === required)
        .map((p) => str(p.attrs.name))
        .sort();
    };

    // Table: one row per kind.
    const columns = ["Kind", "Facet", "On", "Emitted by", "Read by", "Required attrs", "Optional attrs", "Extends", "Attrs def", "Description"];
    const rows: TableView["rows"] = [];
    const spans: (ViewSpan | null)[] = [];
    for (const k of kinds) {
      const defId = attrsDef.get(k.id);
      const req = propNames(defId, true);
      const opt = propNames(defId, false);
      rows.push([
        nameOf(k),
        str(k.attrs.facet),
        str(k.attrs.on),
        list(emitBy, k.id),
        list(readBy, k.id),
        req.length > 0 ? req.join(", ") : null,
        opt.length > 0 ? opt.join(", ") : null,
        extendsOf.get(k.id) ?? null,
        defId !== undefined ? nodeName(defId) : null,
        str(k.attrs.description) || null,
      ]);
      spans.push(k.span ?? null);
    }
    const table: TableView = { type: "table", id: "kinds", title: "Kinds", columns, rows, spans };

    // Diagram 1: every kind as a card, framed by facet; `extends` joins kinds.
    const propFields = (parentId: string | undefined): SchemaField[] => {
      if (parentId === undefined) return [];
      return ir.children(parentId, { kind: PROP }).map((p) => {
        const values = Array.isArray(p.attrs.enum) ? (p.attrs.enum as unknown[]).map(String) : undefined;
        const description = str(p.attrs.description);
        return {
          name: str(p.attrs.name),
          type: str(p.attrs.type) || "any",
          required: p.attrs.required === true,
          ...(values && values.length > 0 ? { values } : {}),
          ...(description ? { description } : {}),
        };
      });
    };
    const facetOrder = ["structure", "packaging", "flow", "calls", "concurrency", "sync", "effects", "state"];
    const presentFacets = [...new Set(kinds.map((k) => str(k.attrs.facet)))];
    const facets = [...facetOrder.filter((f) => presentFacets.includes(f)), ...presentFacets.filter((f) => !facetOrder.includes(f)).sort()];
    const kindEntities: SchemaEntity[] = kinds.map((k) => {
      const defId = attrsDef.get(k.id);
      const ext = extendsOf.get(k.id);
      const description = str(k.attrs.description);
      return {
        id: k.id,
        label: nameOf(k),
        group: str(k.attrs.facet),
        role: str(k.attrs.on) === "edge" ? "edge-kind" : "node-kind",
        ...(ext ? { extends: ext } : {}),
        ...(description ? { description } : {}),
        ...(k.span ? { span: k.span } : {}),
        fields: propFields(defId ?? k.id),
      };
    });
    const kindLinks: SchemaDiagramView["links"] = [];
    for (const e of extendsEdges) {
      const t = targetOf(e);
      if (t !== undefined) kindLinks.push({ from: e.from, to: t, kind: "extends" });
    }
    const kindsDiagram: SchemaDiagramView = {
      type: "schema-diagram",
      id: "kinds-diagram",
      title: "Kinds",
      groups: facets.map((f) => ({ id: f, label: f })),
      entities: kindEntities,
      links: kindLinks,
    };

    // Instances: data files that follow a schema, keyed by the schema's root def.
    const instancesOf = new Map<string, Set<string>>();
    for (const e of validatedEdges) {
      const t = targetOf(e);
      if (t === undefined) continue;
      const set = instancesOf.get(t) ?? new Set<string>();
      set.add(e.from);
      instancesOf.set(t, set);
    }
    const fileOfDef = (d: IRNode): string => (d.id.split("#def:")[0] ?? d.id);
    const isRoot = (d: IRNode): boolean => d.id.endsWith("#def:$root");

    // Diagram 2: every schema file's definitions as cards, one frame per file, and the $refs between them.
    const schemaDefs = [...defs].sort((a, b) => a.id.localeCompare(b.id));
    const schemaFiles = [...new Set(schemaDefs.map(fileOfDef))].sort((a, b) => a.localeCompare(b));
    const baseName = (f: string): string => f.split("/").pop() ?? f;
    const baseCount = new Map<string, number>();
    for (const f of schemaFiles) baseCount.set(baseName(f), (baseCount.get(baseName(f)) ?? 0) + 1);
    const fileLabel = (f: string): string => ((baseCount.get(baseName(f)) ?? 0) > 1 ? f : baseName(f));
    const defIds = new Set(schemaDefs.map((d) => d.id));
    const refsFrom = new Map<string, IREdge[]>();
    for (const e of refEdges) {
      const list2 = refsFrom.get(e.from);
      if (list2) list2.push(e);
      else refsFrom.set(e.from, [e]);
    }
    const refTargets = (id: string): string[] => {
      const out: string[] = [];
      for (const e of refsFrom.get(id) ?? []) {
        const t = targetOf(e);
        if (t !== undefined && defIds.has(t) && !out.includes(t)) out.push(t);
      }
      return out;
    };
    const recLinks: SchemaDiagramView["links"] = [];
    const recEntities: SchemaEntity[] = schemaDefs.map((d) => {
      const props2 = ir.children(d.id, { kind: PROP });
      let fields: SchemaField[];
      if (props2.length > 0) {
        const all = propFields(d.id);
        fields = props2.map((p) => {
          const f = all.find((x) => x.name === nameOf(p)) as SchemaField;
          const target = refTargets(p.id)[0];
          if (target !== undefined) {
            recLinks.push({ from: d.id, field: f.name, to: target, kind: "ref" });
            return { ...f, ref: target };
          }
          return f;
        });
      } else {
        fields = refTargets(d.id).map((t) => {
          recLinks.push({ from: d.id, field: nameOf(ir.node(t)), to: t, kind: "ref" });
          return { name: nameOf(ir.node(t)), type: "oneOf", required: false, ref: t };
        });
      }
      const description = str(d.attrs.description);
      const n = instancesOf.get(d.id)?.size ?? 0;
      return {
        id: d.id,
        label: nameOf(d),
        group: fileOfDef(d),
        role: "record",
        ...(description ? { description } : {}),
        ...(n > 0 && isRoot(d) ? { note: `validated by: ${n} file${n === 1 ? "" : "s"}` } : {}),
        ...(d.span ? { span: d.span } : {}),
        fields,
      };
    });
    const recordsDiagram: SchemaDiagramView = {
      type: "schema-diagram",
      id: "records-diagram",
      title: "Records",
      groups: schemaFiles.map((f) => ({ id: f, label: fileLabel(f) })),
      entities: recEntities,
      links: recLinks,
    };

    // Table: one row per schema file.
    const fileCols = ["schema file", "title", "$id", "defs", "instances", "instance files"];
    const fileRows: TableView["rows"] = [];
    const fileSpans: (ViewSpan | null)[] = [];
    for (const f of schemaFiles) {
      const root = schemaDefs.find((d) => d.id === `${f}#def:$root`);
      const inst = [...(instancesOf.get(`${f}#def:$root`) ?? [])].sort();
      const shown = inst.slice(0, 5).join(", ") + (inst.length > 5 ? ", …" : "");
      const title = root !== undefined && nameOf(root) !== baseName(f) ? nameOf(root) : null;
      fileRows.push([f, title, str(root?.attrs.schemaId) || null, schemaDefs.filter((d) => fileOfDef(d) === f && !isRoot(d)).length, inst.length, inst.length > 0 ? shown : null]);
      fileSpans.push(root?.span ?? null);
    }
    const filesTable: TableView = { type: "table", id: "schema-files", title: "Schema files", columns: fileCols, rows: fileRows, spans: fileSpans };

    // Findings.
    const findings: LensFinding[] = [];
    for (const k of kinds) {
      // The jsonschema frontend's own x-schema.* kinds are emitted by packages/frontend/jsonschema, which the TS scan skips
      // (it would otherwise match every kind name quoted in its own source), so they would always look unemitted.
      if (emitBy.has(k.id) || nameOf(k).startsWith("x-schema.")) continue;
      findings.push({
        lens: LENS_ID,
        id: `never-emitted:${nameOf(k)}`,
        severity: "info",
        message: `${nameOf(k)} is declared but no TypeScript file emits it (kinds emitted from data tables such as effects.json, or built dynamically, are not detected)`,
        nodes: [k.id],
        ...(k.span ? { span: k.span } : {}),
      });
    }
    const targeted = new Set<string>();
    for (const e of attrsEdges) {
      const t = targetOf(e);
      if (t !== undefined) targeted.add(t);
    }
    for (const e of refEdges) {
      const t = targetOf(e);
      if (t !== undefined) targeted.add(t);
    }
    for (const d of defs) {
      if (!d.id.includes("/facets/") || d.id.endsWith("#def:$root") || targeted.has(d.id)) continue;
      findings.push({
        lens: LENS_ID,
        id: `unused-def:${d.id}`,
        severity: "info",
        message: `${nameOf(d)} is not the attrs of any kind and no $ref points at it`,
        nodes: [d.id],
        ...(d.span ? { span: d.span } : {}),
      });
    }

    const views: LensView[] = [...(kinds.length > 0 ? [kindsDiagram] : []), ...(defs.length > 0 ? [recordsDiagram] : []), ...(kinds.length > 0 ? [table] : []), ...(schemaFiles.length > 0 ? [filesTable] : [])];
    const emitted = kinds.filter((k) => emitBy.has(k.id)).length;
    const neverEmitted = kinds.filter((k) => !emitBy.has(k.id) && !nameOf(k).startsWith("x-schema.")).length;
    const metrics = {
      kinds: kinds.length,
      facets: new Set(kinds.map((k) => str(k.attrs.facet))).size,
      defs: defs.length,
      properties: props.length,
      emitted,
      neverEmitted,
      readers: kinds.filter((k) => readBy.has(k.id)).length,
      schemaFiles: schemaFiles.length,
      instances: new Set(validatedEdges.map((e) => e.from)).size,
    };
    return { findings, views, metrics };
  },
};

export default lensIrSchema;
