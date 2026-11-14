import type { Item } from "./build.js";

/** A source range copied from the IR. Lines are 0-based, so add 1 to show a line number. */
export interface FlowSpan {
  file: string;
  start: [number, number];
  end: [number, number];
}

export type FlowRole =
  | "start"
  | "end"
  | "call"
  | "await"
  | "spawn"
  | "effect"
  | "branch"
  | "switch"
  | "loop"
  | "try"
  | "marker"
  | "join"
  | "return"
  | "throw"
  | "break"
  | "continue";

/** How the renderer draws a node. */
export type FlowShape = "terminator" | "step" | "decision" | "loop" | "label" | "join" | "exit" | "nest" | "turn" | "fork" | "line";

export interface FlowNode {
  id: string;
  role: FlowRole;
  shape: FlowShape;
  /** Short text that fits the box. */
  label: string;
  /** Full text, for a tooltip. */
  title?: string;
  span?: FlowSpan;
  /** The IR node of the function this step calls, when the call resolved to code in the project. */
  target?: string;
  /** The step is a handler the code installs (`onmessage = …`): it opens its target, even a folded lambda. */
  handler?: true;
  /** Absolute lane of the node's station (line map layout). */
  lane?: number;
  /** Absolute x where the label text starts. */
  labelX?: number;
  /** A word shown before the label: `else`, a case label, `catch`. */
  tag?: string;
  /** A spawn row opened as a parallel line (shape "fork"): what it starts and the absolute lane the fork bar reaches. */
  fork?: { kind: "thread" | "process"; to: number };
  /** The header row of a parallel line (shape "line"). A process has a band: the faint rectangle behind the line's rows. */
  line?: { kind: "thread" | "process"; band?: { x: number; y: number; w: number; h: number } };
  x: number;
  y: number;
  w: number;
  h: number;
}

export type FlowEdgeKind = "next" | "true" | "false" | "case" | "back" | "exit" | "exception" | "each";

export type FlowEdgeStyle = "solid" | "skip" | "done" | "back" | "throws";

export interface FlowEdge {
  from: string;
  to: string;
  kind: FlowEdgeKind;
  /** Not set by the line map layout (rows carry tags instead). */
  label?: string;
  /** Where the label sits. */
  labelAt?: [number, number];
  /** The lane whose colour the edge takes. */
  lane?: number;
  style?: FlowEdgeStyle;
  /** SVG path data; the renderer draws this. */
  d?: string;
  /** A back edge: x of its return track, outside every lane the loop body uses. */
  track?: number;
  /** The path's vertices in order: start, bends, end. */
  points: [number, number][];
}

export interface FlowStats {
  steps: number;
  decisions: number;
  loops: number;
  tries: number;
  exits: number;
  /** Deepest nesting of decisions, loops and tries. */
  depth: number;
}

export interface FunctionFlow {
  /** IR id of the function, or of the file for top-level code. */
  id: string;
  name: string;
  async: boolean;
  span?: FlowSpan;
  stats: FlowStats;
  /** True when the function has too many steps to chart. Its nodes and edges are then empty. */
  tooLarge?: boolean;
  width: number;
  height: number;
  nodes: FlowNode[];
  edges: FlowEdge[];
  /**
   * The chart before layout, kept so a viewer can lay the function out again with a callee nested inside one of its call
   * steps (see `relayout`). Absent on a chart too large to draw.
   */
  items?: Item[];
}

export interface FileFlow {
  file: string;
  functions: FunctionFlow[];
}

/** `functions` lists each function; `files` aggregates per file once the scope has too many to list. */
export type ScopeGranularity = "functions" | "files";

/** Options for summarizeScope. `lambdas: true` keeps anonymous functions as their own rows; the default folds them into their owner. */
export interface ScopeFlowOptions {
  lambdas?: boolean;
}

