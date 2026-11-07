export * from "./types.js";
export { IRView, edgeTargets, enclosing, ownerOf, type EdgeTargets, type NodeQuery } from "./irview.js";
export { trace, findCycles, type Reach, type TraceOptions, type TraceDeadEnd } from "./trace.js";
export * as irFixtures from "./testing.js";
export type { IRNode, IREdge, IRFinding, IRRecord, KindRegistry, UnresolvedRef, CandidateSet, Span, EdgeTarget } from "@insight/ir";
export { runFrontendConformance, type ConformanceReport, type ConformanceCheck, type ConformanceOptions } from "./conformance.js";
