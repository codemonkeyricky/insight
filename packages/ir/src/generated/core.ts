/* Generated from the JSON Schema by scripts/generate-types.mjs. Do not edit. */

/**
 * One line of an IR NDJSON stream: a node, an edge or a finding.
 */
export type IRRecord =
  | {
      node: IRNode;
    }
  | {
      edge: IREdge;
    }
  | {
      finding: IRFinding;
    };
export type NodeId = string;
export type FacetId = string;
export type KindName = string;
/**
 * [line, column], both zero-based.
 *
 * @minItems 2
 * @maxItems 2
 */
export type Position = [number, number];
export type EdgeTarget = NodeId | UnresolvedRef | CandidateSet;

export interface IRNode {
  id: NodeId;
  facet: FacetId;
  kind: KindName;
  parent?: NodeId;
  span?: Span;
  attrs: {
    [k: string]: unknown;
  };
  provenance: Provenance;
}
export interface Span {
  file: string;
  start: Position;
  end: Position;
}
export interface Provenance {
  frontend: string;
  confidence: "exact" | "inferred" | "heuristic";
  /**
   * How the fact was produced, e.g. tool-backed or static.
   */
  mode?: string;
  /**
   * Build configuration the fact belongs to.
   */
  configuration?: string;
  /**
   * The resolver plugin that settled an open reference.
   */
  resolvedBy?: string;
}
export interface IREdge {
  from: NodeId;
  to: EdgeTarget;
  facet: FacetId;
  kind: KindName;
  attrs?: {
    [k: string]: unknown;
  };
  span?: Span;
  provenance: Provenance;
}
export interface UnresolvedRef {
  unresolved: {
    scheme: string;
    text: string;
  };
}
export interface CandidateSet {
  /**
   * @minItems 1
   */
  candidates: [NodeId, ...NodeId[]];
}
export interface IRFinding {
  severity: "info" | "warning" | "error";
  message: string;
  nodes?: NodeId[];
  span?: Span;
  provenance?: Provenance;
}
