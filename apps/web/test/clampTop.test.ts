import { describe, expect, it } from "vitest";
import { clampTop } from "../src/zoom/clampTop.js";

describe("clampTop", () => {
  it("leaves a camera unchanged when the scene's top is already at the reserve or above it", () => {
    const c = { x: 10, y: 20, k: 1 };
    expect(clampTop(c, 0, 84)).toEqual(c);
    expect(clampTop({ x: 10, y: 84, k: 1 }, 0, 84)).toEqual({ x: 10, y: 84, k: 1 });
  });

  it("moves the camera up so the scene's top lands at the reserve when the content sits far below", () => {
    // Scene top at world y 300, k 1: on screen it starts at 300 + 380 = 680. The clamp lands it at 84.
    const out = clampTop({ x: 5, y: 380, k: 1 }, 300, 84);
    expect(out.y + 300 * out.k).toBe(84);
    expect(out.y).toBe(-216);
    expect(out.x).toBe(5);
    expect(out.k).toBe(1);
  });

  it("respects the scale: the scene's top is placed by sceneTop times k", () => {
    const out = clampTop({ x: 0, y: 500, k: 2 }, 100, 84);
    expect(out.y).toBe(84 - 100 * 2);
    expect(out.y + 100 * out.k).toBe(84);
    expect(out.k).toBe(2);
  });
});
