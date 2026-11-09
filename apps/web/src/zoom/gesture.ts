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
