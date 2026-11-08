import { describe, expect, it } from "vitest";
import type { ArchModel } from "@insight/lens-dependencies";
import { ARCH_PAD, arrowKey, arrowsOf, arrowWidth, archLayout } from "../src/arch/layout.js";

const LAYERS = ["project", "frontend", "ir", "lens", "app"];

/** Four layers with packages (project has none), a reverse pair, a same-column pair, a back edge and a violation. */
const model: ArchModel = {
  layers: LAYERS,
  packages: [
    { id: "apps/web", name: "web", path: "apps/web", layer: "app", fileCount: 10 },
    { id: "packages/ir", name: "ir", path: "packages/ir", layer: "ir", fileCount: 5 },
    { id: "packages/lens-a", name: "lens-a", path: "packages/lens-a", layer: "lens", fileCount: 3 },
    { id: "packages/lens-b", name: "lens-b", path: "packages/lens-b", layer: "lens", fileCount: 2 },
    { id: "packages/frontend-x", name: "frontend-x", path: "packages/frontend-x", layer: "frontend", fileCount: 4 },
  ],
  edges: [
    { from: "apps/web", to: "packages/ir", imports: 4, calls: 0, confidence: "exact", sites: [] },
    { from: "packages/lens-a", to: "packages/ir", imports: 1, calls: 2, confidence: "inferred", sites: [] },
    { from: "packages/ir", to: "packages/lens-a", imports: 8, calls: 0, confidence: "exact", sites: [] },
    { from: "packages/lens-a", to: "packages/lens-b", imports: 2, calls: 0, confidence: "exact", sites: [] },
    { from: "packages/frontend-x", to: "packages/lens-a", imports: 1, calls: 0, confidence: "exact", sites: [] },
  ],
  unresolved: [],
  externals: [],
  violations: [{ from: "packages/frontend-x", to: "packages/lens-a", rule: "frontends and lenses never import each other", sites: [] }],
};

const boxOf = (layout: ReturnType<typeof archLayout>, id: string) => {
  const box = layout.boxes.find((b) => b.id === id);
  if (!box) throw new Error(`no box ${id}`);
  return box;
};
const arrowOf = (layout: ReturnType<typeof archLayout>, from: string, to: string) => {
  const arrow = layout.arrows.find((a) => a.key === arrowKey(from, to));
  if (!arrow) throw new Error(`no arrow ${from} -> ${to}`);
  return arrow;
};
/** The eight numbers of an "M x y C x y x y x y" path: start, two controls, end. */
const points = (d: string): number[] => (d.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);

