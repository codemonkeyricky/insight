import { describe, expect, it } from "vitest";
import { fitBox } from "../src/components/views/usePanZoom";

const OPTS = { pad: 16, maxK: 1.15, fitMinK: 0.56 };

describe("fitBox", () => {
  it("floors the scale at fitMinK for a tall single column and top-aligns it", () => {
    // 10000 px tall: the height asks for 0.057, but the fit never goes below 0.56, so the column overflows and starts at the top pad.
    const c = fitBox(100, 10000, 800, 600, OPTS);
    expect(c.k).toBe(0.56);
    expect(c.y).toBe(16);
    expect(c.x).toBeCloseTo((800 - 100 * 0.56) / 2, 9);
  });

  it("left-aligns a wide drawing that is wider than the stage at the floor", () => {
    // 2000 px wide: even at the 0.56 floor it is 1120 px in an 800 px stage, so it starts at the left pad and is panned.
    const c = fitBox(2000, 100, 800, 600, OPTS);
    expect(c.k).toBe(0.56);
    expect(c.x).toBe(16);
    expect(c.y).toBeCloseTo((600 - 100 * 0.56) / 2, 9);
  });

  it("limits a moderately wide drawing by the width and centres it when it fits", () => {
    // 1000 px wide: the width gives 0.768, above the floor, and 768 px fits 800 px, so it is centred.
    const c = fitBox(1000, 100, 800, 600, OPTS);
    expect(c.k).toBeCloseTo(768 / 1000, 9);
    expect(c.x).toBeCloseTo(16, 9);
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
