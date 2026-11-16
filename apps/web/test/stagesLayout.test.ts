import { describe, expect, it } from "vitest";
import type { StageGraph, StageNode } from "@insight/model";
import { CONDITION_MAX, DATA_H, LABEL_H, LEGIBLE_K, MARGIN, ROW_INDENT, layoutStages, planStages, type LayoutNode } from "../src/arch/stages-layout";

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
      call("c6", "pick", { ambiguous: true, candidates: 3 }),
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

  it("gives a loop, a helper and a branch's diamond the stage ids of the cards inside them, so hovering reveals their data links", () => {
    const l = layoutStages(graph(), { showAll: true });
    const loop = frames(l.nodes).find((f) => f.tone === "loop");
    const helper = frames(l.nodes).find((f) => f.tone === "helper");
    const detect = cards(l.nodes).find((c) => c.titleFull === "detect");
    const store = cards(l.nodes).find((c) => c.titleFull === "store");
    const diamond = l.nodes.find((n): n is Extract<LayoutNode, { kind: "diamond" }> => n.kind === "diamond");
    expect(loop?.members).toContain(detect?.stage);
    expect(helper?.members).toContain(store?.stage);
    expect(diamond?.members?.length ?? 0).toBeGreaterThan(0);
  });

  it("draws the branch as a diamond with its condition, lanes labelled then and else: —, and the fanout chips capped with +N", () => {
    const l = layoutStages(graph());
    const texts = l.nodes.filter((n): n is Extract<LayoutNode, { kind: "text" }> => n.kind === "text").map((n) => n.text);
    expect(texts).toContain("then");
    expect(texts).toContain("else: —");
    expect(l.nodes.some((n) => n.kind === "diamond")).toBe(true);
    const detect = cards(l.nodes).find((c) => c.titleFull === "detect") as Extract<LayoutNode, { kind: "card" }>;
    expect(detect.sub).toBe("interface · 8 possible");
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
    expect(subs).toContain("3 possible");
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

  it("sizes a fanout chip from its name, so a name of up to 14 characters is never cut", () => {
    const names = ["cpp", "jsonschema", "systemverilog", "typescript", "bazel", "cmake"];
    const g: StageGraph = {
      driver: { id: "app/src/run.ts#run", name: "run", file: "app/src/run.ts" },
      body: [
        call("f2", "detect", {
          fanout: { how: "interface", targets: names.map((c, i) => ({ fn: `pkg/${i}/x.ts#x`, name: "extract", component: `frontends/${c}` })) },
        }),
      ],
      edges: [],
      coverage: [],
    };
    const detect = cards(layoutStages(g).nodes)[0] as Extract<LayoutNode, { kind: "card" }>;
    expect(detect.chips.map((c) => c.label)).toEqual(names);
    expect(detect.chips.some((c) => c.label.endsWith("…"))).toBe(false);
  });

  it("puts a branch's condition just above its diamond, not at the top of the lanes", () => {
    const l = layoutStages(graph());
    const diamond = l.nodes.find((n): n is Extract<LayoutNode, { kind: "diamond" }> => n.kind === "diamond" && n.titleFull === "toExtract.length > 0");
    const cond = l.nodes.find((n): n is Extract<LayoutNode, { kind: "text" }> => n.kind === "text" && n.tone === "cond" && n.text === "toExtract.length > 0");
    expect(diamond && cond).toBeTruthy();
    // The label's baseline is above the diamond's top, and it starts at the diamond's left edge.
    expect(cond?.y).toBeLessThan(diamond?.y ?? 0);
    expect((diamond?.y ?? 0) - (cond?.y ?? 0)).toBeGreaterThan(0);
    expect((diamond?.y ?? 0) - (cond?.y ?? 0)).toBeLessThan(12);
    expect(cond?.x).toBe(diamond?.x);
  });

  it("keeps one row when the whole driver fits at a legible scale", () => {
    const p = planStages(graph(), { stageW: 4000 });
    expect(p.k).toBeGreaterThanOrEqual(LEGIBLE_K);
    expect(p.k).toBeLessThanOrEqual(1);
    expect(p.layout).toEqual(layoutStages(graph()));
  });

  it("wraps the top-level spine into rows that fit the stage, with a return connector between rows", () => {
    const wide = (i: number): StageNode => call(`w${i}`, `extractUnitOfWork${i}`, { ambiguous: true, candidates: 2 });
    const g: StageGraph = {
      driver: { id: "app/src/run.ts#run", name: "run", file: "app/src/run.ts" },
      body: Array.from({ length: 12 }, (_, i) => wide(i)),
      edges: [],
      coverage: [],
    };
    const stageW = 800;
    const p = planStages(g, { stageW });
    const l = p.layout;
    expect(p.k).toBeGreaterThanOrEqual(LEGIBLE_K);
    expect(new Set(cards(l.nodes).map((c) => c.y)).size).toBeGreaterThan(1);
    // Nothing overlaps and everything stays inside the diagram.
    const cs = cards(l.nodes);
    for (let i = 0; i < cs.length; i++) {
      for (let j = i + 1; j < cs.length; j++) expect(overlaps(rectOf(cs[i] as Rect), rectOf(cs[j] as Rect))).toBe(false);
    }
    for (const n of l.nodes) if ("w" in n) expect(inside(rectOf(n), { x: 0, y: 0, w: l.width, h: l.height })).toBe(true);
    // A return connector runs from a row's end back to the left, into the next row.
    const back = l.paths.filter((q) => q.arrow && q.points[0] !== undefined && q.points[q.points.length - 1] !== undefined && (q.points[0][0] ?? 0) > (q.points[q.points.length - 1]?.[0] ?? 0));
    expect(back.length).toBe(new Set(cs.map((c) => c.y)).size - 1);
    expect(l.width * p.k).toBeLessThanOrEqual(stageW + 1);
  });
});

