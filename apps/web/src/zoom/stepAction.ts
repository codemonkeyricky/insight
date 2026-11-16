// What a gesture on a chart row does. A single click only selects; opening or folding is a separate gesture (double-click,
// Enter or Space on the focused row, or a click on the row's chevron). ZoomMap runs the result; this only decides.
import type { FlowNode } from "@insight/flow";
import type { StepRuntime } from "../flowTargets";

/**
 * The callee a row opens: its target, unless the row is a state row (a read or write of a variable calls nothing) or the
 * target is the row's own function. Undefined when the row has no callee.
 */
export function stepCallee(node: Pick<FlowNode, "role" | "target">, owner: string | undefined): string | undefined {
  if (node.role === "state" || node.target === undefined || node.target === owner) return undefined;
  return node.target;
}

export type StepGesture = "click" | "open";
export type StepActionKind = "select" | "inline" | "fold" | "fork" | "lambda" | "unfold" | "none";

/** The facts about a row the decision needs. */
export interface StepContext {
  /** Whether the step calls a function other than the one that owns the row (`node.target` resolved to a callee). */
  hasCallee: boolean;
  /** Whether that callee is a lambda (a closure inside the caller, or a function folded into its owner). */
  isLambda: boolean;
  /** Where the callee runs (see stepRuntime): "same" nests in the step; another thread or process opens as a parallel line. */
  runtime: StepRuntime;
  /** Whether the row has something to select. Default true. */
  selectable?: boolean;
}

export function stepAction(node: Pick<FlowNode, "shape" | "handler" | "foldId">, gesture: StepGesture, ctx: StepContext): StepActionKind {
  if (gesture === "click") return ctx.selectable === false ? "none" : "select";
  // A `⋯ n local` fold row opens to show the rows it folds (the coupling view).
  if (node.foldId !== undefined) return "unfold";
  if (node.shape === "nest" || node.shape === "fork") return "fold";
  if (!ctx.hasCallee) return "none";
  // A handler (`ctx.onmessage = (e) => …`) is how a worker processes its messages: it opens, even as a folded lambda.
  if (node.handler !== true && ctx.isLambda) return "lambda";
  return ctx.runtime === "same" ? "inline" : "fork";
}
