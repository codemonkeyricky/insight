import { edgeTargets, findCycles, ownerOf, type Confidence, type GraphView, type IRView, type Lens, type LensFinding, type LensResult, type TableView } from "@insight/sdk";
import type { IRNode, NodeId, Span } from "@insight/ir";

interface Site {
  /** The function (or file) where the order was observed. */
  unit: NodeId;
  span?: Span;
  confidence: Confidence;
}

interface OrderEdge {
  from: string;
  to: string;
  sites: Site[];
}

const RANK: Record<Confidence, number> = { exact: 0, inferred: 1, heuristic: 2 };
const weaker = (a: Confidence, b: Confidence): Confidence => (RANK[a] >= RANK[b] ? a : b);

const positionOf = (span: Span | undefined): [number, number] => (span ? span.start : [Number.MAX_SAFE_INTEGER, 0]);
const comparePos = (a: [number, number], b: [number, number]): number => a[0] - b[0] || a[1] - b[1];

type Event =
  | { kind: "acquire"; pos: [number, number]; lock: string; confidence: Confidence; span?: Span }
  | { kind: "release"; pos: [number, number]; lock: string }
  | { kind: "call"; pos: [number, number]; target: NodeId; span?: Span };

/**
 * Lock order: while a lock is held, acquiring another one records an edge held -> acquired. A
 * call made while holding a lock records an edge to every lock the callee can acquire, found by
 * walking the calls. A cycle in that graph means two code paths take the same locks in opposite
 * orders, which can deadlock. A self edge means a lock may be taken again while held.
 *
 * Limits: a lock is held until its release node in the same function, or until the end of the
 * function when no release is recorded. Cross-call edges use only exact call targets, and are
 * reported as inferred.
 */
export function lockOrderEdges(view: IRView): { edges: OrderEdge[]; locks: string[]; unknownLocks: number } {
  const acquires = view.nodes({ facet: "sync", kind: "sync.lock-acquire" });
  const releases = view.nodes({ facet: "sync", kind: "sync.lock-release" });
  let unknownLocks = 0;

  const eventsByUnit = new Map<NodeId, Event[]>();
  const push = (unit: NodeId, event: Event) => {
    const list = eventsByUnit.get(unit) ?? [];
    list.push(event);
    eventsByUnit.set(unit, list);
  };
  const lockOf = (n: IRNode): string | undefined => {
    const lock = n.attrs.lock;
    if (typeof lock === "string" && lock.length > 0) return lock;
    unknownLocks++;
    return undefined;
  };

  // Lock identity comes from attrs.lock, which the sync schema requires on acquire and release.
  for (const n of acquires) {
    const owner = ownerOf(view, n.id);
    const lock = lockOf(n);
    if (!owner || lock === undefined) continue;
    push(owner.id, { kind: "acquire", pos: positionOf(n.span), lock, confidence: n.provenance.confidence, ...(n.span ? { span: n.span } : {}) });
  }
  for (const n of releases) {
    const owner = ownerOf(view, n.id);
    const lock = lockOf(n);
    if (!owner || lock === undefined) continue;
    push(owner.id, { kind: "release", pos: positionOf(n.span), lock });
  }
  // Calls only: spawns start another thread, so the caller's locks are not held by the callee.
  for (const e of view.edges({ facet: "calls", kind: "calls.call" })) {
    const { nodes } = edgeTargets(e);
    for (const target of nodes) push(e.from, { kind: "call", pos: positionOf(e.span), target, ...(e.span ? { span: e.span } : {}) });
  }

  // Every lock a function can acquire, directly or through the calls it makes.
  const directLocks = new Map<NodeId, Map<string, Confidence>>();
  for (const [unit, events] of eventsByUnit) {
    for (const ev of events) {
      if (ev.kind !== "acquire") continue;
      const set = directLocks.get(unit) ?? new Map<string, Confidence>();
      set.set(ev.lock, set.has(ev.lock) ? weaker(set.get(ev.lock) as Confidence, ev.confidence) : ev.confidence);
      directLocks.set(unit, set);
    }
  }
  const transitive = new Map<NodeId, Map<string, Confidence>>();
  const locksReachableFrom = (fn: NodeId): Map<string, Confidence> => {
    const cached = transitive.get(fn);
    if (cached) return cached;
    const out = new Map<string, Confidence>();
    const reach = view.trace([fn], { follow: ["calls.call"], direction: "out", uncertain: "exact" });
    for (const id of reach.nodes.keys()) {
      for (const [lock, conf] of directLocks.get(id) ?? []) {
        out.set(lock, out.has(lock) ? weaker(out.get(lock) as Confidence, conf) : conf);
      }
    }
    transitive.set(fn, out);
    return out;
  };

  const edges = new Map<string, OrderEdge>();
  const addEdge = (from: string, to: string, unit: NodeId, span: Span | undefined, confidence: Confidence) => {
    const key = `${from}\0${to}`;
    const edge = edges.get(key) ?? { from, to, sites: [] };
    edge.sites.push({ unit, ...(span ? { span } : {}), confidence });
    edges.set(key, edge);
  };

  for (const [unit, events] of eventsByUnit) {
    const ordered = [...events].sort((a, b) => comparePos(a.pos, b.pos));
    const held: { lock: string; confidence: Confidence }[] = [];
    for (const ev of ordered) {
      if (ev.kind === "acquire") {
        for (const h of held) addEdge(h.lock, ev.lock, unit, ev.span, weaker(h.confidence, ev.confidence));
        held.push({ lock: ev.lock, confidence: ev.confidence });
      } else if (ev.kind === "release") {
        const i = held.map((h) => h.lock).lastIndexOf(ev.lock);
        if (i >= 0) held.splice(i, 1);
      } else if (held.length > 0) {
        for (const lock of locksReachableFrom(ev.target).keys()) {
          for (const h of held) addEdge(h.lock, lock, unit, ev.span, "inferred");
        }
      }
    }
  }

  const locks = new Set<string>();
  for (const e of edges.values()) {
    locks.add(e.from);
    locks.add(e.to);
  }
  for (const set of directLocks.values()) for (const lock of set.keys()) locks.add(lock);
  return { edges: [...edges.values()].sort((a, b) => `${a.from}${a.to}`.localeCompare(`${b.from}${b.to}`)), locks: [...locks].sort(), unknownLocks };
}

