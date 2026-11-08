import type { IREdge, IRNode } from "@insight/ir";
import { insideScope, summarizeScope, type ScopeFlow } from "../src/index.js";

/** Provenance for the hand-built IR of these tests. */
export const PROVENANCE = { frontend: "test", confidence: "exact" as const };

/** A function defined in one file, four lines long, starting at `line` (0-based). */
export function fnNode(file: string, name: string, line: number): IRNode {
  return {
    id: `${file}#${name}`,
    facet: "structure",
    kind: "structure.function",
    span: { file, start: [line, 0], end: [line + 3, 1] },
    attrs: { name },
    provenance: PROVENANCE,
  };
}

/** A call edge from `from` to `to`, made on `line` of `file`. */
export function callEdge(from: string, to: IREdge["to"], file: string, line: number): IREdge {
  return {
    from,
    to,
    facet: "calls",
    kind: "calls.call",
    span: { file, start: [line, 2], end: [line, 8] },
    attrs: { callee: typeof to === "string" ? (to.split("#")[1] ?? to) : "call" },
    provenance: PROVENANCE,
  };
}

/**
 * The scoped IR of some files, cut the way core's scopeDoc cuts it: the nodes of the files, the edges with an end in
 * them, and an external stub for each far end. The far end of a stub is copied from the whole project's node.
 */
export function cutScope(nodes: readonly IRNode[], edges: readonly IREdge[], files: readonly string[]): { nodes: IRNode[]; edges: IREdge[] } {
  const inside = new Set(files);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const isLocal = (id: string) => {
    const n = byId.get(id);
    return inside.has(id) || (n?.span !== undefined && inside.has(n.span.file));
  };
  const kept = edges.filter((e) => isLocal(e.from) || (typeof e.to === "string" && isLocal(e.to)));
  const stubs = new Map<string, IRNode>();
  const far = (id: string) => {
    if (isLocal(id) || stubs.has(id)) return;
    const orig = byId.get(id);
    stubs.set(id, {
      id,
      facet: orig?.facet ?? "structure",
      kind: orig?.kind ?? "structure.function",
      attrs: { ...orig?.attrs, external: true },
      provenance: PROVENANCE,
    });
  };
  for (const e of kept) {
    far(e.from);
    if (typeof e.to === "string") far(e.to);
  }
  const local = nodes.filter((n) => n.span !== undefined && inside.has(n.span.file));
  return { nodes: [...local, ...stubs.values()], edges: kept };
}

/** The flow of one scope of a project: the files of `scope` among `files`, cut from the project's IR. */
export function flowOfScope(nodes: readonly IRNode[], edges: readonly IREdge[], files: readonly string[], scope: string): ScopeFlow {
  const inScope = files.filter((f) => insideScope(f, scope));
  const cut = cutScope(nodes, edges, inScope);
  return summarizeScope(cut.nodes, cut.edges, inScope);
}
