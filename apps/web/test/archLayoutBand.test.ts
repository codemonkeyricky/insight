import { describe, expect, it } from "vitest";
import type { ArchModel, ArchPackage } from "@insight/model";
import { ARCH_BOX_H, ARCH_BOX_W, ARCH_COL_GAP, ARCH_HEADER_H, ARCH_PAD, archLayout, arrowKey } from "../src/arch/layout.js";

const pkg = (id: string, layer: string): ArchPackage => ({ id, name: id, path: id, layer, fileCount: 1 });
const x = (column: number) => ARCH_PAD + column * (ARCH_BOX_W + ARCH_COL_GAP);

/** A left boundary card, three band cards and a right boundary card, with one arrow from a band card to the right card. */
const model: ArchModel = {
  layers: ["Imported by", "Inside src", "Imports"],
  packages: [
    pkg("in:x", "Imported by"),
    pkg("src/a", "Inside src"),
    pkg("src/b", "Inside src"),
    pkg("src/c", "Inside src"),
    pkg("out:y", "Imports"),
  ],
  edges: [
    { from: "src/a", to: "out:y", imports: 4, calls: 0, confidence: "exact", sites: [] },
    { from: "in:x", to: "src/c", imports: 1, calls: 0, confidence: "exact", sites: [] },
  ],
  unresolved: [],
  externals: [],
  violations: [],
  files: [],
  fileImports: [],
};

const boxOf = (layout: ReturnType<typeof archLayout>, id: string) => {
  const box = layout.boxes.find((b) => b.id === id);
  if (!box) throw new Error(`no box ${id}`);
  return box;
};

describe("archLayout with a band", () => {
  it("gives the band perRow columns, with the boundary columns at 0 and perRow + 1", () => {
    const layout = archLayout(model, { band: { layer: "Inside src", perRow: 2 } });
    expect(layout.columns.map((c) => [c.layer, c.index, c.x])).toEqual([
      ["Imported by", 0, x(0)],
      ["Inside src", 1, x(1)],
      ["Imports", 3, x(3)],
    ]);
    expect(boxOf(layout, "in:x").column).toBe(0);
    expect(boxOf(layout, "out:y").column).toBe(3);
  });

  it("fills the band's rows left to right, top to bottom", () => {
    const layout = archLayout(model, { band: { layer: "Inside src", perRow: 2 } });
    const a = boxOf(layout, "src/a");
    const b = boxOf(layout, "src/b");
    const c = boxOf(layout, "src/c");
    expect([a.column, a.y]).toEqual([1, ARCH_PAD + ARCH_HEADER_H]);
    expect([b.column, b.y]).toEqual([2, ARCH_PAD + ARCH_HEADER_H]);
    expect([c.column, c.y]).toEqual([1, ARCH_PAD + ARCH_HEADER_H + ARCH_BOX_H + 18]);
  });

  it("stacks the band in one column with perRow 1", () => {
    const layout = archLayout(model, { band: { layer: "Inside src", perRow: 1 } });
    expect(layout.columns.map((c) => c.index)).toEqual([0, 1, 2]);
    expect(boxOf(layout, "out:y").column).toBe(2);
    const a = boxOf(layout, "src/a");
    const c = boxOf(layout, "src/c");
    expect(a.column).toBe(c.column);
    expect(c.y).toBeGreaterThan(a.y + a.h);
  });

  it("draws an arrow from the band to the right boundary from the band card's right side", () => {
    const layout = archLayout(model, { band: { layer: "Inside src", perRow: 2 } });
    const a = boxOf(layout, "src/a");
    const arrow = layout.arrows.find((r) => r.key === arrowKey("src/a", "out:y"));
    const start = (arrow?.d.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
    expect(start[0]).toBe(a.x + a.w);
  });

  it("keeps the layout inside its width and height", () => {
    const layout = archLayout(model, { band: { layer: "Inside src", perRow: 2 } });
    for (const box of layout.boxes) {
      expect(box.x + box.w).toBeLessThanOrEqual(layout.width);
      expect(box.y + box.h).toBeLessThanOrEqual(layout.height);
    }
  });

  it("is the same as the layout with no band when the band layer holds no packages", () => {
    expect(archLayout(model, { band: { layer: "Nothing here", perRow: 2 } })).toEqual(archLayout(model));
  });
});
