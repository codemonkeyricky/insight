// The bottom sheet's geometry on a phone: where it rests, where a release lands, and how it gives past its ends. Pure, so the
// rules are unit tested (test/bottomSheet.test.ts). Heights are the sheet's visible height in px: 0 is closed, the top is
// 90% of the viewport. The drag and the spring live in SidePanel, which calls these.
import { momentumOffset } from "../../zoom/spring";

/** The sheet's two rest heights, as a share of the viewport's height. Closed is the third rest. */
export const SHEET_MID = 0.4;
export const SHEET_TOP = 0.9;
/**
 * At or under this width the layout is one column: the file tree and the code pane become overlay drawers (the code one a
 * bottom sheet). Three panes need about 1000 px, so the drawers start there.
 */
export const SHEET_MAX_WIDTH = 999;

export type Rest = "closed" | "mid" | "top";

/** The visible height of each rest on a viewport this tall. */
export function restHeights(vh: number): Record<Rest, number> {
  return { closed: 0, mid: vh * SHEET_MID, top: vh * SHEET_TOP };
}

/**
 * The rest a release lands on: the one nearest the projected end. The end is where the sheet would stop if it kept its
 * release speed and decelerated (see momentumOffset), so a flick carries the sheet past the rest it is near. `velocity` is
 * px/s with up positive, the direction the height grows.
 */
export function landingFor(height: number, velocity: number, vh: number): Rest {
  const end = height + momentumOffset(velocity);
  const at = restHeights(vh);
  let best: Rest = "closed";
  for (const rest of ["mid", "top"] as const) {
    if (Math.abs(end - at[rest]) < Math.abs(end - at[best])) best = rest;
  }
  return best;
}

/**
 * The resistance past a bound: `overshoot` px beyond it moves the sheet by less, more and more, and never past one viewport.
 * Real things slow before they stop, so a drag past an edge reads as responsive rather than frozen.
 */
export function rubberband(overshoot: number, dimension: number, constant = 0.55): number {
  if (overshoot <= 0) return 0;
  return (overshoot * dimension * constant) / (dimension + constant * overshoot);
}

/**
 * The height the sheet shows for a raw drag height: rubber-banded past the top rest, and past the closed rest below it. The
 * closed rest sits at the bottom edge, so the band below it moves the sheet off screen; the release decides the close.
 */
export function resolveHeight(raw: number, vh: number): number {
  const top = vh * SHEET_TOP;
  if (raw > top) return top + rubberband(raw - top, vh);
  if (raw < 0) return -rubberband(-raw, vh);
  return raw;
}