/** A driver with three neighbours on one spine: scanProject → diffTrees, diffTrees → a loop, then writeShard. */
function dataGraph(): StageGraph {
  const loop = {
    kind: "loop",
    id: "loop9",
    variant: "for-of",
    condition: "const f of files",
    reads: ["files"],
    site: site(7),
    body: [call("c3", "shardKey")],
  } as StageNode;
  return {
    driver: { id: "app/src/run.ts#run", name: "run", file: "app/src/run.ts" },
    body: [call("c0", "scanProject"), call("c1", "diffTrees"), loop, call("c4", "writeShard")],
    edges: [
      { from: "c0", to: "c1", label: "scan", type: "ScanResult" },
      { from: "c1", to: "loop9", label: "files" },
      { from: "c0", to: "c4", label: "scan" },
    ],
    coverage: [],
  };
}

const boxOf = (n: LayoutNode): { x: number; y: number; w: number; h: number } | undefined =>
  n.kind === "card" || n.kind === "frame" || n.kind === "diamond" || n.kind === "data" ? n : undefined;
const boxesCross = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

describe("stages layout: data edges", () => {
  it("draws a pill on the connector of each neighbouring pair, with the type when it is short", () => {
    const layout = layoutStages(dataGraph(), { data: true });
    const pills = layout.nodes.filter((n): n is Extract<LayoutNode, { kind: "data" }> => n.kind === "data");
    expect(pills.map((p) => [p.from, p.to, p.text])).toEqual([
      ["c0", "c1", "scan: ScanResult"],
      ["c1", "loop9", "files"],
    ]);
    expect(pills[0]?.titleFull).toBe("scan: ScanResult");
  });

  it("never lets a data pill overlap a card, a frame or a diamond, and keeps it inside the diagram", () => {
    const layout = layoutStages(dataGraph(), { data: true });
    const solid = layout.nodes.filter((n) => n.kind === "card" || n.kind === "frame" || n.kind === "diamond");
    const pills = layout.nodes.filter((n) => n.kind === "data");
    expect(pills.length).toBeGreaterThan(0);
    for (const p of pills) {
      const pb = boxOf(p);
      expect(pb).toBeDefined();
      for (const s of solid) {
        const sb = boxOf(s);
        if (sb !== undefined && pb !== undefined) expect(boxesCross(pb, sb), `${JSON.stringify(pb)} vs ${JSON.stringify(sb)}`).toBe(false);
      }
      expect(pb?.x ?? -1).toBeGreaterThanOrEqual(0);
      expect((pb?.x ?? 0) + (pb?.w ?? 0)).toBeLessThanOrEqual(layout.width);
    }
  });

  it("draws an edge between stages that are not neighbours as a link, and no pill for it", () => {
    const layout = layoutStages(dataGraph(), { data: true });
    expect(layout.links.map((l) => [l.from, l.to, l.text])).toEqual([["c0", "c4", "scan"]]);
    expect(layout.nodes.some((n) => n.kind === "data" && n.from === "c0" && n.to === "c4")).toBe(false);
    // No band is reserved for the link: the diagram is as tall as the same one without links, and the arc starts under the top edge.
    const flat = layoutStages(dataGraph(), { data: false });
    expect(layout.height).toBe(flat.height);
    expect(layout.links[0]?.points[0]?.[1]).toBeGreaterThan(0);
    expect(layout.links[0]?.y).toBeLessThan(layout.links[0]?.points[0]?.[1] ?? 0);
  });

  it("draws no data at all when data is off, and the layout is the same as without edges", () => {
    const off = layoutStages(dataGraph(), { data: false });
    expect(off.links).toEqual([]);
    expect(off.nodes.some((n) => n.kind === "data")).toBe(false);
    const bare = layoutStages({ ...dataGraph(), edges: [] });
    expect(off).toEqual(bare);
  });

  it("widens a connector to fit its pill, so the cards on either side keep their place", () => {
    const off = layoutStages(dataGraph(), { data: false });
    const on = layoutStages(dataGraph(), { data: true });
    expect(on.width).toBeGreaterThan(off.width);
  });
});

