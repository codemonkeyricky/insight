import { edgeTargets, type GraphView, type IRView, type Lens, type LensFinding, type LensResult, type LensView, type TableView, type ViewSpan } from "@insight/sdk";
import type { IREdge, IRNode } from "@insight/ir";

const LENS_ID = "lens-ir-schema";
const KIND = "x-schema.kind";
const DEF = "x-schema.def";
const PROP = "x-schema.property";
const CORE_FILE = "packages/core/ir/schema/core.schema.json";

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
  title: "IR schema",
  requires: ["structure", "x-schema"],

  async run(ir: IRView): Promise<LensResult> {
    const kinds = ir.nodes({ kind: KIND }).sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
    const defs = ir.nodes({ kind: DEF });
    const props = ir.nodes({ kind: PROP });
    const attrsEdges = ir.edges({ kind: "x-schema.attrs" });
    const extendsEdges = ir.edges({ kind: "x-schema.extends" });
    const usesEdges = ir.edges({ kind: "x-schema.uses-kind" });
    const refEdges = ir.edges({ kind: "x-schema.ref" });

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

    // Graphs: one per facet. Nodes are that facet's kinds and the packages that emit or read them; edges are
    // package -> kind (emits / reads) and extends between kinds of the facet.
    const facetOf = new Map<string, string>();
    for (const k of kinds) facetOf.set(k.id, str(k.attrs.facet));
    const facets = [...new Set(kinds.map((k) => str(k.attrs.facet)))].sort();
    const facetGraphs: GraphView[] = facets.map((facet) => {
      const members = kinds.filter((k) => facetOf.get(k.id) === facet);
      const memberIds = new Set(members.map((k) => k.id));
      const nodes = new Map<string, { id: string; label: string; group: string }>();
      for (const k of members) nodes.set(k.id, { id: k.id, label: nameOf(k), group: "kind" });
      const edges: GraphView["edges"] = [];
      const seen = new Set<string>();
      for (const e of usesEdges) {
        const t = targetOf(e);
        if (t === undefined || !memberIds.has(t)) continue;
        const pkg = pkgOf(e.from);
        const verb = str(e.attrs?.how) === "emit" ? "emits" : "reads";
        const pid = `package:${pkg}`;
        if (!nodes.has(pid)) nodes.set(pid, { id: pid, label: pkg, group: "package" });
        const key = `${pid}|${t}|${verb}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({ from: pid, to: t, kind: verb, label: verb });
      }
      for (const e of extendsEdges) {
        const t = targetOf(e);
        if (t !== undefined && memberIds.has(t) && memberIds.has(e.from)) edges.push({ from: e.from, to: t, kind: "extends", label: "extends" });
      }
      return { type: "graph", id: `facet-${facet}`, title: `${facet} kinds`, nodes: [...nodes.values()], edges };
    });

    // Graph: the core schema's definitions and the $refs between them.
    const coreDefs = defs.filter((d) => d.id.startsWith(`${CORE_FILE}#def:`));
    const coreIds = new Set(coreDefs.map((d) => d.id));
    const rNodes = coreDefs.map((d) => ({ id: d.id, label: nameOf(d), group: d.id.endsWith("#def:$root") ? "root" : "def" }));
    const rEdges: GraphView["edges"] = [];
    const seenR = new Set<string>();
    for (const e of refEdges) {
      const t = targetOf(e);
      const from = ir.node(e.from);
      if (t === undefined || !coreIds.has(t) || !from) continue;
      let src: string | undefined;
      let label: string | undefined;
      if (from.kind === DEF) src = from.id;
      else if (from.kind === PROP) {
        src = from.parent;
        label = nameOf(from);
      }
      if (src === undefined || !coreIds.has(src)) continue;
      const key = `${src}|${t}|${label ?? ""}`;
      if (seenR.has(key)) continue;
      seenR.add(key);
      rEdges.push({ from: src, to: t, kind: "ref", ...(label ? { label } : {}) });
    }
    const recordsGraph: GraphView = { type: "graph", id: "records", title: "Records", nodes: rNodes, edges: rEdges };

    // Findings.
    const findings: LensFinding[] = [];
    for (const k of kinds) {
      if (emitBy.has(k.id)) continue;
      findings.push({
        lens: LENS_ID,
        id: `never-emitted:${nameOf(k)}`,
        severity: "info",
        message: `${nameOf(k)} is declared but no TypeScript file emits it`,
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

    const views: LensView[] = [table, ...facetGraphs, recordsGraph];
    const emitted = kinds.filter((k) => emitBy.has(k.id)).length;
    const metrics = {
      kinds: kinds.length,
      facets: new Set(kinds.map((k) => str(k.attrs.facet))).size,
      defs: defs.length,
      properties: props.length,
      emitted,
      neverEmitted: kinds.length - emitted,
      readers: kinds.filter((k) => readBy.has(k.id)).length,
    };
    return { findings, views, metrics };
  },
};

export default lensIrSchema;
