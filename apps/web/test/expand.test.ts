import { describe, expect, it } from "vitest";
import { CHART_HEAD, CHART_PAD, type FunctionFlow, type Rect } from "@insight/flow";
import {
  EXPAND_GAP,
  anchoredTo,
  clampTop,
  closeExpansion,
  connectorOf,
  contentOrigin,
  expansionSize,
  openExpansion,
  refresh,
  reflow,
  detailLetter,
  revealCamera,
  shiftAt,
  shiftOf,
  type Expansion,
} from "../src/zoom/expand.js";

const chart = (id: string, width: number, height: number) => ({ id, name: id, width, height, nodes: [], edges: [] }) as unknown as FunctionFlow;
const view: Rect = { x: 0, y: 0, w: 1000, h: 800 };
const box: Rect = { x: 100, y: 50, w: 230, h: 44 };

describe("sizes and origins", () => {
  it("an expansion holds the chart at its natural size with the header and padding", () => {
    expect(expansionSize({ width: 300, height: 200 })).toEqual({ w: 300 + 2 * CHART_PAD, h: CHART_HEAD + CHART_PAD + 200 + CHART_PAD });
    expect(contentOrigin({ x: 10, y: 20 })).toEqual({ x: 10 + CHART_PAD, y: 20 + CHART_HEAD + CHART_PAD });
  });
});

describe("placement", () => {
  it("opens to the right of a function box, top aligned with it, at the gap", () => {
    const list = openExpansion([], "A", { kind: "box", nodeId: "n", rect: box }, chart("A", 300, 200), view);
    expect(list).toHaveLength(1);
    expect(list[0]?.x).toBe(box.x + box.w + EXPAND_GAP);
    expect(list[0]?.y).toBe(box.y);
  });

  it("clamps an expansion opened low on the view so its header stays in view", () => {
    expect(clampTop(790, view)).toBe(view.y + view.h - 2 * CHART_HEAD);
    expect(clampTop(50, view)).toBe(50);
    const low = openExpansion([], "A", { kind: "box", nodeId: "n", rect: { ...box, y: 790 } }, chart("A", 300, 200), view);
    expect(low[0]?.y).toBe(view.y + view.h - 2 * CHART_HEAD);
  });

  it("a call step's expansion sits right of its parent, top aligned with the step", () => {
    const a = openExpansion([], "A", { kind: "box", nodeId: "n", rect: box }, chart("A", 300, 200), view);
    const step = { x: 10, y: 20, w: 50, h: 20 };
    const both = openExpansion(a, "B", { kind: "step", fnId: "A", rect: step }, chart("B", 200, 100), view);
    const parent = both.find((e) => e.fnId === "A");
    const child = both.find((e) => e.fnId === "B");
    expect(child?.x).toBe((parent?.x ?? 0) + (parent?.w ?? 0) + EXPAND_GAP);
    expect(child?.y).toBe(contentOrigin(parent ?? { x: 0, y: 0 }).y + step.y);
  });

  it("chains a step expansion to its parent's position when the parent moves", () => {
    const a = openExpansion([], "A", { kind: "box", nodeId: "n", rect: box }, chart("A", 300, 200), view);
    const both = openExpansion(a, "B", { kind: "step", fnId: "A", rect: { x: 0, y: 0, w: 10, h: 10 } }, chart("B", 100, 100), view);
    const moved = reflow(both.map((e) => (e.fnId === "A" ? { ...e, anchor: { kind: "box" as const, nodeId: "n", rect: { ...box, x: 300 } } } : e)), view);
    const parent = moved.find((e) => e.fnId === "A");
    const child = moved.find((e) => e.fnId === "B");
    expect(parent?.x).toBe(300 + box.w + EXPAND_GAP);
    expect(child?.x).toBe((parent?.x ?? 0) + (parent?.w ?? 0) + EXPAND_GAP);
  });
});

