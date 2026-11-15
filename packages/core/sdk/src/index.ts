export * from "./types.js";
export { IRView, edgeTargets, enclosing, isExternal, ownerOf, type EdgeTargets, type NodeQuery } from "./irview.js";
export { CPP_INCLUDE_ALIASES, CPP_INCLUDE_ALIAS_NAMES, externalForInclude, externalsForInclude, type CppExternal, type CppExternalMatch } from "./cpp.js";
export { trace, findCycles, type Reach, type TraceOptions, type TraceDeadEnd } from "./trace.js";
export type { IRNode, IREdge, IRFinding, IRRecord, KindRegistry, UnresolvedRef, CandidateSet, Span, EdgeTarget } from "@insight/ir";
export { runFrontendConformance, type ConformanceReport, type ConformanceCheck, type ConformanceOptions } from "./conformance.js";
