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
export type FlowShape = "terminator" | "step" | "decision" | "loop" | "label" | "join" | "exit";

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
  x: number;
  y: number;
  w: number;
  h: number;
}

export type FlowEdgeKind = "next" | "true" | "false" | "case" | "back" | "exit" | "exception" | "each";

export interface FlowEdge {
  from: string;
  to: string;
  kind: FlowEdgeKind;
  label?: string;
  /** Where the label sits. */
  labelAt?: [number, number];
  /** Polyline from the source node to the target node. */
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
}

export interface FileFlow {
  file: string;
  functions: FunctionFlow[];
}
