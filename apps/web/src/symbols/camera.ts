// Pure camera helpers for the Symbols tab's pan and zoom stage: where the camera goes to show an opened box, how the camera
// tween eases and interpolates, the column keys of a chain, and the motion preference. No DOM access beyond a matchMedia read,
// so each is unit tested. A camera maps world (unscaled) coordinates to stage px: screen = world * k + offset.

/** A camera: the scale of the world and where its origin sits in the stage, in px. */
export interface Camera {
  k: number;
  x: number;
  y: number;
}

/** A box in unscaled world coordinates, in px. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A size in px: a stage's, or a box's. */
export interface Size {
  w: number;
  h: number;
}

/** The room kept between a revealed box and the stage's edges, in px. */
export const REVEAL_MARGIN = 24;

/** How long a camera tween runs, in ms. */
export const TWEEN_MS = 320;

/**
 * The offset along one axis that shows a box at the current scale, with `lead` px kept before its start and `trail` px kept
 * after its end. A box already fully visible keeps the offset. A box that is off one edge moves by the least amount that brings
 * it in. A box too big for the stage (with its margins) is aligned to the leading edge at `lead`, so its start is never lost.
 */
function shiftAxis(start: number, len: number, offset: number, k: number, size: number, lead: number, trail: number): number {
  const s0 = start * k + offset;
  const s1 = s0 + len * k;
  if (s0 - lead >= 0 && s1 + trail <= size) return offset;
  if (len * k + lead + trail > size) return lead - start * k;
  if (s0 - lead < 0) return offset + (lead - s0);
  return offset + (size - trail - s1);
}

/**
 * The camera that shows `box` on a stage of `stage` px. Only the translation changes: the scale is never altered. `margin` is kept
 * on the sides and below; `top` (default `margin`) is kept above, so a control laid over the top of the stage stays clear of the box.
 * Returns `cam` itself when the box (with its margins) is already visible, so a caller can tell that nothing needs to move.
 */
export function revealPan(cam: Camera, box: Rect, stage: Size, margin: number = REVEAL_MARGIN, top: number = margin): Camera {
  const x = shiftAxis(box.x, box.w, cam.x, cam.k, stage.w, margin, margin);
  const y = shiftAxis(box.y, box.h, cam.y, cam.k, stage.h, top, margin);
  return x === cam.x && y === cam.y ? cam : { k: cam.k, x, y };
}

/**
 * A cubic-bezier easing curve over [0, 1] with the CSS control points (x1, y1, x2, y2). The curve is found by solving the x
 * component for the parameter (Newton steps, then bisection when Newton stalls), and reading y at that parameter.
 */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sampleX = (s: number) => ((ax * s + bx) * s + cx) * s;
  const sampleY = (s: number) => ((ay * s + by) * s + cy) * s;
  const sampleDX = (s: number) => (3 * ax * s + 2 * bx) * s + cx;
  const solveX = (x: number): number => {
    let s = x;
    for (let i = 0; i < 8; i++) {
      const err = sampleX(s) - x;
      if (Math.abs(err) < 1e-7) return s;
      const d = sampleDX(s);
      if (Math.abs(d) < 1e-7) break;
      s -= err / d;
    }
    let lo = 0;
    let hi = 1;
    s = x;
    for (let i = 0; i < 60; i++) {
      const v = sampleX(s);
      if (Math.abs(v - x) < 1e-7) break;
      if (v < x) lo = s;
      else hi = s;
      s = (lo + hi) / 2;
    }
    return s;
  };
  return (t: number) => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    return sampleY(solveX(t));
  };
}

/** The camera tween's easing: the ease-out curve cubic-bezier(0.22, 1, 0.36, 1). */
export const EASE_OUT = cubicBezier(0.22, 1, 0.36, 1);

/**
 * The camera between `a` and `b` at progress `p` (eased, in [0, 1]): x and y move linearly, and the scale moves logarithmically
 * so a zoom looks even. A non-positive scale falls back to linear.
 */
export function lerpCamera(a: Camera, b: Camera, p: number): Camera {
  const k = a.k > 0 && b.k > 0 ? a.k * Math.pow(b.k / a.k, p) : a.k + (b.k - a.k) * p;
  return { k, x: a.x + (b.x - a.x) * p, y: a.y + (b.y - a.y) * p };
}

/**
 * A key per chain position that stays the same when the chain changes elsewhere. The key is the function's id and how many times
 * the same id occurs earlier in the chain (`id#0`, `id#1`, ...), so a box prepended to the chain keeps the keys of the boxes that
 * were there.
 */
export function columnKeys(chain: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return chain.map((id) => {
    const n = seen.get(id) ?? 0;
    seen.set(id, n + 1);
    return `${id}#${n}`;
  });
}

/** Whether the user asked for reduced motion. False when there is no window (a test or a server render). */
export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
