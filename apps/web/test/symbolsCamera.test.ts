import { describe, expect, it } from "vitest";
import { columnKeys, cubicBezier, EASE_OUT, lerpCamera, revealPan, type Camera } from "../src/symbols/camera";
import { connectorPath, offsetWithin } from "../src/symbols/connectors";

const CAM: Camera = { k: 1, x: 0, y: 0 };
const STAGE = { w: 800, h: 600 };

describe("revealPan", () => {
  it("returns the same camera when the box, with its margin, is already visible", () => {
    const cam = { k: 1.2, x: 10, y: 20 };
    // At k 1.2 the box is at screen x 10 + 300 * 1.2 = 370 .. 370 + 120, well inside 800 with the margin.
    expect(revealPan(cam, { x: 300, y: 100, w: 100, h: 100 }, STAGE)).toBe(cam);
  });

  it("moves the minimal amount when the box is off the right edge, and never changes k", () => {
    // Screen right edge at 900 + 100 = 1000; the stage keeps 24 px, so the camera moves left by 1000 + 24 - 800 = 224.
    const next = revealPan(CAM, { x: 900, y: 100, w: 100, h: 100 }, STAGE);
    expect(next.x).toBe(-224);
    expect(next.y).toBe(0);
    expect(next.k).toBe(1);
    // After the move the right edge sits exactly the margin inside the stage.
    expect(900 + 100 + next.x).toBe(800 - 24);
  });

  it("moves the minimal amount when the box is off the left edge", () => {
    const next = revealPan({ k: 1, x: -500, y: 0 }, { x: 100, y: 0, w: 100, h: 100 }, STAGE);
    // The box starts at screen x 100 - 500 = -400. The least move starts it at the 24 px margin: the offset goes to -76.
    expect(next.x).toBe(-76);
    expect(100 + next.x).toBe(24);
    expect(next.k).toBe(1);
  });

  it("aligns a box wider than the stage to the left margin, and never changes k", () => {
    const next = revealPan({ k: 1, x: 200, y: 0 }, { x: 0, y: 0, w: 1000, h: 50 }, STAGE);
    expect(next.x).toBe(24);
    expect(next.k).toBe(1);
  });

  it("aligns a box taller than the stage to the top margin", () => {
    const next = revealPan({ k: 0.5, x: 0, y: 300 }, { x: 0, y: 0, w: 100, h: 2000 }, STAGE);
    expect(next.y).toBe(24);
    expect(next.k).toBe(0.5);
  });

  it("checks the scaled size: a box that fits at a small scale is revealed by a minimal move", () => {
    // 400 world px at k 0.5 is 200 screen px, which fits 800 with the margin: the box is off the right edge, so it moves minimally.
    const next = revealPan({ k: 0.5, x: 0, y: 0 }, { x: 1800, y: 0, w: 400, h: 100 }, STAGE);
    expect(next.k).toBe(0.5);
    expect(1800 * 0.5 + next.x + 200).toBe(800 - 24);
  });
});

describe("revealPan top margin", () => {
  it("keeps a separate top margin above the box, so a control over the stage's top stays clear", () => {
    // A box at the very top of the stage: with the default margin it is pushed down by 24 px; with a 48 px top it is pushed by 48.
    const box = { x: 0, y: 0, w: 100, h: 100 };
    const stage = { w: 800, h: 600 };
    expect(revealPan({ k: 1, x: 0, y: 0 }, box, stage).y).toBe(24);
    expect(revealPan({ k: 1, x: 0, y: 0 }, box, stage, 24, 48).y).toBe(48);
    // A box already clear of both margins (24 px at the sides, 48 px at the top) does not move.
    const clear = { k: 1, x: 24, y: 48 };
    expect(revealPan(clear, box, stage, 24, 48)).toBe(clear);
  });
});

describe("cubicBezier and the camera easing", () => {
  it("starts at 0 and ends at 1", () => {
    expect(EASE_OUT(0)).toBe(0);
    expect(EASE_OUT(1)).toBe(1);
    const linear = cubicBezier(0, 0, 1, 1);
    expect(linear(0.3)).toBeCloseTo(0.3, 4);
  });

  it("is monotonic and an ease-out curve (ahead of the linear line at the midpoint)", () => {
    let prev = -1;
    for (let i = 0; i <= 100; i++) {
      const v = EASE_OUT(i / 100);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
    expect(EASE_OUT(0.5)).toBeGreaterThan(0.8);
  });

  it("interpolates x and y linearly and k logarithmically", () => {
    const a: Camera = { k: 1, x: 0, y: 0 };
    const b: Camera = { k: 4, x: 100, y: -50 };
    expect(lerpCamera(a, b, 0)).toEqual(a);
    expect(lerpCamera(a, b, 1)).toEqual(b);
    const mid = lerpCamera(a, b, 0.5);
    expect(mid.x).toBe(50);
    expect(mid.y).toBe(-25);
    // The geometric mean of 1 and 4 is 2.
    expect(mid.k).toBeCloseTo(2, 9);
  });
});

describe("columnKeys", () => {
  it("gives each position the function id and the count of earlier occurrences", () => {
    expect(columnKeys(["a", "b", "a"])).toEqual(["a#0", "b#0", "a#1"]);
    expect(columnKeys([])).toEqual([]);
  });

  it("keeps the keys of the boxes that were there when a caller is prepended", () => {
    const before = columnKeys(["b", "c"]);
    const after = columnKeys(["x", "b", "c"]);
    expect(after.slice(1)).toEqual(before);
    expect(after[0]).toBe("x#0");
  });
});

describe("connector geometry", () => {
  it("offsetWithin sums the offsets up the offsetParent chain to the root", () => {
    const root = { offsetLeft: 0, offsetTop: 0, offsetParent: null };
    const column = { offsetLeft: 300, offsetTop: 24, offsetParent: root };
    const row = { offsetLeft: 20, offsetTop: 40, offsetParent: column };
    expect(offsetWithin(row, root)).toEqual({ x: 320, y: 64 });
    expect(offsetWithin(column, root)).toEqual({ x: 300, y: 24 });
    expect(offsetWithin(root, root)).toEqual({ x: 0, y: 0 });
  });

  it("connectorPath runs from the row's right edge to the box's left edge, through two control points", () => {
    expect(connectorPath({ right: 100, y: 10 }, { left: 300, y: 50 }, 72)).toBe("M 100 10 C 136 10, 264 50, 300 50");
  });
});
