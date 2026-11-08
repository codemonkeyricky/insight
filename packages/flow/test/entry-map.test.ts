import type { IREdge } from "@insight/ir";
import { describe, expect, it } from "vitest";
import {
  ENTRY_CLOSE_PX,
  ENTRY_OPEN_PX,
  ENTRY_ROWS,
  ZOOM_SIZE,
  entryBoxAt,
  entryBoxes,
  entryCard,
  entryCount,
  entryDecision,
  entryFrameOf,
  entryFrames,
  entrySummary,
  ladderOf,
  layoutEntries,
  scopeChain,
  summarizeScope,
  type EntryLayout,
  type PlacedEntryBox,
  type PlacedEntryFrame,
  type ScopeFlow,
} from "../src/index.js";
import { callEdge, fnNode } from "./synthetic.js";

/** A flow in which nothing calls anything, so every function is unreferenced. `files` maps each file to its count. */
function flowWith(files: Record<string, number>, calls: IREdge[] = []): ScopeFlow {
  const nodes = Object.entries(files).flatMap(([file, n]) => Array.from({ length: n }, (_, i) => fnNode(file, `f${i}`, i * 4)));
  return summarizeScope(nodes, calls, Object.keys(files));
}

const overlaps = (a: PlacedEntryFrame, b: PlacedEntryFrame) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

describe("scopeChain and ladderOf", () => {
  it("lists a scope and its ancestors, nearest first, ending with the project", () => {
    expect(scopeChain("app/src/index.ts")).toEqual(["app/src/index.ts", "app/src", "app", ""]);
    expect(scopeChain("")).toEqual([""]);
  });

  it("gives the project first and the scope last, marked current, with the counts it knows", () => {
    const rungs = ladderOf("app/src", (s) => (s === "" ? { unreferenced: 3, total: 9 } : undefined));
    expect(rungs).toEqual([
      { scope: "", name: "project", current: false, counts: { unreferenced: 3, total: 9 } },
      { scope: "app", name: "app", current: false, counts: undefined },
      { scope: "app/src", name: "src", current: true, counts: undefined },
    ]);
  });
});

describe("entry boxes and frames", () => {
  const flow = flowWith({ "src/a.ts": 2, "src/b.ts": 1, "src/a.test.ts": 1 });

  it("groups the boxes by file in path order, and leaves noise rows out unless asked for", () => {
    expect(entryFrames(flow, false).map((f) => f.file)).toEqual(["src/a.ts", "src/b.ts"]);
    const all = entryFrames(flow, true);
    expect(all.map((f) => f.file).sort()).toEqual(["src/a.test.ts", "src/a.ts", "src/b.ts"]);
    expect(all.find((f) => f.file === "src/a.test.ts")).toMatchObject({ noise: true });
    expect(all.find((f) => f.file === "src/a.ts")).toMatchObject({ noise: false });
  });

  it("treats a file under a samples directory as noise, like a test file", () => {
    const sampled = flowWith({ "src/a.ts": 1, "examples/samples/s.ts": 1 });
    expect(entryFrames(sampled, false).map((f) => f.file)).toEqual(["src/a.ts"]);
    expect(entryFrames(sampled, true).find((f) => f.file === "examples/samples/s.ts")).toMatchObject({ noise: true });
  });

  it("sorts boxes by line within a file", () => {
    const boxes = entryBoxes(flow, false).filter((b) => b.file === "src/a.ts");
    expect(boxes.map((b) => b.name)).toEqual(["f0", "f1"]);
    expect(boxes[0]?.line).toBeLessThan(boxes[1]?.line ?? 0);
  });

  it("summarizes the shown boxes, the frames, the hidden noise and the outside callers", () => {
    expect(entrySummary(flow, false)).toEqual({ shown: 3, files: 2, noise: 1, hiddenNoise: 1, outside: 0 });
    expect(entrySummary(flow, true)).toEqual({ shown: 4, files: 3, noise: 1, hiddenNoise: 0, outside: 0 });
  });

  it("counts unreferenced over total, leaving noise out unless the toggle includes it", () => {
    expect(entryCount(flow, false)).toEqual({ unreferenced: 3, total: 3 });
    expect(entryCount(flow, true)).toEqual({ unreferenced: 4, total: 4 });
  });

  it("flags a box that an outside caller reaches, and keeps it shown", () => {
    const calls = [callEdge("lib/x.ts#outer", "src/b.ts#f0", "lib/x.ts", 1)];
    const outside = flowWith({ "src/b.ts": 1 }, calls);
    expect(entryBoxes(outside, false)).toEqual([expect.objectContaining({ id: "src/b.ts#f0", calledFromOutside: true })]);
    expect(entrySummary(outside, false)).toMatchObject({ shown: 1, outside: 1 });
  });
});

