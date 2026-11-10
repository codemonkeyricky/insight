// The zoom map's motion timing: one curve and one duration for every move the map makes (the camera, the side slide of the
// columns, an expansion's entrance and exit), so they read as one motion. Time-based, so a move can be retargeted from where
// it is (progressAt takes the start of the move, not its length left). Pure, so these rules are unit tested
// (test/tween.test.ts).
import type { Camera } from "@insight/flow";

/** The duration of a move: an entrance, a camera move, or a slide. */
export const TWEEN_MS = 260;
/** The duration of an exit: a closing detail fades out this fast. */
export const EXIT_MS = 120;
/** The delay of a detail's callout after its entrance starts, so the edge reads after the box it leads to. */
export const EDGE_DELAY_MS = 120;
/** Above this many boxes on the map, moves crossfade instead of sliding: sliding hundreds of boxes costs more than it shows. */
export const CROSSFADE_BOXES = 400;

/** The curve, as the CSS cubic-bezier it stands for: fast out, a long soft settle. */
export const EASE_CSS = "cubic-bezier(0.2, 0, 0, 1)";

/**
 * A CSS cubic-bezier easing function: the value of y at the x that `t` names. Solved by bisection on the curve's x, which is
 * monotonic for x1 and x2 in [0, 1], so the result is exact to the curve's precision.
 */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  const at = (s: number, a: number, b: number) => {
    const u = 1 - s;
    return 3 * u * u * s * a + 3 * u * s * s * b + s * s * s;
  };
  return (t: number) => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      if (at(mid, x1, x2) < t) lo = mid;
      else hi = mid;
    }
    return at((lo + hi) / 2, y1, y2);
  };
}

/** The map's easing: cubic-bezier(0.2, 0, 0, 1). */
export const ease = cubicBezier(0.2, 0, 0, 1);

/**
 * The eased progress of a move that started at `startMs`, `now` (both in ms). Clamped to [0, 1]: at `startMs` it is 0, and
 * from `startMs + durMs` on it is 1.
 */
export function progressAt(startMs: number, now: number, durMs: number = TWEEN_MS): number {
  const t = durMs <= 0 ? 1 : (now - startMs) / durMs;
  return ease(Math.min(1, Math.max(0, t)));
}

/** How a move is drawn: `move` slides and scales, `fade` only changes opacity (reduced motion, or a crowded map). */
export type MotionMode = "move" | "fade";

/** The mode of a move on a map of `boxes` boxes: reduced motion and a crowded map crossfade, everything else moves. */
export function motionFor(opts: { reduced: boolean; boxes: number }): MotionMode {
  return opts.reduced || opts.boxes > CROSSFADE_BOXES ? "fade" : "move";
}

/** A linear blend of two numbers at `t` (0 gives `a`, 1 gives `b`). */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * The camera at progress `t` between `from` and `to`. The scale blends on a log axis, so a zoom feels even at every scale
 * (the same as the spring's log axis).
 */
export function cameraBetween(from: Camera, to: Camera, t: number): Camera {
  const logK = lerp(Math.log(from.k), Math.log(to.k), t);
  return { k: Math.exp(logK), x: lerp(from.x, to.x, t), y: lerp(from.y, to.y, t) };
}
