// What a gesture on a function box does on the zoom map. A single click only selects. A double-click opens the box's own
// chart in a new box to its right, or closes that side box when it is open. Enter, and a link, toggle the chart in place,
// as they always have. ZoomMap runs the result; this only decides. Pure, so it is unit tested.

/** A click, a double-click, or Enter on a focused box. */
export type BoxGesture = "click" | "dblclick" | "enter";

/**
 * What the box does: `select` only selects it; `open-side` opens its chart in a box beside it and `close-side` closes that
 * box; `toggle` opens or closes its chart in place; `navigate` opens the box as a link does (a box with no chart).
 */
export type BoxActionKind = "select" | "open-side" | "close-side" | "toggle" | "navigate";

/** The facts about a box the decision needs. */
export interface BoxContext {
  /** Whether the box has a chart to show (a function with a chart). */
  hasChart: boolean;
  /** Whether the box's chart is open, in place or beside the box. Default false. */
  open?: boolean;
  /** Whether the click came from a touch or pen pointer. A single tap on a box with a chart acts like a double-click. Default false. */
  touch?: boolean;
}

/** Whether a pointer type is a touch or a pen: the pointers that have no reliable double-click. */
export function isTouchPointer(pointerType: string): boolean {
  return pointerType === "touch" || pointerType === "pen";
}

export function boxAction(gesture: BoxGesture, ctx: BoxContext): BoxActionKind {
  if (gesture === "enter") return ctx.hasChart ? "toggle" : "navigate";
  // A box with no chart opens as a link does, whether it was clicked or double-clicked.
  if (!ctx.hasChart) return "navigate";
  // A mouse click only selects a box with a chart; a touch or pen tap opens its chart beside it, as a double-click does.
  if (gesture === "click" && ctx.touch !== true) return "select";
  return ctx.open === true ? "close-side" : "open-side";
}
