import type { IREdge, IRNode } from "@insight/ir";
import { factsForFile, type StateIndex } from "./build.js";
import type { FocusCallee } from "./focus.js";
import { couplingChart, couplingFacts, type CouplingFootprint } from "./coupling.js";
import { layoutFunction, measure } from "./layout.js";
import { moduleMap, type ModuleMap } from "./modules.js";
import type { UnguardedState } from "./state-writes.js";
import { unguardedStateFromFacts } from "./unguarded.js";
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
export * from "./modules.js";
export * from "./coupling.js";
export * from "./coupling-report.js";
export * from "./scope-input.js";
export * from "./resource-peers.js";
export * from "./state-writes.js";
export * from "./unguarded.js";
export * from "./focus.js";

/** A function of the snapshot as a coupling report names it: its id, display name, and declaration site. */
export interface CouplingFunction {
  id: string;
  name: string;
  /** The source file, when the IR gives the function a span. A file's top-level flow has no span. */
  file?: string;
  /** The 1-based line the function starts on, when it has a span. */
  line?: number;
  /** Whether the function is exported (`attrs.exported`). An external stub is never exported. */
  exported: boolean;
}

/**
 * What the coupling view needs from the whole project: its modules, every function's footprint, the module surface (the
 * functions other modules reach), and the mutable variables with the modules that write them. Built once per snapshot.
 */
export interface CouplingIndex {
  modules: ModuleMap;
  footprints: ReadonlyMap<string, CouplingFootprint>;
  surface: ReadonlySet<string>;
  state: StateIndex;
  /** Every function by id, with the name, file and line a report shows (see `couplingReport`). */
  functions: ReadonlyMap<string, CouplingFunction>;
  /**
   * The mutable variables written from two or more threads with no lock held in common at every write, and the threads that
   * write them. Built from the same charts as the footprints, so the project execution model is the only extra pass.
   */
  unguarded: UnguardedState;
}

/** The coupling index of a project's IR records. */
export function couplingIndex(nodes: readonly IRNode[], edges: readonly IREdge[]): CouplingIndex {
  const { modules, footprints, surface, state, facts } = couplingFacts(nodes, edges);
  const filePaths = new Set<string>();
  for (const n of nodes) if (n.kind === "structure.file") filePaths.add(String(n.attrs.path ?? n.id));
  const exportedIds = new Set<string>();
  for (const n of nodes) if (n.kind === "structure.function" && n.attrs.exported === true && n.attrs.external !== true) exportedIds.add(n.id);
  const functions = new Map<string, CouplingFunction>();
  for (const [id, f] of facts) {
    // A file's top-level flow has no span; its id is the file path, so it still names its file.
    const file = f.span?.file ?? (filePaths.has(id) ? id : undefined);
    functions.set(id, {
      id,
      name: f.name,
      ...(file !== undefined ? { file } : {}),
      ...(f.span !== undefined ? { line: f.span.start[0] + 1 } : {}),
      exported: exportedIds.has(id),
    });
  }
  return { modules, footprints, surface, state, functions, unguarded: unguardedStateFromFacts(facts.values(), nodes, edges, state) };
}

/**
 * The call targets of the inter-module focus: every function of the project with its file and export flag, by id. A call
 * whose target is missing here (external, unresolved, a candidate list) is never kept. Built from `index.functions`.
 */
export function calleeMapOf(index: CouplingIndex): Map<string, FocusCallee> {
  const hit = calleeMaps.get(index);
  if (hit) return hit;
  const out = new Map<string, FocusCallee>();
  for (const [id, fn] of index.functions) if (fn.file !== undefined) out.set(id, { file: fn.file, exported: fn.exported });
  calleeMaps.set(index, out);
  return out;
}

/** The call-target map of each index, built once. The map is shared: read it, never write it. */
const calleeMaps = new WeakMap<CouplingIndex, Map<string, FocusCallee>>();

/**
 * The control-flow chart of every function in one source file, rebuilt from the IR.
 *
 * The TypeScript frontend records decisions, loops, try blocks, returns, calls, awaits, spawns and
 * side effects with their source ranges. Containment of those ranges gives the nesting, so this
 * works for any frontend that emits the same flow facts.
 *
 * With `opts.coupling`, each function also carries its coupling chart (see `FunctionFlow.coupling`).
 * The index describes the whole project; `nodes` and `edges` may hold only this file.
 */
export function buildFileFlow(
  file: string,
  nodes: Iterable<IRNode>,
  edges: Iterable<IREdge>,
  opts: { coupling?: CouplingIndex; focus?: "intermodule"; callees?: ReadonlyMap<string, FocusCallee>; state?: StateIndex } = {},
): FileFlow {
  const coupling = opts.coupling;
  // The focus needs the state index too: state rows are built only when factsForFile has one. The coupling index carries it.
  const focus = opts.focus === "intermodule"
    ? { focus: "intermodule" as const, callees: opts.callees ?? new Map<string, FocusCallee>(), state: opts.state ?? coupling?.state }
    : {};
  const facts = factsForFile(file, nodes, edges, { ...(coupling ? { sources: true, state: coupling.state } : {}), ...focus });
  return {
    file,
    functions: facts.map((f) => {
      const flow = layoutFunction(f);
      if (coupling === undefined || flow.tooLarge) return flow;
      const pruned = couplingChart(f.id, f.items, coupling.modules, coupling.footprints, coupling.surface, new Set(coupling.unguarded.variables.keys()));
      const chart = layoutFunction({ id: f.id, name: f.name, async: f.async, ...(f.span ? { span: f.span } : {}), items: pruned.items });
      return { ...flow, coupling: { ...pruned.info, chart, rows: { all: flow.nodes.length, coupling: chart.nodes.length } } };
    }),
  };
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
