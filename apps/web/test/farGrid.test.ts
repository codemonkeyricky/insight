import { describe, expect, it } from "vitest";
import { boundaryPoint, cardSize, FAR_GAP, FAR_MAX, FAR_MIN, linkPath, packCards, type FarPlaced } from "../src/zoom/farGrid.js";

const overlap = (a: FarPlaced, b: FarPlaced) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

function items(n: number, seed = 7): { id: string; count: number }[] {
  let s = seed;
  const rnd = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  return Array.from({ length: n }, (_, i) => ({ id: `c${i}`, count: 1 + Math.floor(rnd() * 300) }));
}

describe("packCards", () => {
  it("never overlaps and stays inside the width and the height used", () => {
    for (const width of [358, 700, 1100]) {
      for (const n of [1, 3, 8, 23]) {
        const { placed, height } = packCards(items(n), width);
        expect(placed).toHaveLength(n);
        for (const p of placed) {
          expect(p.x).toBeGreaterThanOrEqual(0);
          expect(p.y).toBeGreaterThanOrEqual(0);
          expect(p.x + p.w).toBeLessThanOrEqual(width + 1e-9);
          expect(p.y + p.h).toBeLessThanOrEqual(height + 1e-9);
        }
        for (let i = 0; i < placed.length; i++) for (let j = i + 1; j < placed.length; j++) expect(overlap(placed[i]!, placed[j]!)).toBe(false);
      }
    }
  });

  it("sorts by count, largest first, and keeps the input order for equal counts", () => {
    const input = [
      { id: "a", count: 5 },
      { id: "b", count: 40 },
      { id: "c", count: 5 },
      { id: "d", count: 40 },
      { id: "e", count: 1 },
    ];
    const { placed } = packCards(input, 1000);
    expect(placed.map((p) => p.id)).toEqual(["b", "d", "a", "c", "e"]);
  });

  it("clamps the card size between the minimum and the maximum", () => {
    expect(cardSize(0, 100)).toEqual(FAR_MIN);
    expect(cardSize(100, 100)).toEqual(FAR_MAX);
    const mid = cardSize(25, 100);
    expect(mid.w).toBeGreaterThan(FAR_MIN.w);
    expect(mid.w).toBeLessThan(FAR_MAX.w);
  });

  it("fills two columns on a phone-width area", () => {
    const { placed } = packCards(items(6), 358);
    const xs = new Set(placed.map((p) => Math.round(p.x)));
    expect(xs).toEqual(new Set([0, Math.round((358 - FAR_GAP) / 2 + FAR_GAP)]));
    for (const p of placed) expect(p.w).toBeCloseTo((358 - FAR_GAP) / 2);
  });

  it("returns nothing for no cards", () => {
    expect(packCards([], 500)).toEqual({ placed: [], height: 0 });
  });
});

describe("boundaryPoint and linkPath", () => {
  it("leaves a rect on the side that faces the target", () => {
    const a = { x: 0, y: 0, w: 100, h: 50 };
    expect(boundaryPoint(a, { x: 500, y: 25 })).toEqual({ x: 100, y: 25 });
    expect(boundaryPoint(a, { x: 50, y: 500 })).toEqual({ x: 50, y: 50 });
  });

  it("links two cards with a curve from edge to edge", () => {
    const d = linkPath({ x: 0, y: 0, w: 100, h: 50 }, { x: 300, y: 0, w: 100, h: 50 });
    expect(d.startsWith("M100 25Q")).toBe(true);
    expect(d.endsWith(" 300 25")).toBe(true);
  });
});