describe("archLayout", () => {
  it("draws one column per layer that holds packages, in the model's layer order", () => {
    const layout = archLayout(model);
    expect(layout.columns.map((c) => c.layer)).toEqual(["frontend", "ir", "lens", "app"]);
    const xs = layout.columns.map((c) => c.x);
    expect(xs).toEqual([...xs].sort((a, b) => a - b));
    expect(new Set(xs).size).toBe(xs.length);
    expect(boxOf(layout, "packages/lens-a").column).toBe(layout.columns.findIndex((c) => c.layer === "lens"));
  });

  it("stacks the packages of one column top to bottom, inside the layout", () => {
    const layout = archLayout(model);
    const a = boxOf(layout, "packages/lens-a");
    const b = boxOf(layout, "packages/lens-b");
    expect(a.x).toBe(b.x);
    expect(b.y).toBeGreaterThan(a.y + a.h);
    for (const box of layout.boxes) {
      expect(box.x + box.w).toBeLessThanOrEqual(layout.width);
      expect(box.y + box.h).toBeLessThanOrEqual(layout.height);
    }
  });

  it("gives one arrow per edge whose two packages exist, with the import count as its width and label", () => {
    const layout = archLayout(model);
    expect(layout.arrows).toHaveLength(model.edges.length);
    expect(arrowOf(layout, "apps/web", "packages/ir").width).toBe(arrowWidth(4));
    expect(arrowOf(layout, "packages/lens-a", "packages/lens-b").width).toBe(arrowWidth(2));
    expect(arrowOf(layout, "apps/web", "packages/ir").edge.imports).toBe(4);
  });

  it("starts an arrow on the box it leaves and ends it on the box it enters", () => {
    const layout = archLayout(model);
    const ir = boxOf(layout, "packages/ir");
    const web = boxOf(layout, "apps/web");
    // A forward arrow (ir column to lens column) leaves the right side of the importing box and enters the left side of the imported one.
    const forward = points(arrowOf(layout, "packages/ir", "packages/lens-a").d);
    const lensA = boxOf(layout, "packages/lens-a");
    expect(forward[0]).toBe(ir.x + ir.w);
    expect(forward[6]).toBe(lensA.x);
    // A back edge (app column to ir column) leaves the left side of web and enters the right side of ir.
    const back = points(arrowOf(layout, "apps/web", "packages/ir").d);
    expect(back[0]).toBe(web.x);
    expect(back[6]).toBe(ir.x + ir.w);
  });

  it("loops a same-column arrow out to the right of both boxes", () => {
    const layout = archLayout(model);
    const a = boxOf(layout, "packages/lens-a");
    const b = boxOf(layout, "packages/lens-b");
    const [sx, , c1x, , c2x, , ex] = points(arrowOf(layout, "packages/lens-a", "packages/lens-b").d);
    expect(sx).toBe(a.x + a.w);
    expect(ex).toBe(b.x + b.w);
    expect(c1x).toBeGreaterThan(a.x + a.w);
    expect(c2x).toBeGreaterThan(b.x + b.w);
  });

  it("bends each of two opposite arrows to its own side, so they do not overlap", () => {
    const layout = archLayout(model);
    const up = arrowOf(layout, "packages/ir", "packages/lens-a");
    const down = arrowOf(layout, "packages/lens-a", "packages/ir");
    expect(up.label.y).not.toBe(down.label.y);
    expect(up.d).not.toBe(down.d);
  });

  it("draws an arrow dashed unless its import is exact, and marks the arrow that breaks a rule", () => {
    const layout = archLayout(model);
    expect(arrowOf(layout, "packages/lens-a", "packages/ir").dashed).toBe(true);
    expect(arrowOf(layout, "apps/web", "packages/ir").dashed).toBe(false);
    expect(arrowOf(layout, "packages/frontend-x", "packages/lens-a").violation).toBe(true);
    expect(layout.arrows.filter((a) => a.violation).map((a) => a.key)).toEqual([arrowKey("packages/frontend-x", "packages/lens-a")]);
  });

  it("clamps the arrow width between 1 and 4 px and grows it with the import count", () => {
    expect(arrowWidth(0)).toBe(1);
    expect(arrowWidth(1)).toBe(1);
    expect(arrowWidth(2)).toBe(2);
    expect(arrowWidth(4)).toBe(3);
    expect(arrowWidth(8)).toBe(4);
    expect(arrowWidth(10_000)).toBe(4);
  });

  it("leaves out an edge whose package is not in the model", () => {
    const layout = archLayout({ ...model, edges: [...model.edges, { from: "packages/gone", to: "packages/ir", imports: 1, calls: 0, confidence: "exact", sites: [] }] });
    expect(layout.arrows).toHaveLength(model.edges.length);
  });

  it("lays out an empty model as an empty frame", () => {
    const layout = archLayout({ layers: LAYERS, packages: [], edges: [], unresolved: [], externals: [], violations: [] });
    expect(layout.columns).toEqual([]);
    expect(layout.boxes).toEqual([]);
    expect(layout.arrows).toEqual([]);
    expect(layout.width).toBe(ARCH_PAD * 2);
  });
});

describe("arrowsOf", () => {
  it("lists the arrows into and out of one package, in the model's edge order", () => {
    const { incoming, outgoing } = arrowsOf(model, "packages/ir");
    expect(incoming.map((e) => e.from)).toEqual(["apps/web", "packages/lens-a"]);
    expect(outgoing.map((e) => e.to)).toEqual(["packages/lens-a"]);
  });
});
