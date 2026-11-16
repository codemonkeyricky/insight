// The zoom map's pointer rule: which box a world point stands in. Zooming and panning are purely geometric; they never
// open or close a box. Only a click, a key or a link opens one (ZoomMap). Pure, so it is unit tested.
import { deepestAt, nearestBox, type Box } from "./source";

/**
 * A gap between boxes this close on screen (px) still counts as the nearest box: Enter that is pressed in a gap opens the
 * nearest box within it.
 */
export const GAP_PX = 60;

/** The box a world point stands in: the deepest box under it, or else the nearest box within GAP_PX on screen. */
export function pickBox(boxes: readonly Box[], depth: (id: string) => number, x: number, y: number, k: number): string | undefined {
  return deepestAt(boxes, depth, x, y) ?? nearestBox(boxes, depth, x, y, GAP_PX / k);
}

/**
 * Whether d3-zoom takes a DOM event. It is d3's default filter (no ctrl-wheel pinch exception, no secondary button) except
 * that a double-click on a chart row is the row's: d3 would zoom the map on it and stop the event, so the row's own
 * handler (open or fold) never ran. A double-click on a map control (a Callers button, a callers box, a close ×) is the
 * control's two clicks, not a zoom: React's stopPropagation runs after d3's listener on the svg, so it cannot stop it. A
 * double-click on a function box opens or closes its chart (boxAction), so it does not zoom either.
 *
 * d3 also turns a double-tap on touch into that double-click: its touchend reaches this filter as a `touchend` event, so the
 * same rule applies to it. A single touch that starts a pan on a box is still taken.
 */
export function zoomTakes(ev: { type: string; ctrlKey?: boolean; button?: number; target?: unknown }): boolean {
  if (ev.type === "dblclick" || ev.type === "touchend") {
    const t = ev.target as { closest?: (sel: string) => unknown } | null | undefined;
    if (t && typeof t.closest === "function" && t.closest("svg.flow, .zm-callers-btn, .zm-callers, .zm-expansion-close, .zm-box:not(.zm-external)") !== null) return false;
  }
  return (ev.ctrlKey !== true || ev.type === "wheel") && !ev.button;
}
