import type { IREdge, IRNode } from "@insight/ir";
import { factsForFile } from "./build.js";
import { layoutFunction, measure } from "./layout.js";
import type { FileFlow } from "./types.js";

export * from "./types.js";
export { CHAR_W, CHART_PAD_R, LABEL_GAP, LABEL_MAX, LANE_W, LINE_X0, LOOP_GAP, ROW_H, layoutFunction, MAX_NODES, NEST_HEAD, NEST_PAD, NEST_TOP, relayout, stationOf, type InlineEntry, type InlineTree } from "./layout.js";
export { SCOPE_FUNCTION_LIMIT, isNoisePath, summarizeScope } from "./scope.js";
export * from "./scope-map.js";
export * from "./zoom-layout.js";
export * from "./exec-model.js";
export * from "./scene.js";
export * from "./scene-layout.js";
export * from "./exec-scene.js";
export * from "./scene-filter.js";
export * from "./roots-grid.js";
export * from "./runtime-boxes.js";
export * from "./names.js";

/**
 * The control-flow chart of every function in one source file, rebuilt from the IR.
 *
 * The TypeScript frontend records decisions, loops, try blocks, returns, calls, awaits, spawns and
 * side effects with their source ranges. Containment of those ranges gives the nesting, so this
 * works for any frontend that emits the same flow facts.
 */
export function buildFileFlow(file: string, nodes: Iterable<IRNode>, edges: Iterable<IREdge>): FileFlow {
  return { file, functions: factsForFile(file, nodes, edges).map((f) => layoutFunction(f)) };
}

/** What the project, folder and file scopes show for the flow view: how branchy each file is. */
export interface FileFlowSummary {
  file: string;
  functions: number;
  steps: number;
  decisions: number;
  loops: number;
  tries: number;
  exits: number;
  /** The function with the most decisions and loops. */
  busiest?: { name: string; id: string; branches: number };
}

/** Flow totals for every file that has functions. Cheap: nothing is laid out. */
export function summarizeFlows(nodes: Iterable<IRNode>, edges: Iterable<IREdge>): FileFlowSummary[] {
  const byFileNodes = new Map<string, IRNode[]>();
  const byFileEdges = new Map<string, IREdge[]>();
  const push = <T>(m: Map<string, T[]>, k: string, v: T) => {
    const list = m.get(k);
    if (list) list.push(v);
    else m.set(k, [v]);
  };
  for (const n of nodes) if (n.span) push(byFileNodes, n.span.file, n);
  for (const e of edges) if (e.kind === "calls.call" && e.span) push(byFileEdges, e.span.file, e);
  const out: FileFlowSummary[] = [];
  for (const [file, ns] of byFileNodes) {
    const fns = factsForFile(file, ns, byFileEdges.get(file) ?? []).filter((f) => f.span !== undefined);
    if (fns.length === 0) continue;
    const row: FileFlowSummary = { file, functions: fns.length, steps: 0, decisions: 0, loops: 0, tries: 0, exits: 0 };
    for (const f of fns) {
      const s = measure(f.items);
      row.steps += s.steps;
      row.decisions += s.decisions;
      row.loops += s.loops;
      row.tries += s.tries;
      row.exits += s.exits;
      const branches = s.decisions + s.loops;
      if (branches > (row.busiest?.branches ?? 0)) row.busiest = { name: f.name, id: f.id, branches };
    }
    out.push(row);
  }
  return out.sort((a, b) => a.file.localeCompare(b.file));
}