/** Twelve cards on one spine, each linked to the card three places on: links that span the rows once the spine wraps. */
function spanGraph(): StageGraph {
  return {
    driver: { id: "app/src/run.ts#run", name: "run", file: "app/src/run.ts" },
    body: Array.from({ length: 12 }, (_, i) => call(`s${i}`, `stageNumber${i}`, { ambiguous: true, candidates: 2 })),
    edges: Array.from({ length: 9 }, (_, i) => ({ from: `s${i}`, to: `s${i + 3}`, label: `v${i}` })),
    coverage: [],
  };
}

/** The data graph with a link into a loop's frame, so a label can meet a frame header. */
function framedGraph(): StageGraph {
  const g = dataGraph();
  return { ...g, edges: [...g.edges, { from: "c1", to: "c4", label: "files" }, { from: "c0", to: "loop9", label: "n" }, { from: "c4", to: "c0", label: "back" }] };
}

/** The boxes a link label must clear: the cards and diamonds, the frame headers (not the frame bodies) and the data pills. */
function obstaclesOf(nodes: LayoutNode[]): Array<{ x: number; y: number; w: number; h: number }> {
  return nodes.flatMap((n) => {
    if (n.kind === "frame") return [{ x: n.x, y: n.y, w: n.w, h: LABEL_H }];
    const b = boxOf(n);
    return b !== undefined ? [b] : [];
  });
}

/** Eight cards on one spine, each linked to every card two or more places on, with long types: the links over one span crowd the top line. */
function crowdedGraph(): StageGraph {
  const edges: StageGraph["edges"] = [];
  for (let i = 0; i < 8; i++)
    for (let j = i + 2; j < 8; j++) edges.push({ from: `k${i}`, to: `k${j}`, label: `plugins${i}${j}`, type: "LoadedPluginsSnapshot" });
  return {
    driver: { id: "app/src/run.ts#run", name: "run", file: "app/src/run.ts" },
    body: Array.from({ length: 8 }, (_, i) => call(`k${i}`, `loadStage${i}`)),
    edges,
    coverage: [],
  };
}

