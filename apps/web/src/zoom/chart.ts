// The Flow tab's chart rules, as pure helpers: when a function box draws its control-flow chart, and which source lines a
// span or a selection covers. No DOM, so they are unit tested. Spans from the IR are 0-based; the source panel is 1-based.
import type { FlowSpan } from "@insight/flow";

/** A function's chart is drawn once it is at least this many pixels wide on screen. Below it the expansion shows only its header. */
export const CHART_MIN_PX = 120;

/** A range of source lines, 1-based and inclusive. */
export interface LineRange {
  start: number;
  end: number;
}

/** The lines a 0-based span covers, 1-based and inclusive. */
export function rangeOf(span: Pick<FlowSpan, "start" | "end">): LineRange {
  return { start: span.start[0] + 1, end: span.end[0] + 1 };
}

/** Whether an expansion draws its chart: wide enough on screen. Narrower, it shows its header only. */
export function chartShown(widthPx: number): boolean {
  return widthPx >= CHART_MIN_PX;
}

/**
 * The lines the source panel highlights: the picked construct's span when there is one, else the whole function's span,
 * else the function's definition line alone.
 */
export function selectionRange(construct: FlowSpan | undefined, fnSpan: FlowSpan | undefined, line: number): LineRange {
  if (construct !== undefined) return rangeOf(construct);
  if (fnSpan !== undefined) return rangeOf(fnSpan);
  return { start: line, end: line };
}
