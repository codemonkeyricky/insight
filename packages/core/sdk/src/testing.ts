/**
 * Builders for hand-written IR. Lens tests use these instead of a parser, which keeps every lens
 * testable on plain data.
 */
import { createCoreRegistry, type IREdge, type IRFinding, type IRNode, type KindRegistry, type NodeId, type Span, type UnresolvedRef } from "@insight/ir";
import { IRView } from "./irview.js";

export type Confidence = "exact" | "inferred" | "heuristic";

export function span(file: string, startLine: number, startCol: number, endLine: number, endCol: number): Span {
  return { file, start: [startLine, startCol], end: [endLine, endCol] };
}

export function node(
  id: NodeId,
  facet: string,
  kind: string,
  opts: { attrs?: Record<string, unknown>; parent?: NodeId; span?: Span; confidence?: Confidence } = {},
): IRNode {
  return {
    id,
    facet,
    kind,
    attrs: (opts.attrs ?? {}) as IRNode["attrs"],
    ...(opts.parent !== undefined ? { parent: opts.parent } : {}),
    ...(opts.span !== undefined ? { span: opts.span } : {}),
    provenance: { frontend: "fixture", confidence: opts.confidence ?? "exact" },
  };
}

/** `to` is one node, a candidate list, or an unresolved reference. */
export function edge(
  from: NodeId,
  to: NodeId | NodeId[] | UnresolvedRef,
  facet: string,
  kind: string,
  opts: { attrs?: Record<string, unknown>; span?: Span; confidence?: Confidence } = {},
): IREdge {
  const target: IREdge["to"] = typeof to === "string"
    ? to
    : Array.isArray(to)
      ? { candidates: to as [NodeId, ...NodeId[]] }
      : to;
  return {
    from,
    to: target,
    facet,
    kind,
    ...(opts.attrs !== undefined ? { attrs: opts.attrs as IREdge["attrs"] } : {}),
    ...(opts.span !== undefined ? { span: opts.span } : {}),
    provenance: { frontend: "fixture", confidence: opts.confidence ?? "exact" },
  } as IREdge;
}

export function finding(message: string, opts: { severity?: IRFinding["severity"]; nodes?: NodeId[]; span?: Span } = {}): IRFinding {
  return {
    severity: opts.severity ?? "info",
    message,
    ...(opts.nodes !== undefined ? { nodes: opts.nodes } : {}),
    ...(opts.span !== undefined ? { span: opts.span } : {}),
  };
}

/** A read-only view over the given nodes and edges. Uses the core kinds unless told otherwise. */
export function view(
  parts: { nodes?: IRNode[]; edges?: IREdge[]; findings?: IRFinding[] },
  registry: KindRegistry = createCoreRegistry(),
): IRView {
  return new IRView({
    nodes: parts.nodes ?? [],
    edges: parts.edges ?? [],
    findings: parts.findings ?? [],
    registry,
  });
}