describe("layoutEntries", () => {
  it("is empty for a scope with no unreferenced functions", () => {
    expect(layoutEntries(flowWith({}), { includeNoise: true })).toEqual({ width: 0, height: 0, frames: [] });
  });

  it("puts a file's boxes in a grid of up to ENTRY_ROWS per column, inside the frame", () => {
    const count = ENTRY_ROWS * 2 + 5;
    const layout = layoutEntries(flowWith({ "src/big.ts": count }), { includeNoise: false });
    const [frame] = layout.frames;
    expect(frame?.boxes).toHaveLength(count);
    expect(new Set(frame?.boxes.map((b) => b.x)).size).toBe(3);
    expect(new Set(frame?.boxes.map((b) => b.y)).size).toBe(ENTRY_ROWS);
    for (const b of frame?.boxes ?? []) {
      expect(b.x).toBeGreaterThanOrEqual(frame?.x ?? 0);
      expect(b.x + b.w).toBeLessThanOrEqual((frame?.x ?? 0) + (frame?.w ?? 0));
      expect(b.y).toBeGreaterThanOrEqual((frame?.y ?? 0) + 30);
      expect(b.y + b.h).toBeLessThanOrEqual((frame?.y ?? 0) + (frame?.h ?? 0));
    }
  });

  it("keeps frames apart and inside the map, across wrapped rows", () => {
    const files: Record<string, number> = {};
    for (let i = 0; i < 40; i++) files[`src/m${i}.ts`] = 1 + ((i * 7) % 25);
    const layout = layoutEntries(flowWith(files), { includeNoise: false, wrap: 900 });
    expect(layout.frames).toHaveLength(40);
    for (const [i, a] of layout.frames.entries()) {
      expect(a.x + a.w).toBeLessThanOrEqual(layout.width);
      expect(a.y + a.h).toBeLessThanOrEqual(layout.height);
      for (const b of layout.frames.slice(i + 1)) expect(overlaps(a, b), `${a.file} and ${b.file}`).toBe(false);
    }
    expect(new Set(layout.frames.map((f) => f.y)).size).toBeGreaterThan(1);
  });

  it("gives a frame wider than the wrap width a row of its own", () => {
    const layout = layoutEntries(flowWith({ "src/a.ts": 30, "src/b.ts": 1 }), { includeNoise: false, wrap: 100 });
    expect(layout.frames.map((f) => f.y)[0]).not.toBe(layout.frames.map((f) => f.y)[1]);
  });
});

/** The first box of a layout. A layout built from `flowWith` always has one. */
function firstBox(layout: EntryLayout): PlacedEntryBox {
  const box = layout.frames[0]?.boxes[0];
  if (!box) throw new Error("the layout has no box");
  return box;
}

describe("entry camera: boxes under a point", () => {
  const layout = layoutEntries(flowWith({ "src/a.ts": 2, "src/b.ts": 1 }), { includeNoise: false });
  const [first, second] = layout.frames[0]?.boxes ?? [];

  it("finds the box that holds a world point, and none in a frame header or outside the map", () => {
    if (!first || !second) throw new Error("expected two boxes");
    expect(entryBoxAt(layout, first.x + 1, first.y + 1)?.id).toBe(first.id);
    expect(entryBoxAt(layout, second.x + second.w / 2, second.y + second.h / 2)?.id).toBe(second.id);
    expect(entryBoxAt(layout, first.x + 1, (layout.frames[0]?.y ?? 0) + 5)).toBeUndefined();
    expect(entryBoxAt(layout, -1, -1)).toBeUndefined();
  });

  it("finds the frame of a box, and none for an id the layout does not show", () => {
    expect(entryFrameOf(layout, "src/a.ts#f0")?.file).toBe("src/a.ts");
    expect(entryFrameOf(layout, "src/b.ts#f0")?.file).toBe("src/b.ts");
    expect(entryFrameOf(layout, "nope#f0")).toBeUndefined();
  });
});