describe("reattach and cycles", () => {
  it("reopening an open function moves its expansion instead of adding a second", () => {
    const a = openExpansion([], "A", { kind: "box", nodeId: "n", rect: box }, chart("A", 300, 200), view);
    const again = openExpansion(a, "A", { kind: "box", nodeId: "n", rect: { ...box, x: 400 } }, chart("A", 300, 200), view);
    expect(again.filter((e) => e.fnId === "A")).toHaveLength(1);
    expect(again[0]?.x).toBe(400 + box.w + EXPAND_GAP);
  });

  it("the new expansion is last, so Escape closes it first", () => {
    const a = openExpansion([], "A", { kind: "box", nodeId: "n", rect: box }, chart("A", 300, 200), view);
    const both = openExpansion(a, "B", { kind: "box", nodeId: "m", rect: { x: 0, y: 500, w: 100, h: 44 } }, chart("B", 100, 100), view);
    expect(both.map((e) => e.fnId)).toEqual(["A", "B"]);
  });

  it("refuses an anchor inside the function's own chain, returning the same list", () => {
    const a = openExpansion([], "A", { kind: "box", nodeId: "n", rect: box }, chart("A", 300, 200), view);
    const withB = openExpansion(a, "B", { kind: "step", fnId: "A", rect: { x: 0, y: 0, w: 10, h: 10 } }, chart("B", 100, 100), view);
    expect(openExpansion(withB, "A", { kind: "step", fnId: "B", rect: { x: 0, y: 0, w: 10, h: 10 } }, chart("A", 300, 200), view)).toBe(withB);
  });
});

describe("closing", () => {
  it("closing a parent closes the expansions chained from it, at any depth", () => {
    const a = openExpansion([], "A", { kind: "box", nodeId: "n", rect: box }, chart("A", 300, 200), view);
    const b = openExpansion(a, "B", { kind: "step", fnId: "A", rect: { x: 0, y: 0, w: 10, h: 10 } }, chart("B", 100, 100), view);
    const c = openExpansion(b, "C", { kind: "step", fnId: "B", rect: { x: 0, y: 0, w: 10, h: 10 } }, chart("C", 100, 100), view);
    const other = openExpansion(c, "D", { kind: "box", nodeId: "m", rect: { x: 0, y: 500, w: 100, h: 44 } }, chart("D", 100, 100), view);
    expect(closeExpansion(other, "A").map((e) => e.fnId)).toEqual(["D"]);
    expect(closeExpansion(other, "B").map((e) => e.fnId)).toEqual(["A", "D"]);
  });

  it("anchoredTo finds the expansion of a box", () => {
    const a = openExpansion([], "A", { kind: "box", nodeId: "n", rect: box }, chart("A", 300, 200), view);
    expect(anchoredTo(a, "n")?.fnId).toBe("A");
    expect(anchoredTo(a, "other")).toBeUndefined();
  });
});

describe("refresh", () => {
  it("drops an expansion whose box is no longer drawn, with the chain it holds", () => {
    const a = openExpansion([], "A", { kind: "box", nodeId: "n", rect: box }, chart("A", 300, 200), view);
    const b = openExpansion(a, "B", { kind: "step", fnId: "A", rect: { x: 0, y: 0, w: 10, h: 10 } }, chart("B", 100, 100), view);
    expect(refresh(b, () => undefined, view)).toEqual([]);
  });

  it("moves a box anchor to the box's rect in the new build, and keeps step anchors", () => {
    const a = openExpansion([], "A", { kind: "box", nodeId: "n", rect: box }, chart("A", 300, 200), view);
    const b = openExpansion(a, "B", { kind: "step", fnId: "A", rect: { x: 0, y: 0, w: 10, h: 10 } }, chart("B", 100, 100), view);
    const next = refresh(b, () => ({ x: 200, y: 100, w: 230, h: 44 }), view);
    expect(next.find((e) => e.fnId === "A")?.x).toBe(200 + 230 + EXPAND_GAP);
    expect(next.map((e) => e.fnId)).toEqual(["A", "B"]);
  });
});

describe("connector", () => {
  it("runs from a box's right edge to the expansion's header", () => {
    const a = openExpansion([], "A", { kind: "box", nodeId: "n", rect: box }, chart("A", 300, 200), view);
    expect(connectorOf(a[0] as Expansion, a)).toEqual({ x1: box.x + box.w, y1: box.y + box.h / 2, x2: a[0]?.x, y2: box.y + CHART_HEAD / 2 });
  });
});

