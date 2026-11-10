import { describe, expect, it } from "vitest";
import { CROSSFADE_BOXES, TWEEN_MS, cameraBetween, cubicBezier, ease, lerp, motionFor, progressAt } from "../src/zoom/tween";

describe("cubicBezier", () => {
  it("is 0 at the start, 1 at the end, and monotonic in between", () => {
    expect(ease(0)).toBe(0);
    expect(ease(1)).toBe(1);
    let prev = 0;
    for (let i = 1; i <= 20; i++) {
      const y = ease(i / 20);
      expect(y).toBeGreaterThanOrEqual(prev);
      prev = y;
    }
  });

  it("is fast out: most of the way by the middle of the time (cubic-bezier 0.2, 0, 0, 1)", () => {
    expect(ease(0.5)).toBeGreaterThan(0.8);
  });

  it("matches a linear curve for the linear control points", () => {
    const linear = cubicBezier(1 / 3, 1 / 3, 2 / 3, 2 / 3);
    expect(linear(0.37)).toBeCloseTo(0.37, 3);
  });
});

describe("progressAt", () => {
  it("runs from 0 at the start to 1 after the duration, eased", () => {
    expect(progressAt(1000, 1000)).toBe(0);
    expect(progressAt(1000, 1000 + TWEEN_MS)).toBe(1);
    expect(progressAt(1000, 1000 + TWEEN_MS * 2)).toBe(1);
    expect(progressAt(1000, 1000 + TWEEN_MS / 2)).toBeCloseTo(ease(0.5), 9);
  });

  it("retargets from where a move is: a new start resets the clock without a jump in value", () => {
    const mid = progressAt(0, TWEEN_MS / 2);
    // A retarget at the midpoint starts a new move from zero progress; the value on screen is carried by the caller.
    expect(progressAt(TWEEN_MS / 2, TWEEN_MS / 2)).toBe(0);
    expect(mid).toBeGreaterThan(0);
  });
});

describe("motionFor", () => {
  it("moves on a normal map and crossfades under reduced motion or on a crowded one", () => {
    expect(motionFor({ reduced: false, boxes: 40 })).toBe("move");
    expect(motionFor({ reduced: true, boxes: 40 })).toBe("fade");
    expect(motionFor({ reduced: false, boxes: CROSSFADE_BOXES })).toBe("move");
    expect(motionFor({ reduced: false, boxes: CROSSFADE_BOXES + 1 })).toBe("fade");
  });
});

describe("lerp and cameraBetween", () => {
  it("blends numbers linearly", () => {
    expect(lerp(2, 10, 0.25)).toBe(4);
  });

  it("blends the camera's position linearly and its scale on a log axis", () => {
    const from = { k: 1, x: 0, y: 0 };
    const to = { k: 4, x: 100, y: -40 };
    expect(cameraBetween(from, to, 0)).toEqual(from);
    const end = cameraBetween(from, to, 1);
    expect(end.k).toBeCloseTo(4, 9);
    expect(end.x).toBe(100);
    expect(end.y).toBe(-40);
    // Halfway in log space between 1 and 4 is 2, not 2.5.
    expect(cameraBetween(from, to, 0.5).k).toBeCloseTo(2, 9);
  });
});
