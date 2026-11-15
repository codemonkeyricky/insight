import type { IREdge, IRNode, NodeId, Provenance } from "@insight/ir";

export interface ShardEdge {
  edge: IREdge;
  /** The shard file the edge came from. Used as the caller file when the caller has no file ancestor. */
  file: string;
}

/** What one frontend's build graph can link for a caller: its targets' dependency closure. */
interface Reach {
  targets: Set<NodeId>;
  /** A target in the closure has an unresolved dependency, so the closure is incomplete and gives no "not linked". */
  open: boolean;
}

/**
 * Narrows ambiguous `calls.call` candidates with the build graph, per build system (the frontend that owns each
 * target). For each frontend that owns both the caller's file and the candidate's file: the candidate is linked when
 * one of its owners is in the caller's dependency closure, or when that closure is open. A candidate is dropped only
 * when some shared frontend says not linked and none says linked. A candidate with no shared frontend (or in no
 * target) is kept. Edits edges in place and returns how many changed. Never adds edges.
 */
export function narrowByBuildGraph(nodes: ReadonlyMap<NodeId, IRNode>, edges: ShardEdge[]): number {
  const owners = new Map<NodeId, Set<NodeId>>();
  const deps = new Map<NodeId, NodeId[]>();
  const openTargets = new Set<NodeId>();
  for (const { edge } of edges) {
    if (edge.kind === "packaging.target-contains" && typeof edge.to === "string") {
      if (nodes.get(edge.from)?.kind !== "packaging.build-target") continue;
      const set = owners.get(edge.to) ?? new Set<NodeId>();
      set.add(edge.from);
      owners.set(edge.to, set);
    } else if (edge.kind === "packaging.dep-edge") {
      if (nodes.get(edge.from)?.kind !== "packaging.build-target") continue;
      if (typeof edge.to === "string") {
        if (nodes.get(edge.to)?.kind !== "packaging.build-target") continue;
        const list = deps.get(edge.from) ?? [];
        list.push(edge.to);
        deps.set(edge.from, list);
      } else if ("unresolved" in edge.to) {
        openTargets.add(edge.from);
      }
    }
  }

  const fileOf = (id: NodeId): NodeId | undefined => {
    let current: NodeId | undefined = id;
    const seen = new Set<NodeId>();
    while (current !== undefined && !seen.has(current)) {
      seen.add(current);
      const node = nodes.get(current);
      if (!node) return undefined;
      if (node.kind === "structure.file") return node.id;
      current = node.parent;
    }
    return undefined;
  };

  const frontendOf = (target: NodeId): string => nodes.get(target)?.provenance.frontend ?? "";

  /** The owners of a file, grouped by the frontend that owns them. */
  const ownersByFrontend = (file: NodeId): Map<string, Set<NodeId>> => {
    const grouped = new Map<string, Set<NodeId>>();
    for (const t of owners.get(file) ?? []) {
      const f = frontendOf(t);
      const set = grouped.get(f) ?? new Set<NodeId>();
      set.add(t);
      grouped.set(f, set);
    }
    return grouped;
  };

  /** A method: its parent chain reaches a structure.type before the structure.file. */
  const isMethod = (id: NodeId): boolean => {
    const seen = new Set<NodeId>();
    let cur = nodes.get(id)?.parent;
    while (cur !== undefined && !seen.has(cur)) {
      seen.add(cur);
      const n = nodes.get(cur);
      if (!n) return false;
      if (n.kind === "structure.type") return true;
      if (n.kind === "structure.file") return false;
      cur = n.parent;
    }
    return false;
  };

  const closures = new Map<NodeId, Reach>();
  const closureOf = (target: NodeId): Reach => {
    const cached = closures.get(target);
    if (cached) return cached;
    const out = new Set<NodeId>([target]);
    const stack = [target];
    let open = false;
    while (stack.length > 0) {
      const next = stack.pop() as NodeId;
      if (openTargets.has(next)) open = true;
      for (const d of deps.get(next) ?? []) {
        if (!out.has(d)) {
          out.add(d);
          stack.push(d);
        }
      }
    }
    const reach = { targets: out, open };
    closures.set(target, reach);
    return reach;
  };

  let narrowed = 0;
  for (const entry of edges) {
    const { edge } = entry;
    if (edge.kind !== "calls.call") continue;
    const to = edge.to;
    if (typeof to !== "object" || !("candidates" in to)) continue;

    const callerFile = fileOf(edge.from) ?? entry.file;
    const callerByFrontend = ownersByFrontend(callerFile);
    if (callerByFrontend.size === 0) continue;

    const reachByFrontend = new Map<string, Reach>();
    for (const [f, targets] of callerByFrontend) {
      const reach: Reach = { targets: new Set<NodeId>(), open: false };
      for (const t of targets) {
        const c = closureOf(t);
        for (const x of c.targets) reach.targets.add(x);
        if (c.open) reach.open = true;
      }
      reachByFrontend.set(f, reach);
    }

    /**
     * Keep unless some shared frontend says not linked and none says linked. A method that lives downstream of the
     * caller (one of the caller's owners is in a candidate owner's closure) is linked too: library code reaches
     * downstream overrides and callbacks by virtual dispatch, though the library does not link them.
     */
    const keeps = (candidate: NodeId): boolean => {
      const file = fileOf(candidate);
      if (file === undefined) return true;
      const candidateByFrontend = ownersByFrontend(file);
      const method = isMethod(candidate);
      let shared = 0;
      for (const [f, reach] of reachByFrontend) {
        const candidateOwners = candidateByFrontend.get(f);
        if (!candidateOwners) continue;
        shared++;
        if (reach.open) return true;
        for (const t of candidateOwners) if (reach.targets.has(t)) return true;
        if (method) {
          const callerOwners = callerByFrontend.get(f) ?? new Set<NodeId>();
          for (const t of candidateOwners) {
            for (const s of closureOf(t).targets) if (callerOwners.has(s)) return true;
          }
        }
      }
      return shared === 0;
    };

    const candidates = to.candidates;
    const kept = candidates.filter(keeps);
    if (kept.length === 0 || kept.length === candidates.length) continue;

    const [first, ...rest] = kept as [NodeId, ...NodeId[]];
    edge.to = rest.length === 0 ? first : { candidates: [first, ...rest] };
    const provenance: Provenance = {
      ...edge.provenance,
      resolvedBy: edge.provenance.resolvedBy ? `${edge.provenance.resolvedBy}+build-graph` : "build-graph",
    };
    if (rest.length === 0 && edge.provenance.confidence === "heuristic") provenance.confidence = "inferred";
    edge.provenance = provenance;
    narrowed++;
  }
  return narrowed;
}