describe("stages layout: link labels", () => {
  const layouts = () => [layoutStages(dataGraph(), { data: true }), layoutStages(framedGraph(), { data: true }), layoutStages(spanGraph(), { data: true, rowW: 600 })];

  it("arcs rise above both endpoints: the apex is above the higher card, and its label sits at the apex", () => {
    for (const layout of layouts()) {
      expect(layout.links.length).toBeGreaterThan(0);
      for (const l of layout.links) {
        const ys = l.points.map((p) => p[1]);
        const higher = Math.min(ys[0] ?? 0, ys[ys.length - 1] ?? 0);
        // The label's bottom edge is above the higher endpoint, and the curve's highest point is the apex under the label.
        expect(l.y + DATA_H).toBeLessThan(higher);
        expect(Math.min(...ys)).toBeLessThan(higher);
      }
    }
  });

  it("keeps every link label inside the diagram: x at least 0, inside the width, and below the drawn top", () => {
    for (const layout of layouts()) {
      for (const l of layout.links) {
        expect(l.x).toBeGreaterThanOrEqual(0);
        expect(l.x + l.w).toBeLessThanOrEqual(layout.width);
        expect(l.y).toBeGreaterThanOrEqual(layout.top);
      }
    }
  });

  it("no link label overlaps a card, a frame header, a data pill or another label", () => {
    for (const layout of layouts()) {
      const obstacles = obstaclesOf(layout.nodes);
      const labels = layout.links.map((l) => ({ x: l.x, y: l.y, w: l.w, h: DATA_H }));
      labels.forEach((li, i) => {
        for (const o of obstacles) expect(boxesCross(li, o), `label ${JSON.stringify(li)} vs ${JSON.stringify(o)}`).toBe(false);
        labels.slice(i + 1).forEach((lj) => expect(boxesCross(li, lj), `${JSON.stringify(li)} vs ${JSON.stringify(lj)}`).toBe(false));
      });
    }
  });

  it("stacks a label on a line above when the top line is full: no two link labels or labels and cards overlap, all stay in the margin", () => {
    const layout = layoutStages(crowdedGraph(), { data: true });
    const labels = layout.links.map((l) => ({ x: l.x, y: l.y, w: l.w, h: DATA_H }));
    expect(labels.length).toBeGreaterThan(8);
    // The crowded top line is full, so some labels sit on different lines.
    expect(new Set(labels.map((l) => l.y)).size).toBeGreaterThan(1);
    const obstacles = obstaclesOf(layout.nodes);
    labels.forEach((li, i) => {
      for (const o of obstacles) expect(boxesCross(li, o), `label ${JSON.stringify(li)} vs ${JSON.stringify(o)}`).toBe(false);
      labels.slice(i + 1).forEach((lj) => expect(boxesCross(li, lj), `${JSON.stringify(li)} vs ${JSON.stringify(lj)}`).toBe(false));
      expect(li.y).toBeGreaterThanOrEqual(-MARGIN);
      expect(li.x).toBeGreaterThanOrEqual(0);
      expect(li.x + li.w).toBeLessThanOrEqual(layout.width);
      expect(li.y + li.h).toBeLessThanOrEqual(layout.height);
    });
  });

  it("wraps the spine so that each row fits the row width with its connectors and pills counted", () => {
    const g: StageGraph = {
      driver: { id: "app/src/run.ts#run", name: "run", file: "app/src/run.ts" },
      body: Array.from({ length: 8 }, (_, i) => call(`p${i}`, `step${i}`)),
      edges: Array.from({ length: 7 }, (_, i) => ({ from: `p${i}`, to: `p${i + 1}`, label: "item", type: "AVeryLongTypeNameForThePillHere" })),
      coverage: [],
    };
    const rowW = 700;
    const layout = layoutStages(g, { data: true, rowW });
    expect(new Set(cards(layout.nodes).map((c) => c.y)).size).toBeGreaterThan(1);
    // The widest row is the diagram less its margins and row indent; no row may be wider than rowW.
    expect(layout.width - 2 * MARGIN - 2 * ROW_INDENT).toBeLessThanOrEqual(rowW);
  });
});

