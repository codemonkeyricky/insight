import { describe, expect, it } from "vitest";
import { CLOUD_PAD, badgeText, cloudPath, cloudPoints, findingCounts, markerAnchors } from "../src/zoom/findingsLayer.js";

const rect = { x: 100, y: 200, w: 80, h: 40 };

describe("findingCounts", () => {
  it("counts each finding once for each distinct node it names", () => {
    const counts = findingCounts([
      { nodes: ["f1", "f2"] },
      { nodes: ["f1", "f1"] },
      { nodes: [] },
      {},
    ]);
    expect(counts.get("f1")).toBe(2);
    expect(counts.get("f2")).toBe(1);
    expect(counts.has("f3")).toBe(false);
  });
});

describe("cloudPoints", () => {
  it("walks the outline a pad outside the rectangle, starting at the top-left corner", () => {
    const pts = cloudPoints(rect, CLOUD_PAD, 16);
    expect(pts[0]).toEqual([rect.x - CLOUD_PAD, rect.y - CLOUD_PAD]);
    for (const [x, y] of pts) {
      expect(x).toBeGreaterThanOrEqual(rect.x - CLOUD_PAD);
      expect(x).toBeLessThanOrEqual(rect.x + rect.w + CLOUD_PAD);
      expect(y).toBeGreaterThanOrEqual(rect.y - CLOUD_PAD);
      expect(y).toBeLessThanOrEqual(rect.y + rect.h + CLOUD_PAD);
    }
  });

  it("keeps each gap within 1.5 steps: a side is split into equal pieces near one step each", () => {
    const pts = cloudPoints(rect, CLOUD_PAD, 16);
    for (let i = 0; i < pts.length; i++) {
      const [ax, ay] = pts[i]!;
      const [bx, by] = pts[(i + 1) % pts.length]!;
      expect(Math.hypot(bx - ax, by - ay)).toBeLessThanOrEqual(1.5 * 16 + 1e-9);
    }
  });
});

describe("cloudPath", () => {
  it("is a closed path of arcs starting at the top-left corner", () => {
    const d = cloudPath(rect);
    expect(d.startsWith(`M${rect.x - CLOUD_PAD} ${rect.y - CLOUD_PAD}`)).toBe(true);
    expect(d.endsWith("Z")).toBe(true);
    expect(d).toContain("A");
    expect(d).not.toContain("L");
  });
});

describe("markerAnchors", () => {
  it("puts the triangle on the top-left corner and the badge on the top-right corner", () => {
    const at = markerAnchors(rect);
    expect(at.triangle).toEqual({ x: rect.x - CLOUD_PAD, y: rect.y - CLOUD_PAD });
    expect(at.badge).toEqual({ x: rect.x + rect.w + CLOUD_PAD, y: rect.y - CLOUD_PAD });
  });
});

describe("badgeText", () => {
  it("shows the count, capped at 99+", () => {
    expect(badgeText(3)).toBe("3");
    expect(badgeText(99)).toBe("99");
    expect(badgeText(100)).toBe("99+");
  });
});