/** A function defined in the scope, with the flow counts the charts show for it. */
export interface ScopeFunction {
  id: string;
  name: string;
  file: string;
  async: boolean;
  span?: FlowSpan;
  /** 1-based line of the definition. */
  line: number;
  steps: number;
  decisions: number;
  loops: number;
  tries: number;
  awaits: number;
  spawns: number;
  effects: number;
  exits: number;
  /** Set when a call from outside the scope reaches this function. Such a function is not an entry. */
  calledFromOutside?: true;
  /**
   * Set for an anonymous function: a function expression, arrow function or lambda with no declaration of its own. It
   * is never unreferenced and never an entry. Its calls count as those of the function or file it is written in.
   */
  anonymous?: true;
}

/**
 * A function that no function in its scope calls. `reach` counts the distinct functions it reaches through calls in
 * the scope, not counting itself. `calledFromOutside` says a caller outside the scope exists: it is information only,
 * since the function still counts as unreferenced here and resolves when the scope widens.
 */
export interface UnreferencedFunction extends ScopeFunction {
  reach: number;
  /**
   * Set for a function defined in a test, fixture or sample file. Nothing in the code calls those: a test runner, a
   * fixture loader or a reader does. See `isNoisePath`.
   */
  noise?: true;
}

/**
 * A call row. `from` is a function id, or the file path for statements that
 * run when the module loads. In files granularity both ends are file paths.
 */
export interface ScopeCall {
  from: string;
  to: string;
  count: number;
  /** True when the callee is outside the scope. */
  external: boolean;
  /** Set on a row for one of several possible targets of a single call. */
  candidate?: true;
}

/** A callee outside the scope, named from its id. `file` is the part of the id before the '#'. */
export interface ScopeExternal {
  id: string;
  name: string;
  file?: string;
}

/** Flow totals of one file. Module-level code counts toward its file. */
export interface ScopeFile {
  file: string;
  functions: number;
  decisions: number;
  loops: number;
  tries: number;
  calledFromOutside?: true;
}

export interface ScopeFlowStats {
  /** Functions defined in the scope, whatever the granularity. */
  functions: number;
  /** Files in the scope: the scope's file list when given, else the files with indexed nodes. */
  files: number;
  /** Call edges that start in the scope. */
  calls: number;
  /** Calls whose target is in the scope. */
  resolved: number;
  /** Calls whose target is outside the scope. */
  external: number;
  /** Calls with no target the IR could name. */
  unresolved: number;
  /** Call edges that start outside the scope and reach a function in it. */
  inbound: number;
  /** Entries: functions in functions granularity, files in files granularity. */
  entries: number;
  /** Functions defined in the scope, noise files included. The same count as `functions`, whatever the granularity. */
  functionsTotal: number;
  /** Functions in test, fixture or sample files, a part of `functionsTotal`. */
  functionsNoise: number;
  /** Functions outside test, fixture and sample files: `functionsTotal` without `functionsNoise`. */
  functionsNonNoise: number;
  /** Unreferenced functions outside test, fixture and sample files: the rows of `unreferenced` without `noise`. */
  unreferenced: number;
  /** Unreferenced functions in test, fixture or sample files. */
  unreferencedNoise: number;
  /** The non-noise unreferenced functions that a caller outside the scope reaches. */
  unreferencedOutside: number;
}

/** The call flow of one scope, from its scoped IR. Pure data: nothing here is laid out. */
export interface ScopeFlow {
  granularity: ScopeGranularity;
  /** Empty in files granularity. */
  functions: ScopeFunction[];
  /**
   * The functions that no function in the scope calls, sorted like `functions`. Computed at every granularity, so a
   * large scope still has its entry points. Test rows are included and marked; the stats count them apart. Anonymous
   * functions are never listed.
   */
  unreferenced: UnreferencedFunction[];
  calls: ScopeCall[];
  externals: ScopeExternal[];
  /** Function ids, or file paths in files granularity: the roots of the call graph. */
  entries: string[];
  /** Files that have a function or module-level code, in path order. */
  files: ScopeFile[];
  stats: ScopeFlowStats;
}
