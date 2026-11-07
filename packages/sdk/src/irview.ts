import type { IREdge, IRFinding, IRNode, KindRegistry, NodeId, UnresolvedRef } from "@insight/ir";
import { trace, type Reach, type TraceOptions } from "./trace.js";

export interface NodeQuery {
  facet?: string;
  /** Matches this kind and every subkind of it. */
  kind?: string;
}

export interface EdgeTargets {
  nodes: NodeId[];
  candidates: NodeId[];
  unresolved?: UnresolvedRef["unresolved"];
}

/** Splits an edge's `to` into its parts, so callers never test the union by hand. */
export function edgeTargets(edge: IREdge): EdgeTargets {
  const to = edge.to;
  if (typeof to === "string") return { nodes: [to], candidates: [] };
  if ("candidates" in to) return { nodes: [], candidates: [...to.candidates] };
  return { nodes: [], candidates: [], unresolved: to.unresolved };
}

/**
 * Read-only, indexed view of one IR snapshot. Kind queries are subkind-aware: asking for
 * "sync.lock-acquire" also returns "sync.rwlock-acquire" and any plugin kind that extends it.
 */
export class IRView {
  readonly registry: KindRegistry;
  private readonly nodeById = new Map<NodeId, IRNode>();
  private readonly nodesByKind = new Map<string, IRNode[]>();
  private readonly edgesByKind = new Map<string, IREdge[]>();
  private readonly outgoing = new Map<NodeId, IREdge[]>();
  private readonly incoming = new Map<NodeId, IREdge[]>();
  private readonly allNodes: IRNode[];
  private readonly allEdges: IREdge[];
  private readonly findingList: IRFinding[];

  constructor(input: { nodes: IRNode[]; edges: IREdge[]; findings?: IRFinding[]; registry: KindRegistry }) {
    this.registry = input.registry;
    this.allNodes = input.nodes;
    this.allEdges = input.edges;
    this.findingList = input.findings ?? [];
    for (const node of input.nodes) {
      this.nodeById.set(node.id, node);
      push(this.nodesByKind, node.kind, node);
    }
    for (const edge of input.edges) {
      push(this.edgesByKind, edge.kind, edge);
      push(this.outgoing, edge.from, edge);
      for (const target of edgeTargets(edge).nodes) push(this.incoming, target, edge);
      for (const target of edgeTargets(edge).candidates) push(this.incoming, target, edge);
    }
  }

  node(id: NodeId): IRNode | undefined {
    return this.nodeById.get(id);
  }

  nodes(query: NodeQuery = {}): IRNode[] {
    const pool = query.kind === undefined ? this.allNodes : this.byKind(this.nodesByKind, query.kind);
    return query.facet === undefined ? [...pool] : pool.filter((n) => n.facet === query.facet);
  }

  edges(query: NodeQuery = {}): IREdge[] {
    const pool = query.kind === undefined ? this.allEdges : this.byKind(this.edgesByKind, query.kind);
    return query.facet === undefined ? [...pool] : pool.filter((e) => e.facet === query.facet);
  }

  /** Edges leaving a node, optionally filtered by kind (subkind-aware). */
  out(id: NodeId, query: NodeQuery = {}): IREdge[] {
    return this.filterEdges(this.outgoing.get(id), query);
  }

  /** Edges arriving at a node (direct targets and candidate sets), optionally filtered. */
  in(id: NodeId, query: NodeQuery = {}): IREdge[] {
    return this.filterEdges(this.incoming.get(id), query);
  }

  /** Direct children, by the parent field. */
  children(id: NodeId, query: NodeQuery = {}): IRNode[] {
    return this.allNodes.filter((n) => n.parent === id && (query.kind === undefined || this.registry.subkinds(query.kind).includes(n.kind)));
  }

  /** Walks chains of edges from start nodes. See trace.ts. */
  trace(starts: NodeId[], opts: TraceOptions): Reach {
    return trace(this, starts, opts);
  }

  findings(): IRFinding[] {
    return [...this.findingList];
  }

  /** Facets that have at least one node or edge in this snapshot. */
  facets(): Set<string> {
    const out = new Set<string>();
    for (const n of this.allNodes) out.add(n.facet);
    for (const e of this.allEdges) out.add(e.facet);
    return out;
  }

  hasFacet(facet: string): boolean {
    return this.facets().has(facet);
  }

  /** Kinds in the snapshot that the registry does not know. */
  opaqueKinds(): string[] {
    const kinds = new Set<string>();
    for (const n of this.allNodes) if (this.registry.isOpaque(n.kind)) kinds.add(n.kind);
    for (const e of this.allEdges) if (this.registry.isOpaque(e.kind)) kinds.add(e.kind);
    return [...kinds].sort();
  }

  private byKind<T>(index: Map<string, T[]>, kind: string): T[] {
    const kinds = this.registry.subkinds(kind);
    if (kinds.length === 1) return index.get(kind) ?? [];
    return kinds.flatMap((k) => index.get(k) ?? []);
  }

  private filterEdges(list: IREdge[] | undefined, query: NodeQuery): IREdge[] {
    if (!list) return [];
    let out = list;
    if (query.kind !== undefined) {
      const kinds = new Set(this.registry.subkinds(query.kind));
      out = out.filter((e) => kinds.has(e.kind));
    }
    if (query.facet !== undefined) out = out.filter((e) => e.facet === query.facet);
    return [...out];
  }
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/**
 * The nearest node at or above `id` whose kind matches `kind` (subkinds included), or undefined.
 * A node counts as its own ancestor, so a function given to this returns itself.
 */
export function enclosing(view: IRView, id: NodeId, kind: string): IRNode | undefined {
  const kinds = new Set(view.registry.subkinds(kind));
  let cur = view.node(id);
  while (cur) {
    if (kinds.has(cur.kind)) return cur;
    if (cur.parent === undefined) return undefined;
    cur = view.node(cur.parent);
  }
  return undefined;
}

/**
 * True for an external stub: a node outside a scope that a scoped view keeps only as the far end of
 * an edge. A stub has the id, facet, kind and attrs of the real node, plus `external: true`, and no
 * span or parent. Lenses count and list local nodes only, and use stubs only as edge ends.
 */
export function isExternal(node: IRNode): boolean {
  return node.attrs.external === true;
}

/** The function that owns a node, or the file when the node sits at module level. */
export function ownerOf(view: IRView, id: NodeId): IRNode | undefined {
  return enclosing(view, id, "structure.function") ?? enclosing(view, id, "structure.file");
}
