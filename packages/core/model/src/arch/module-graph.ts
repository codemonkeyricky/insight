import { edgeTargets, isExternal, type IRView } from "@insight/sdk";
import type { IREdge, NodeId, Span } from "@insight/ir";

interface PairInfo {
  imports: number;
  calls: number;
  confidence: "exact" | "inferred" | "heuristic";
  /** The first import span for the pair (the lens uses it for display). */
  span?: IREdge["span"];
  /** The span of every import or include edge for the pair, in edge order. */
  spans: Span[];
}

/** An import made inside the scope whose target the IR could not resolve. */
export interface UnresolvedImport {
  from: NodeId;
  text: string;
  span?: Span;
}

/** A module, and whether the node it was found from is an external stub. */
interface ModuleRef {
  id: NodeId;
  external: boolean;
}

/**
 * The file that owns a node: the node itself when it is a file, else its nearest file ancestor.
 * An external function stub has no parent, so its module is the part of its id before "#" (the
 * TypeScript id convention "<file>#<name>"). That module is external.
 */
function moduleOf(view: IRView, id: NodeId): ModuleRef | undefined {
  const start = view.node(id);
  let cur = start;
  while (cur) {
    if (cur.kind === "structure.file") return { id: cur.id, external: isExternal(cur) };
    if (cur.parent === undefined) break;
    cur = view.node(cur.parent);
  }
  if (start !== undefined && isExternal(start)) {
    const file = String(id).split("#")[0];
    if (file !== undefined && file !== "" && file !== id) return { id: file, external: true };
  }
  return undefined;
}

const weakest = (a: PairInfo["confidence"], b: PairInfo["confidence"]): PairInfo["confidence"] => {
  const rank = { exact: 0, inferred: 1, heuristic: 2 } as const;
  return rank[a] >= rank[b] ? a : b;
};

/**
 * Module-level graph: imports and includes, plus calls lifted to the modules that contain them.
 * `local` holds the modules that have a node of their own in the view. Any other module is external.
 * `unresolvedImports` lists the unresolved imports made inside the scope; `unresolved` is its length.
 */
export function buildModuleGraph(view: IRView): {
  pairs: Map<string, PairInfo>;
  from: Map<string, [NodeId, NodeId]>;
  unresolved: number;
  unresolvedImports: UnresolvedImport[];
  local: Set<NodeId>;
} {
  const pairs = new Map<string, PairInfo>();
  const endpoints = new Map<string, [NodeId, NodeId]>();
  const local = new Set<NodeId>();
  const unresolvedImports: UnresolvedImport[] = [];
  let unresolved = 0;

  const add = (kind: "imports" | "calls", edge: IREdge, fromMod: ModuleRef, toMod: ModuleRef) => {
    if (fromMod.id === toMod.id) return;
    for (const m of [fromMod, toMod]) if (!m.external) local.add(m.id);
    const key = `${fromMod.id}\0${toMod.id}`;
    endpoints.set(key, [fromMod.id, toMod.id]);
    const info = pairs.get(key) ?? { imports: 0, calls: 0, confidence: edge.provenance.confidence, spans: [] };
    info[kind === "imports" ? "imports" : "calls"]++;
    info.confidence = weakest(info.confidence, edge.provenance.confidence);
    if (info.span === undefined && edge.span !== undefined && kind === "imports") info.span = edge.span;
    if (kind === "imports" && edge.span !== undefined) info.spans.push(edge.span);
    pairs.set(key, info);
  };

  const importEdges = [...view.edges({ facet: "packaging", kind: "packaging.import" }), ...view.edges({ facet: "packaging", kind: "packaging.include" })];
  for (const edge of importEdges) {
    const fromMod = moduleOf(view, edge.from);
    if (fromMod === undefined) continue;
    const targets = edgeTargets(edge);
    if (targets.unresolved) {
      // Only an import made inside the scope is this scope's unresolved import.
      if (!fromMod.external) {
        unresolved++;
        unresolvedImports.push({ from: fromMod.id, text: targets.unresolved.text, ...(edge.span ? { span: edge.span } : {}) });
      }
      continue;
    }
    for (const t of [...targets.nodes, ...targets.candidates]) {
      const toMod = moduleOf(view, t);
      if (toMod !== undefined) add("imports", edge, fromMod, toMod);
    }
  }

  for (const edge of view.edges({ facet: "calls", kind: "calls.call" })) {
    const fromMod = moduleOf(view, edge.from);
    if (fromMod === undefined) continue;
    for (const t of [...edgeTargets(edge).nodes]) {
      const toMod = moduleOf(view, t);
      if (toMod !== undefined) add("calls", edge, fromMod, toMod);
    }
  }
  return { pairs, from: endpoints, unresolved, unresolvedImports, local };
}