describe("entry camera: the card", () => {
  const box = firstBox(layoutEntries(flowWith({ "src/a.ts": 1 }), { includeNoise: false }));
  const { pad, head } = ZOOM_SIZE;

  it("is as wide as the chart with its padding when the chart is wider than the box", () => {
    expect(entryCard(box, { width: 800, height: 300 })).toEqual({ x: box.x, y: box.y, w: 800 + 2 * pad, h: head + 300 + 2 * pad });
  });

  it("is as wide as the box when the chart is narrower than the box", () => {
    expect(entryCard(box, { width: 100, height: 200 })).toEqual({ x: box.x, y: box.y, w: box.w, h: head + 200 + 2 * pad });
  });

  it("is the box's width with room for a message when the chart is too large or has no steps", () => {
    const short = { x: box.x, y: box.y, w: box.w, h: head + 60 };
    expect(entryCard(box, { width: 0, height: 0, tooLarge: true })).toEqual(short);
    expect(entryCard(box, { width: 0, height: 0, empty: true })).toEqual(short);
  });

  it("is the message size while the chart is still loading", () => {
    expect(entryCard(box, undefined)).toEqual({ x: box.x, y: box.y, w: box.w, h: head + 60 });
  });
});

describe("entry camera: the open and close decision", () => {
  it("keeps the open threshold above the close threshold, so a box at the edge does not flicker", () => {
    expect(ENTRY_OPEN_PX).toBeGreaterThan(ENTRY_CLOSE_PX);
  });

  it("opens the box under the pointer once it is wider than ENTRY_OPEN_PX, with nothing open", () => {
    const under = { id: "src/a.ts#f0", px: ENTRY_OPEN_PX + 1 };
    expect(entryDecision({ open: undefined, cardPx: undefined, under, mayOpen: true })).toEqual({ kind: "open", id: "src/a.ts#f0" });
  });

  it("does not open a box exactly at ENTRY_OPEN_PX, or a box after a gesture that zoomed out", () => {
    const at = { id: "src/a.ts#f0", px: ENTRY_OPEN_PX };
    expect(entryDecision({ open: undefined, cardPx: undefined, under: at, mayOpen: true })).toBeUndefined();
    const wide = { id: "src/a.ts#f0", px: ENTRY_OPEN_PX * 2 };
    expect(entryDecision({ open: undefined, cardPx: undefined, under: wide, mayOpen: false })).toBeUndefined();
  });

  it("opens nothing when no box is under the pointer", () => {
    expect(entryDecision({ open: undefined, cardPx: undefined, under: undefined, mayOpen: true })).toBeUndefined();
  });

  it("holds the band between the thresholds: a box at 250 px neither opens nor closes", () => {
    expect(entryDecision({ open: undefined, cardPx: undefined, under: { id: "x", px: 250 }, mayOpen: true })).toBeUndefined();
    expect(entryDecision({ open: "x", cardPx: 250, under: undefined, mayOpen: true })).toBeUndefined();
  });

  it("closes the open function once its card is narrower than ENTRY_CLOSE_PX", () => {
    expect(entryDecision({ open: "x", cardPx: ENTRY_CLOSE_PX - 1, under: undefined, mayOpen: false })).toEqual({ kind: "close" });
    expect(entryDecision({ open: "x", cardPx: ENTRY_CLOSE_PX, under: undefined, mayOpen: true })).toBeUndefined();
  });

  it("never opens a second function while one is open, and keeps it open when its card size is unknown", () => {
    const under = { id: "y", px: ENTRY_OPEN_PX * 3 };
    expect(entryDecision({ open: "x", cardPx: ENTRY_OPEN_PX * 2, under, mayOpen: true })).toBeUndefined();
    expect(entryDecision({ open: "x", cardPx: undefined, under, mayOpen: true })).toBeUndefined();
  });
});