describe("revealCamera", () => {
  const rect = { x: 370, y: 50, w: 324, h: 252 };
  const room = { width: 1000, height: 700 };

  it("leaves a camera that already shows the expansion where it is", () => {
    expect(revealCamera({ k: 1, x: 0, y: 0 }, rect, 300, room, 120)).toEqual({ k: 1, x: 0, y: 0 });
  });

  it("pans the least that brings the expansion into the room", () => {
    const cam = revealCamera({ k: 1, x: 0, y: 0 }, { ...rect, x: 900 }, 300, room, 120);
    expect(cam).toEqual({ k: 1, x: 1000 - 16 - (900 + 324), y: 0 });
  });

  it("zooms in only when the chart is narrower than the minimum, capped at 1.5 times, keeping the corner fixed", () => {
    const cam = revealCamera({ k: 1, x: 0, y: 0 }, { x: 100, y: 100, w: 60, h: 40 }, 50, room, 120);
    expect(cam).toEqual({ k: 1.5, x: -50, y: -50 });
  });

  it("does not zoom a chart that is already wide enough", () => {
    expect(revealCamera({ k: 2, x: 0, y: 0 }, rect, 300, room, 120).k).toBe(2);
  });
});

describe("the side shift", () => {
  it("moves an item right of the pivot by the detail's width plus the gap, and leaves one at or left of it", () => {
    expect(shiftOf({ x: 500 }, 300, 200)).toBe(200 + EXPAND_GAP);
    expect(shiftOf({ x: 300 }, 300, 200)).toBe(0);
    expect(shiftOf({ x: 120 }, 300, 200)).toBe(0);
  });

  it("leaves items left of the pivot where they are, once a detail is open", () => {
    const a = openExpansion([], "A", { kind: "box", nodeId: "n", rect: box }, chart("A", 300, 200), view);
    expect(shiftAt(a, box.x)).toBe(0);
    expect(shiftAt(a, box.x + box.w)).toBe(0);
    expect(shiftAt(a, box.x + box.w + 1)).toBe(300 + 2 * CHART_PAD + EXPAND_GAP);
  });

  it("sums a nested chain: a call step's detail shares its parent's pivot, so both widths shift the columns", () => {
    const a = openExpansion([], "A", { kind: "box", nodeId: "n", rect: box }, chart("A", 300, 200), view);
    const both = openExpansion(a, "B", { kind: "step", fnId: "A", rect: { x: 10, y: 20, w: 50, h: 20 } }, chart("B", 200, 100), view);
    const pa = both.find((e) => e.fnId === "A");
    const pb = both.find((e) => e.fnId === "B");
    expect(pb?.pivot).toBe(pa?.pivot);
    const far = box.x + box.w + 500;
    expect(shiftAt(both, far)).toBe((pa?.w ?? 0) + EXPAND_GAP + (pb?.w ?? 0) + EXPAND_GAP);
  });

  it("restores zero when the detail closes, and when the chain it held closes with it", () => {
    const a = openExpansion([], "A", { kind: "box", nodeId: "n", rect: box }, chart("A", 300, 200), view);
    const both = openExpansion(a, "B", { kind: "step", fnId: "A", rect: { x: 10, y: 20, w: 50, h: 20 } }, chart("B", 200, 100), view);
    expect(shiftAt(closeExpansion(both, "B"), box.x + 900)).toBe((both[0]?.w ?? 0) + EXPAND_GAP);
    expect(shiftAt(closeExpansion(both, "A"), box.x + 900)).toBe(0);
    expect(shiftAt([], box.x + 900)).toBe(0);
  });

  it("gives each open detail the next letter, A then B, and keeps a reattached detail's letter", () => {
    const a = openExpansion([], "A", { kind: "box", nodeId: "n", rect: box }, chart("A", 300, 200), view);
    const both = openExpansion(a, "B", { kind: "step", fnId: "A", rect: { x: 10, y: 20, w: 50, h: 20 } }, chart("B", 200, 100), view);
    expect(both.map((e) => detailLetter(e.index))).toEqual(["A", "B"]);
    const moved = openExpansion(both, "A", { kind: "box", nodeId: "n", rect: { ...box, x: 400 } }, chart("A", 300, 200), view);
    expect(moved.find((e) => e.fnId === "A")?.index).toBe(0);
    expect(detailLetter(26)).toBe("AA");
  });
});
