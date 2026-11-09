import { describe, expect, it } from "vitest";
import { ZONE_ORIGIN, ZONE_SIZE, zoneAt, zoneCells, zoneLetter, zoneLines, zoneOf } from "../src/zoom/zones.js";

describe("zoneLetter", () => {
  it("counts A to Z, then AA, AB", () => {
    expect(zoneLetter(0)).toBe("A");
    expect(zoneLetter(2)).toBe("C");
    expect(zoneLetter(25)).toBe("Z");
    expect(zoneLetter(26)).toBe("AA");
    expect(zoneLetter(27)).toBe("AB");
  });

  it("reads a negative index as A", () => {
    expect(zoneLetter(-3)).toBe("A");
  });
});

describe("zoneAt", () => {
  it("puts the origin in zone A1", () => {
    expect(zoneAt(ZONE_ORIGIN, ZONE_ORIGIN)).toEqual({ col: 0, row: 0, label: "A1" });
  });

  it("steps one zone per ZONE_SIZE, column letter then row number", () => {
    expect(zoneAt(ZONE_ORIGIN + 2 * ZONE_SIZE + 1, ZONE_ORIGIN + 3 * ZONE_SIZE + 1).label).toBe("C4");
  });

  it("puts a point left of or above the origin in the first zone", () => {
    expect(zoneAt(-10000, -10000).label).toBe("A1");
  });
});

describe("zoneOf", () => {
  it("uses the centre, so a box across a zone line belongs to the zone its middle is in", () => {
    const edge = ZONE_ORIGIN + ZONE_SIZE;
    // Starts in A1 and ends in B1; the centre is 10 units into B1, so it is B1. A narrower box keeps its centre in A1.
    expect(zoneOf({ x: edge - 100, y: ZONE_ORIGIN, w: 220, h: 20 }).label).toBe("B1");
    expect(zoneOf({ x: edge - 100, y: ZONE_ORIGIN, w: 150, h: 20 }).label).toBe("A1");
  });
});

describe("zoneCells", () => {
  it("has no cells for an empty rectangle", () => {
    expect(zoneCells({ x: 0, y: 0, w: 0, h: 100 })).toEqual([]);
  });

  it("clips each cell to the rectangle", () => {
    const cells = zoneCells({ x: ZONE_ORIGIN + 100, y: ZONE_ORIGIN, w: ZONE_SIZE, h: 50 });
    expect(cells.map((c) => c.label)).toEqual(["A1", "B1"]);
    expect(cells[0]).toMatchObject({ x: ZONE_ORIGIN + 100, w: ZONE_SIZE - 100, h: 50 });
    expect(cells[1]).toMatchObject({ x: ZONE_ORIGIN + ZONE_SIZE, w: 100, h: 50 });
  });

  it("covers the rectangle with cells whose widths and heights add up", () => {
    const bounds = { x: 0, y: 0, w: 1000, h: 700 };
    const cells = zoneCells(bounds);
    const area = cells.reduce((n, c) => n + c.w * c.h, 0);
    expect(area).toBe(bounds.w * bounds.h);
    for (const c of cells) {
      expect(c.x).toBeGreaterThanOrEqual(bounds.x);
      expect(c.x + c.w).toBeLessThanOrEqual(bounds.x + bounds.w);
    }
  });
});

describe("zoneLines", () => {
  it("is empty for an empty rectangle", () => {
    expect(zoneLines({ x: 0, y: 0, w: 0, h: 0 })).toBe("");
  });

  it("draws the grid lines inside the rectangle, including its edges", () => {
    const line = zoneLines({ x: ZONE_ORIGIN, y: ZONE_ORIGIN, w: ZONE_SIZE, h: ZONE_SIZE });
    expect(line).toBe(`M${ZONE_ORIGIN} ${ZONE_ORIGIN}V${ZONE_ORIGIN + ZONE_SIZE}M${ZONE_ORIGIN + ZONE_SIZE} ${ZONE_ORIGIN}V${ZONE_ORIGIN + ZONE_SIZE}M${ZONE_ORIGIN} ${ZONE_ORIGIN}H${ZONE_ORIGIN + ZONE_SIZE}M${ZONE_ORIGIN} ${ZONE_ORIGIN + ZONE_SIZE}H${ZONE_ORIGIN + ZONE_SIZE}`);
  });
});
