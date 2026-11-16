import { describe, expect, it } from "vitest";
import type { StageGraph, StageNode } from "@insight/model";
import { CONDITION_MAX, layoutStages, type LayoutNode } from "../src/arch/stages-layout";

const site = (line: number) => ({ file: "app/src/run.ts", line, fn: "app/src/run.ts#run" });
const call = (id: string, name: string, extra: Record<string, unknown> = {}): StageNode =>
  ({ kind: "call", id, name, fn: `app/src/${name}.ts#${name}`, file: `app/src/${name}.ts`, site: site(1), ...extra }) as StageNode;

/** A graph that uses every shape: a plain call, a loop with a fanout and a branch with an else, a try with a catch skip, a repeat, an ambiguous call, a helper, and a minor call. */
function graph(): StageGraph {
  const fanout = call("f1", "detect", {
    fanout: {
      how: "interface",
      targets: ["a", "b", "c", "d", "e", "f", "g", "h"].map((c) => ({ fn: `pkg/${c}/x.ts#x`, name: "extract", component: `frontends/${c}` })),
    },
  });
  const longCond = "x".repeat(CONDITION_MAX + 30);
  const loop: StageNode = {
    kind: "loop",
    id: "loop1",
    variant: "for-of",
    condition: longCond,
    site: site(2),
    body: [
      fanout,
      {
        kind: "branch",
        id: "br1",
        condition: "toExtract.length > 0",
        site: site(3),
        arms: [
          { id: "br1a", label: "then", body: [call("c2", "runOver")] },
          { id: "br1b", label: "else", body: [] },
        ],
      },
    ],
  } as StageNode;
  const tr: StageNode = {
    kind: "try",
    id: "try1",
    site: site(4),
    body: [call("c3", "validate")],
    handler: [{ kind: "exit", id: "ex1", how: "continue", site: site(5) }],
  } as StageNode;
  const helper = call("h1", "runOver", { body: [call("c4", "store")] });
  return {
    driver: { id: "app/src/run.ts#run", name: "run", file: "app/src/run.ts" },
    body: [
      call("c0", "load"),
      loop,
      helper,
      call("c5", "runOver", { repeatOf: "h1" }),
      call("c6", "pick", { ambiguous: true }),
      call("c7", "tiny", { minor: true }),
      tr,
      { kind: "exit", id: "ex2", how: "return", site: site(6) } as StageNode,
    ],
    edges: [],
    coverage: [],
  };
}

type Rect = { x: number; y: number; w: number; h: number };
const rectOf = (n: { x: number; y: number; w: number; h: number }): Rect => ({ x: n.x, y: n.y, w: n.w, h: n.h });
const overlaps = (a: Rect, b: Rect): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const inside = (inner: Rect, outer: Rect): boolean =>
  inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;
const cards = (nodes: LayoutNode[]) => nodes.filter((n): n is Extract<LayoutNode, { kind: "card" }> => n.kind === "card");
const frames = (nodes: LayoutNode[]) => nodes.filter((n): n is Extract<LayoutNode, { kind: "frame" }> => n.kind === "frame");

