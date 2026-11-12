import { describe, expect, it } from "vitest";
import { fitBox } from "../src/components/views/usePanZoom";

const OPTS = { pad: 16, maxK: 1.15, minK: 0.1 };

describe("fitBox", () => {
  it("limits wide content by the width and keeps it centred within the pad", () => {
    // 2000 px wide in an 800 px stage: the width sets the scale, so the content spans the stage less the pad.
    const c = fitBox(2000, 100, 800, 600, OPTS);
    expect(c.k).toBeCloseTo(768 / 2000, 9);
    expect(c.x).toBeCloseTo(16, 9);
    expect(c.y).toBeCloseTo((600 - 100 * c.k) / 2, 9);
  });

  it("top-aligns tall content that is still taller than the stage at the minimum scale", () => {
    // 10000 px tall: even at the 0.1 minimum it overflows a 600 px stage, so it starts at the pad from the top.
    const c = fitBox(100, 10000, 800, 600, OPTS);
    expect(c.k).toBe(0.1);
    expect(c.y).toBe(16);
    expect(c.x).toBeCloseTo((800 - 100 * 0.1) / 2, 9);
  });

  it("caps small content at the maximum scale and centres it", () => {
    const c = fitBox(100, 50, 800, 600, OPTS);
    expect(c.k).toBe(1.15);
    expect(c.x).toBeCloseTo((800 - 115) / 2, 9);
    expect(c.y).toBeCloseTo((600 - 57.5) / 2, 9);
  });

  it("returns the identity camera for an empty box or stage", () => {
    expect(fitBox(0, 100, 800, 600, OPTS)).toEqual({ k: 1, x: 0, y: 0 });
    expect(fitBox(100, 100, 0, 600, OPTS)).toEqual({ k: 1, x: 0, y: 0 });
  });
});
