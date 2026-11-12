import { describe, expect, it } from "vitest";
import { CHART_HEAD, CHART_PAD, type FunctionFlow, type Rect } from "@insight/flow";
import {
  CALLOUT_INSET,
  EXPAND_GAP,
  anchoredTo,
  clampTop,
  closeExpansion,
  calloutOf,
  contentOrigin,
  expansionSize,
  openExpansion,
  refresh,
  reflow,
  detailLetter,
  revealCamera,
  sceneCamera,
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

describe("callout", () => {
  it("runs from a box's right edge, spanning its top and bottom, to the expansion's inset left edge", () => {
    const a = openExpansion([], "A", { kind: "box", nodeId: "n", rect: box }, chart("A", 300, 200), view);
    const e = a[0] as Expansion;
    expect(calloutOf(e, a)).toEqual({ ax: box.x + box.w, ayT: box.y, ayB: box.y + box.h, ex: e.x, eyT: e.y + CALLOUT_INSET, eyB: e.y + e.h - CALLOUT_INSET });
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

describe("revealCamera fit", () => {
  const margin = 16;
  /** Where the rect's left and right edges and top and bottom edges sit on screen, in the room's coordinates. */
  const edges = (cam: { k: number; x: number; y: number }, r: { x: number; y: number; w: number; h: number }) => ({
    left: r.x * cam.k + cam.x,
    right: (r.x + r.w) * cam.k + cam.x,
    top: r.y * cam.k + cam.y,
    bottom: (r.y + r.h) * cam.k + cam.y,
  });

  it("keeps a wider-than-room expansion's left edge visible at a scale of at least 0.5", () => {
    const room = { width: 400, height: 600 };
    const rect = { x: 900, y: 50, w: 1000, h: 200 };
    const cam = revealCamera({ k: 1, x: 0, y: 0 }, rect, 1000, room, 0);
    expect(cam.k).toBeGreaterThanOrEqual(0.5);
    const e = edges(cam, rect);
    expect(e.left).toBeGreaterThanOrEqual(0);
    expect(e.left).toBeLessThanOrEqual(margin + 0.001);
  });

  it("zooms out to fit an expansion that fits at a smaller scale, then keeps it fully inside the room", () => {
    const room = { width: 400, height: 600 };
    const rect = { x: 900, y: 50, w: 700, h: 200 };
    const cam = revealCamera({ k: 1, x: 0, y: 0 }, rect, 700, room, 0);
    expect(cam.k).toBeLessThan(1);
    expect(cam.k).toBeGreaterThanOrEqual(0.5);
    const e = edges(cam, rect);
    expect(e.left).toBeGreaterThanOrEqual(margin - 0.001);
    expect(e.right).toBeLessThanOrEqual(room.width - margin + 0.001);
  });

  it("aligns an expansion larger than the room in both directions to the top-left, at the 0.5 floor", () => {
    const room = { width: 400, height: 300 };
    const rect = { x: 900, y: 50, w: 1000, h: 900 };
    const cam = revealCamera({ k: 1, x: 0, y: 0 }, rect, 1000, room, 0);
    expect(cam.k).toBe(0.5);
    const e = edges(cam, rect);
    expect(e.left).toBeCloseTo(margin, 6);
    expect(e.top).toBeCloseTo(margin, 6);
  });

  it("pans a fitting expansion the least that brings it inside the room, without changing the scale", () => {
    const room = { width: 1000, height: 700 };
    const rect = { x: 100, y: 50, w: 200, h: 100 };
    const cam = revealCamera({ k: 1, x: -300, y: 0 }, rect, 200, room, 0);
    expect(cam.k).toBe(1);
    const e = edges(cam, rect);
    expect(e.left).toBeCloseTo(margin, 6);
  });

  it("a tall expansion is fitted to its width, not its height: the scale is the width-fit, not the 0.5 floor", () => {
    const room = { width: 1000, height: 700 };
    const rect = { x: 100, y: 100, w: 800, h: 3000 };
    const cam = revealCamera({ k: 2, x: 0, y: -400 }, rect, 800, room, 0);
    expect(cam.k).toBeCloseTo((room.width - 2 * margin) / rect.w, 6);
    expect(cam.k).toBeGreaterThan(0.5);
    const e = edges(cam, rect);
    expect(e.top).toBeCloseTo(margin, 6);
    expect(e.left).toBeCloseTo(margin, 6);
  });

  it("a tall expansion's header is placed at the room's top, never above it", () => {
    const room = { width: 1000, height: 700 };
    const rect = { x: 0, y: 0, w: 400, h: 2500 };
    const cam = revealCamera({ k: 3, x: 0, y: 200 }, rect, 400, room, 0);
    expect(cam.k).toBeCloseTo((room.width - 2 * margin) / rect.w, 6);
    const e = edges(cam, rect);
    expect(e.top).toBeCloseTo(margin, 6);
    expect(e.left).toBeCloseTo(margin, 6);
  });

  it("a small expansion that fits the room keeps its scale and is fully visible", () => {
    const room = { width: 1000, height: 700 };
    const rect = { x: 300, y: 200, w: 250, h: 300 };
    const cam = revealCamera({ k: 1, x: 0, y: 0 }, rect, 250, room, 0);
    expect(cam).toEqual({ k: 1, x: 0, y: 0 });
    const e = edges(cam, rect);
    expect(e.top).toBeGreaterThanOrEqual(margin);
    expect(e.bottom).toBeLessThanOrEqual(room.height - margin);
  });
});

describe("sceneCamera", () => {
  const pad = 16;

  it("scales a wide scene down to fit the room's width, top-left aligned with padding, so no frame is clipped on the right", () => {
    const scene = { x: 0, y: 0, w: 900, h: 700 };
    const cam = sceneCamera(scene, 270, 1, false);
    expect(cam.k).toBeLessThan(1);
    expect(cam.x).toBeCloseTo(pad, 6);
    expect(scene.w * cam.k + cam.x).toBeLessThanOrEqual(270 - pad + 0.001);
  });

  it("does not fit the height: a tall scene keeps its scale, so its top is the one that is aligned", () => {
    const cam = sceneCamera({ x: 0, y: 0, w: 700, h: 2740 }, 718, 1, false);
    expect(cam.k).toBeCloseTo(686 / 700, 6);
    expect(cam.y).toBeCloseTo(pad, 6);
  });

  it("never goes above the cap, so a small scene is not enlarged", () => {
    const cam = sceneCamera({ x: 0, y: 0, w: 100, h: 50 }, 1000, 1, false);
    expect(cam.k).toBe(1);
  });

  it("keeps the scene's left edge visible on a phone, at a readable scale of at least 0.6 when the width allows", () => {
    const scene = { x: 40, y: 20, w: 900, h: 700 };
    const cam = sceneCamera(scene, 390, 1, true);
    expect(cam.k).toBeGreaterThanOrEqual(0.6);
    expect(cam.k).toBeLessThanOrEqual(1);
    expect(scene.x * cam.k + cam.x).toBeCloseTo(pad, 6);
  });

  it("aligns the scene's top-left to the room with padding when it is scaled, not centred", () => {
    const cam = sceneCamera({ x: 300, y: 200, w: 400, h: 300 }, 300, 1, false);
    expect(300 * cam.k + cam.x).toBeCloseTo(pad, 6);
    expect(200 * cam.k + cam.y).toBeCloseTo(pad, 6);
  });
});
