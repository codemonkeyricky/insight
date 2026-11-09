// The Flow tab's chart rules, as pure helpers: when a function box draws its control-flow chart, and which source lines a
// span or a selection covers. No DOM, so they are unit tested. Spans from the IR are 0-based; the source panel is 1-based.
import type { FlowSpan } from "@insight/flow";

/** A function's chart is drawn once its box is at least this many pixels wide on screen. Below it the box shows only its name. */
export const CHART_MIN_PX = 160;

/** A range of source lines, 1-based and inclusive. */
export interface LineRange {
  start: number;
  end: number;
}

/** The lines a 0-based span covers, 1-based and inclusive. */
export function rangeOf(span: Pick<FlowSpan, "start" | "end">): LineRange {
  return { start: span.start[0] + 1, end: span.end[0] + 1 };
}

/**
 * Whether a box draws its chart. It must hold one, have a function to load it for, be expanded (a click opened it), and be
 * wide enough on screen. Zooming in alone never draws a chart of a box that was not expanded.
 */
export function chartShown(p: { holdsChart: boolean; hasCharts: boolean; hasRef: boolean; expanded: boolean; widthPx: number }): boolean {
  return p.holdsChart && p.hasCharts && p.hasRef && p.expanded && p.widthPx >= CHART_MIN_PX;
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
