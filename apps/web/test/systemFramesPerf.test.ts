import { describe, expect, it } from "vitest";
import { layoutSystemFrames } from "../src/arch/system-frames";
import { hashOf, synthModel } from "./systemBench";
import { model } from "./systemFixtures";

const time = <T,>(f: () => T): { ms: number; out: T } => {
  const t = performance.now();
  const out = f();
  return { ms: performance.now() - t, out };
};

// The hashes were taken from the layout before it was optimised (lookups by id, an obstacle grid, a precomputed lattice): the
// output must stay byte for byte the same.
describe("layout output is unchanged by the optimisation", () => {
  it("matches the hashes of the original layout for synthetic models and the fixture", () => {
    for (const [c, e, plain, collapsed] of [[50, 200, "3713bab22029", "1e535a06d31f"], [200, 800, "ccc2f3955452", "4cf34a5c0f4f"]] as const) {
      const m = synthModel(c, e);
      const l = layoutSystemFrames(m);
      expect(hashOf(l)).toBe(plain);
      const ids = (l.frames ?? []).map((f) => f.id);
      expect(hashOf(layoutSystemFrames(m, { collapsed: new Set(ids.slice(0, 3)), widened: new Set(ids.slice(3, 6)) }))).toBe(collapsed);
    }
    expect(hashOf(layoutSystemFrames(model()))).toBe("051d148cab93");
    expect(hashOf(layoutSystemFrames(model(), { collapsed: new Set(["thread:worker"]) }))).toBe("56d06544d022");
  });
});

describe("layout time", () => {
  it("lays out 200 components / 800 edges and 400 / 2000 edges quickly (before: ~1700 ms and ~13000 ms)", () => {
    layoutSystemFrames(synthModel(50, 200)); // warm up
    const best = (c: number, e: number): number => {
      const m = synthModel(c, e);
      return Math.min(...[0, 1, 2].map(() => time(() => layoutSystemFrames(m)).ms));
    };
    const ms200 = best(200, 800);
    const ms400 = best(400, 2000);
    console.log(`layout 200/800: ${Math.round(ms200)} ms, 400/2000: ${Math.round(ms400)} ms`);
    expect(ms200).toBeLessThan(200);
    expect(ms400).toBeLessThan(400);
  }, 60000);
});
