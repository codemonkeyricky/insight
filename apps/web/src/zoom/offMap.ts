// The selection of a function the map does not draw as a box (a callee outside the scope, or hidden by the roots-only view).
// The source panel still follows it, so its MapSelected is built from the function's chart, not from a node.
import type { FlowSpan } from "@insight/flow";
import { fileOfId } from "../flowTargets";
import type { MapSelected } from "./source";

/**
 * The selection for a function with no box on the map. Its file is the IR id's file (the span's file when it has one), and
 * its line is the span's 1-based start line, or 0 when the chart has no span. It runs nowhere the map knows of, so the
 * runtime is "none" and there are no other placements.
 */
export function offMapSelected(ref: string, fn: { name: string; span?: FlowSpan }): MapSelected {
  return {
    ref,
    name: fn.name,
    file: fn.span?.file || fileOfId(ref),
    line: fn.span !== undefined ? fn.span.start[0] + 1 : 0,
    runtime: "none",
    placements: [],
  };
}
