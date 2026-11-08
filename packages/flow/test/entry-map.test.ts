import type { IREdge } from "@insight/ir";
import { describe, expect, it } from "vitest";
import {
  ENTRY_ROWS,
  entryBoxes,
  entryFrames,
  entrySummary,
  ladderOf,
  layoutEntries,
  scopeChain,
  summarizeScope,
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
    const rungs = ladderOf("app/src", (s) => (s === "" ? { unreferenced: 3, tests: 1 } : undefined));
    expect(rungs).toEqual([
      { scope: "", name: "project", current: false, counts: { unreferenced: 3, tests: 1 } },
      { scope: "app", name: "app", current: false, counts: undefined },
      { scope: "app/src", name: "src", current: true, counts: undefined },
    ]);
  });
});

describe("entry boxes and frames", () => {
  const flow = flowWith({ "src/a.ts": 2, "src/b.ts": 1, "src/a.test.ts": 1 });

  it("groups the boxes by file in path order, and leaves test rows out unless asked for", () => {
    expect(entryFrames(flow, false).map((f) => f.file)).toEqual(["src/a.ts", "src/b.ts"]);
    const all = entryFrames(flow, true);
    expect(all.map((f) => f.file).sort()).toEqual(["src/a.test.ts", "src/a.ts", "src/b.ts"]);
    expect(all.find((f) => f.file === "src/a.test.ts")).toMatchObject({ test: true });
    expect(all.find((f) => f.file === "src/a.ts")).toMatchObject({ test: false });
  });

  it("sorts boxes by line within a file", () => {
    const boxes = entryBoxes(flow, false).filter((b) => b.file === "src/a.ts");
    expect(boxes.map((b) => b.name)).toEqual(["f0", "f1"]);
    expect(boxes[0]?.line).toBeLessThan(boxes[1]?.line ?? 0);
  });

  it("summarizes the shown boxes, the frames, the hidden tests and the outside callers", () => {
    expect(entrySummary(flow, false)).toEqual({ shown: 3, files: 2, tests: 1, hiddenTests: 1, outside: 0 });
    expect(entrySummary(flow, true)).toEqual({ shown: 4, files: 3, tests: 1, hiddenTests: 0, outside: 0 });
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
    expect(layoutEntries(flowWith({}), { includeTests: true })).toEqual({ width: 0, height: 0, frames: [] });
  });

  it("puts a file's boxes in a grid of up to ENTRY_ROWS per column, inside the frame", () => {
    const count = ENTRY_ROWS * 2 + 5;
    const layout = layoutEntries(flowWith({ "src/big.ts": count }), { includeTests: false });
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
    const layout = layoutEntries(flowWith(files), { includeTests: false, wrap: 900 });
    expect(layout.frames).toHaveLength(40);
    for (const [i, a] of layout.frames.entries()) {
      expect(a.x + a.w).toBeLessThanOrEqual(layout.width);
      expect(a.y + a.h).toBeLessThanOrEqual(layout.height);
      for (const b of layout.frames.slice(i + 1)) expect(overlaps(a, b), `${a.file} and ${b.file}`).toBe(false);
    }
    expect(new Set(layout.frames.map((f) => f.y)).size).toBeGreaterThan(1);
  });

  it("gives a frame wider than the wrap width a row of its own", () => {
    const layout = layoutEntries(flowWith({ "src/a.ts": 30, "src/b.ts": 1 }), { includeTests: false, wrap: 100 });
    expect(layout.frames.map((f) => f.y)[0]).not.toBe(layout.frames.map((f) => f.y)[1]);
  });
});
