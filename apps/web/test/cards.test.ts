import { describe, expect, it } from "vitest";
import { aggregateEdges, cardKeyAt, farEdgeWidth, groupCards, medianOf, pickCardDepth, placeBadges, segmentsBelow } from "../src/zoom/cards.js";

describe("groupCards", () => {
  it("unions the boxes of each group and grows the card by the pad", () => {
    const cards = groupCards(
      [
        { id: "a", rect: { x: 0, y: 0, w: 10, h: 10 }, group: "g1" },
        { id: "b", rect: { x: 20, y: 5, w: 10, h: 10 }, group: "g1" },
        { id: "c", rect: { x: 100, y: 100, w: 10, h: 10 }, group: "g2" },
      ],
      2,
    );
    const g1 = cards.find((c) => c.id === "g1")!;
    expect(g1.rect).toEqual({ x: -2, y: -2, w: 34, h: 19 });
    expect(g1.ids).toEqual(["a", "b"]);
    const g2 = cards.find((c) => c.id === "g2")!;
    expect(g2.ids).toEqual(["c"]);
  });
});

describe("aggregateEdges", () => {
  const cardOf = (id: string) => ({ a1: "A", a2: "A", b1: "B", c1: "C" })[id];

  it("sums calls per unordered card pair and drops same-card and unknown calls", () => {
    const agg = aggregateEdges(
      [
        { from: "a1", to: "b1", count: 2 },
        { from: "b1", to: "a2", count: 3 },
        { from: "a1", to: "a2", count: 9 },
        { from: "a1", to: "zz", count: 4 },
        { from: "c1", to: "b1", count: 1 },
      ],
      cardOf,
    );
    expect(agg).toHaveLength(2);
    expect(agg.find((e) => e.a === "A" && e.b === "B")?.count).toBe(5);
    expect(agg.find((e) => e.a === "B" && e.b === "C")?.count).toBe(1);
  });
});

describe("farEdgeWidth", () => {
  it("grows monotonically with the count and is capped", () => {
    let prev = farEdgeWidth(0);
    for (const n of [1, 2, 4, 8, 16, 100, 10000]) {
      const w = farEdgeWidth(n);
      expect(w).toBeGreaterThanOrEqual(prev);
      prev = w;
    }
    expect(farEdgeWidth(1e9)).toBeLessThanOrEqual(6);
    expect(farEdgeWidth(0)).toBeGreaterThanOrEqual(1);
  });
});

describe("placeBadges", () => {
  it("keeps every badge at least minDist from the badges before it", () => {
    const pts = [
      { x: 10, y: 10 },
      { x: 10, y: 10 },
      { x: 12, y: 11 },
      { x: 100, y: 100 },
    ];
    const out = placeBadges(pts, 14);
    expect(out).toHaveLength(pts.length);
    for (let i = 0; i < out.length; i++) {
      for (let j = 0; j < i; j++) {
        expect(Math.hypot(out[i]!.x - out[j]!.x, out[i]!.y - out[j]!.y)).toBeGreaterThanOrEqual(14);
      }
    }
    expect(out[3]).toEqual({ x: 100, y: 100 });
  });
});

describe("medianOf", () => {
  it("handles odd, even, and empty lists", () => {
    expect(medianOf([])).toBe(0);
    expect(medianOf([5, 1, 3])).toBe(3);
    expect(medianOf([4, 1, 3, 2])).toBe(2.5);
  });
});

describe("card depth", () => {
  it("takes the path below the scope, and a file outside it keeps its segments", () => {
    expect(segmentsBelow("src/physics/faceCam.ts", "src")).toEqual(["physics", "faceCam.ts"]);
    expect(segmentsBelow("lib/x.ts", "src")).toEqual(["lib", "x.ts"]);
    expect(segmentsBelow("src", "src")).toEqual([]);
    expect(segmentsBelow("a/b.ts", "")).toEqual(["a", "b.ts"]);
  });

  it("picks the shallowest depth with at least three cards, descending to files when needed", () => {
    const segs = [
      ["parts", "gear.ts"],
      ["parts", "shaft.ts"],
      ["physics", "faceCam.ts"],
      ["physics", "solver.ts"],
      ["util", "math.ts"],
    ];
    // Depth 1: parts, physics, util, three cards.
    expect(pickCardDepth(segs)).toBe(1);
    // Two folders only: depth 1 gives 2 cards, so descend to the files (depth 2).
    expect(pickCardDepth(segs.slice(0, 4))).toBe(2);
    expect(cardKeyAt(["physics", "faceCam.ts"], 1)).toBe("physics");
    expect(cardKeyAt(["util", "math.ts"], 2)).toBe("util/math.ts");
  });
});