describe("stages layout", () => {
  it("is deterministic: the same graph and options give the same layout", () => {
    expect(layoutStages(graph())).toEqual(layoutStages(graph()));
    expect(layoutStages(graph(), { showAll: true })).toEqual(layoutStages(graph(), { showAll: true }));
  });

  it("never overlaps two cards, and keeps every box and line inside the diagram", () => {
    for (const showAll of [false, true]) {
      const l = layoutStages(graph(), { showAll });
      const cs = cards(l.nodes);
      for (let i = 0; i < cs.length; i++) {
        for (let j = i + 1; j < cs.length; j++) {
          expect(overlaps(rectOf(cs[i] as Rect), rectOf(cs[j] as Rect)), `${cs[i]?.titleFull} vs ${cs[j]?.titleFull}`).toBe(false);
        }
      }
      for (const n of l.nodes) {
        if ("w" in n) expect(inside(rectOf(n), { x: 0, y: 0, w: l.width, h: l.height })).toBe(true);
      }
      for (const p of l.paths) for (const [x, y] of p.points) expect(x >= 0 && y >= 0 && x <= l.width && y <= l.height).toBe(true);
    }
  });

  it("nests frames: a frame's frames are inside it, a frame never overlaps a sibling frame, and a loop's cards sit inside its frame", () => {
    const l = layoutStages(graph(), { showAll: true });
    const fs = frames(l.nodes);
    const loop = fs.find((f) => f.tone === "loop") as Extract<LayoutNode, { kind: "frame" }>;
    const helper = fs.find((f) => f.tone === "helper") as Extract<LayoutNode, { kind: "frame" }>;
    const tryF = fs.find((f) => f.tone === "try") as Extract<LayoutNode, { kind: "frame" }>;
    expect(loop && helper && tryF).toBeTruthy();
    // The fanout card and the branch's call are inside the loop frame.
    const detect = cards(l.nodes).find((c) => c.titleFull === "detect") as Extract<LayoutNode, { kind: "card" }>;
    const runOver = cards(l.nodes).find((c) => c.titleFull === "runOver" && c.sub === "↺ same as above") as Extract<LayoutNode, { kind: "card" }>;
    expect(inside(rectOf(detect), rectOf(loop))).toBe(true);
    // The helper's body card is inside the helper frame and the helper frame is not inside the loop.
    const store = cards(l.nodes).find((c) => c.titleFull === "store") as Extract<LayoutNode, { kind: "card" }>;
    expect(inside(rectOf(store), rectOf(helper))).toBe(true);
    expect(runOver).toBeTruthy();
    // Frames are disjoint or nested, never partly overlapping.
    for (let i = 0; i < fs.length; i++) {
      for (let j = i + 1; j < fs.length; j++) {
        const a = rectOf(fs[i] as Rect);
        const b = rectOf(fs[j] as Rect);
        if (overlaps(a, b)) expect(inside(a, b) || inside(b, a)).toBe(true);
      }
    }
  });

  it("draws the branch as a diamond with its condition, lanes labelled then and else: —, and the fanout chips capped with +N", () => {
    const l = layoutStages(graph());
    const texts = l.nodes.filter((n): n is Extract<LayoutNode, { kind: "text" }> => n.kind === "text").map((n) => n.text);
    expect(texts).toContain("then");
    expect(texts).toContain("else: —");
    expect(l.nodes.some((n) => n.kind === "diamond")).toBe(true);
    const detect = cards(l.nodes).find((c) => c.titleFull === "detect") as Extract<LayoutNode, { kind: "card" }>;
    expect(detect.sub).toBe("interface · 8");
    expect(detect.chips).toHaveLength(6);
    expect(texts).toContain("+2 more");
    expect(detect.chips[0]?.component).toBe("frontends/a");
  });

  it("clips a long loop condition to CONDITION_MAX characters and keeps the full text as the title", () => {
    const l = layoutStages(graph());
    const loop = frames(l.nodes).find((f) => f.tone === "loop") as Extract<LayoutNode, { kind: "frame" }>;
    expect(loop.label.length).toBe(CONDITION_MAX + 2);
    expect(loop.label.endsWith("…")).toBe(true);
    expect(loop.titleFull.length).toBe(CONDITION_MAX + 30 + 2);
  });

  it("shows a repeat as a card saying same as above, marks an ambiguous call dashed, and hides minor calls until showAll", () => {
    const hidden = layoutStages(graph());
    const shown = layoutStages(graph(), { showAll: true });
    const subs = cards(hidden.nodes).map((c) => c.sub);
    expect(subs).toContain("↺ same as above");
    expect(subs).toContain("several possible");
    expect(cards(hidden.nodes).some((c) => c.titleFull === "tiny")).toBe(false);
    expect(cards(shown.nodes).some((c) => c.titleFull === "tiny" && c.tone === "minor")).toBe(true);
  });

  it("gives a loop a return arrow and a try with a handler a catch lane", () => {
    const l = layoutStages(graph());
    expect(l.paths.some((p) => p.tone === "return")).toBe(true);
    expect(l.paths.some((p) => p.tone === "catch")).toBe(true);
    expect(l.nodes.some((n) => n.kind === "text" && n.text === "catch")).toBe(true);
    expect(l.nodes.some((n) => n.kind === "pill" && n.text === "skip")).toBe(true);
    expect(l.nodes.some((n) => n.kind === "pill" && n.text === "return")).toBe(true);
  });

  it("lays out an empty graph as the bare margin", () => {
    const l = layoutStages({ driver: { id: "d", name: "d", file: "a.ts" }, body: [], edges: [], coverage: [] });
    expect(l.nodes).toEqual([]);
    expect(l.paths).toHaveLength(1);
    expect(l.width).toBeGreaterThan(0);
  });
});