export const lensLockOrder: Lens = {
  id: "lens-lock-order",
  title: "Lock order",
  requires: ["structure", "sync", "concurrency", "calls"],
  optional: ["effects"],

  async run(view): Promise<LensResult> {
    const { edges, locks, unknownLocks } = lockOrderEdges(view);
    const adjacency = new Map<string, string[]>();
    for (const e of edges) adjacency.set(e.from, [...(adjacency.get(e.from) ?? []), e.to]);
    const cycles = findCycles(locks, adjacency);

    const findings: LensFinding[] = cycles.map((group) => {
      const groupSet = new Set(group);
      const inside = edges.filter((e) => groupSet.has(e.from) && groupSet.has(e.to));
      const first = inside[0]?.sites[0];
      const units = [...new Set(inside.flatMap((e) => e.sites.map((s) => s.unit)))].sort();
      const single = group.length === 1;
      return {
        lens: "lens-lock-order",
        id: `cycle:${group.join("|")}`,
        severity: single ? "warning" : "error",
        message: single
          ? `Lock ${group[0]} may be acquired again while already held`
          : `Lock order cycle: ${[...group, group[0] ?? ""].join(" -> ")}`,
        nodes: units,
        ...(first?.span ? { span: first.span } : {}),
      };
    });

    const graph: GraphView = {
      type: "graph",
      id: "lock-order",
      title: "Lock order graph",
      nodes: locks.map((lock) => ({ id: lock, label: lock })),
      edges: edges.map((e) => ({
        from: e.from,
        to: e.to,
        kind: "held-before",
        confidence: e.sites.reduce<Confidence>((c, s) => weaker(c, s.confidence), "exact"),
        ...(e.sites[0]?.span ? { span: e.sites[0].span } : {}),
      })),
    };

    const table: TableView = {
      type: "table",
      id: "lock-order-edges",
      title: "Held-before pairs",
      columns: ["Held", "Then acquired", "Observed in", "Confidence"],
      rows: edges.flatMap((e) => e.sites.map((s) => [e.from, e.to, s.unit, s.confidence])),
    };

    return {
      findings,
      views: [graph, table],
      metrics: {
        locks: locks.length,
        orderEdges: edges.length,
        cycles: cycles.length,
        unknownLocks,
      },
    };
  },
};

export default lensLockOrder;
