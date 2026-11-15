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
// output must stay byte for byte the same. They were retaken when trunks were routed around other process frames (fix 5), when
// coroutines stopped being folded by default when the process subtitle started counting recursively, and when edges got 4 px clearance with end stubs and the band hugged its content.
describe("layout output is unchanged by the optimisation", () => {
  it("matches the hashes of the original layout for synthetic models and the fixture", () => {
    for (const [c, e, plain, collapsed] of [[50, 200, "782c9e60eead", "f4f4cc6d075b"], [200, 800, "09c655cd2391", "11fdc6df3f4c"]] as const) {
      const m = synthModel(c, e);
      const l = layoutSystemFrames(m);
      expect(hashOf(l)).toBe(plain);
      const ids = (l.frames ?? []).map((f) => f.id);
      expect(hashOf(layoutSystemFrames(m, { collapsed: new Set(ids.slice(0, 3)), widened: new Set(ids.slice(3, 6)) }))).toBe(collapsed);
    }
    expect(hashOf(layoutSystemFrames(model()))).toBe("e28fb615b5ae");
    expect(hashOf(layoutSystemFrames(model(), { collapsed: new Set(["thread:worker"]) }))).toBe("a9b48571a773");
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
    // Wall-clock limits are deliberately loose: they fail at random on a loaded machine. They still catch the old
    // quadratic behaviour (about 1.7 s and 13 s before the optimisation).
    expect(ms200).toBeLessThan(1000);
    expect(ms400).toBeLessThan(2000);
  }, 60000);
});