/** A fanout card three frames deep (loop, try, loop). Forty-eight long-labelled links join two top-level cards with a card between them, so their labels fill the top line and stack above it. */
function deepFanoutGraph(): StageGraph {
  const targets = ["bazel", "cmake", "cpp", "jsonschema", "systemverilog", "typescript"].map((c) => ({
    fn: `pkg/${c}/x.ts#x`,
    name: "extract",
    component: `frontends/${c}`,
  }));
  const fanout = call("d1", "detect", { fanout: { how: "interface", targets } });
  const inner = { kind: "loop", id: "dloop2", variant: "for-of", condition: "const f of files", site: site(8), body: [fanout] } as StageNode;
  const tr = {
    kind: "try",
    id: "dtry",
    site: site(9),
    body: [inner],
    handler: [{ kind: "exit", id: "dex", how: "continue", site: site(10) }],
  } as StageNode;
  const outer = { kind: "loop", id: "dloop1", variant: "for-of", condition: "const lf of plugins.frontends", site: site(7), body: [tr] } as StageNode;
  const edges: StageGraph["edges"] = Array.from({ length: 48 }, (_, i) => ({ from: "k0", to: "k2", label: `loaded plugin ${i}`, type: "LoadedPluginsSnapshot" }));
  return {
    driver: { id: "app/src/run.ts#run", name: "run", file: "app/src/run.ts" },
    body: [call("k0", "loadStage0"), call("k1", "loadStage1"), call("k2", "loadStage2"), outer],
    edges: [...edges, { from: "k0", to: "d1", label: "files", type: "LoadedPluginsSnapshot" }, { from: "d1", to: "k2", label: "back" }],
    coverage: [],
  };
}

describe("stages layout: nested fanout geometry", () => {
  const nested = () => layoutStages(deepFanoutGraph(), { data: true });
  const chipsOf = (nodes: LayoutNode[]) => cards(nodes).flatMap((c) => c.chips.map((ch) => ({ card: c, chip: ch })));
  const innerRect = (c: { x: number; y: number; w: number; h: number }): Rect => ({ x: c.x, y: c.y, w: c.w, h: c.h });

  it("is a real stacking case: the diagram is lifted by labels stacked above the top line, and the fanout sits three frames deep", () => {
    const layout = nested();
    // The same graph without its links has the same body; the only difference in height is the lift that stacked labels need.
    const base = layoutStages({ ...deepFanoutGraph(), edges: [] }, { data: true });
    expect(layout.height).toBeGreaterThan(base.height);
    const detect = cards(layout.nodes).find((c) => c.stage === "d1");
    expect(detect).toBeDefined();
    const holding = frames(layout.nodes).filter((f) => inside(innerRect(detect!), rectOf(f)));
    expect(holding.length).toBeGreaterThanOrEqual(3);
  });

  it("every chip of every card lies inside that card's box", () => {
    const layout = nested();
    const pairs = chipsOf(layout.nodes);
    expect(pairs.filter((p) => p.card.stage === "d1").length).toBe(6);
    for (const { card, chip } of pairs) {
      expect(inside({ x: chip.x, y: chip.y, w: chip.w, h: chip.h }, innerRect(card)), `chip ${chip.label} in ${card.title}`).toBe(true);
    }
  });

  it("every card and frame lies inside its parent frame, below the parent's header", () => {
    const layout = nested();
    const frameList = frames(layout.nodes);
    const nodes: Array<{ name: string; box: Rect }> = [
      ...cards(layout.nodes).map((c) => ({ name: c.title, box: innerRect(c) })),
      ...frameList.map((f) => ({ name: `frame ${f.label}`, box: innerRect(f) })),
    ];
    for (const n of nodes) {
      const parents = frameList.filter((f) => f.x !== n.box.x || f.y !== n.box.y || f.w !== n.box.w || f.h !== n.box.h).filter((f) => inside(n.box, rectOf(f)));
      if (parents.length === 0) continue;
      const parent = parents.reduce((a, b) => (a.w * a.h <= b.w * b.h ? a : b));
      expect(inside(n.box, rectOf(parent)), `${n.name} inside ${parent.label}`).toBe(true);
      expect(n.box.y, `${n.name} below the header of ${parent.label}`).toBeGreaterThanOrEqual(parent.y + LABEL_H);
    }
  });

  it("no two sibling cards or frames overlap: any two that neither contains the other are apart", () => {
    const layout = nested();
    const boxes: Array<{ name: string; box: Rect }> = [
      ...cards(layout.nodes).map((c) => ({ name: c.title, box: innerRect(c) })),
      ...frames(layout.nodes).map((f) => ({ name: `frame ${f.label}`, box: innerRect(f) })),
    ];
    boxes.forEach((a, i) =>
      boxes.slice(i + 1).forEach((b) => {
        if (inside(a.box, b.box) || inside(b.box, a.box)) return;
        expect(overlaps(a.box, b.box), `${a.name} vs ${b.name}`).toBe(false);
      }),
    );
  });
});
