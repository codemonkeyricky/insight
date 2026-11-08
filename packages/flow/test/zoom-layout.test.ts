import { describe, expect, it } from "vitest";
import {
  PROJECT_ID,
  ZOOM_SIZE,
  buildScopeTree,
  collapsedSize,
  edgeCurve,
  fileId,
  folderId,
  frameSize,
  isUnder,
  layoutContainerOf,
  layoutGraphOf,
  layoutKey,
  mergeCalls,
  openFor,
  placeEdges,
  placeScene,
  readLayout,
  stubsFor,
  type ContainerLayout,
  type ScopeFile,
  type ScopeFlow,
  type ScopeFunction,
} from "../src/index.js";

const sfn = (id: string, name: string, file: string, line: number): ScopeFunction => ({
  id,
  name,
  file,
  async: false,
  line,
  steps: 1,
  decisions: 0,
  loops: 0,
  tries: 0,
  awaits: 0,
  spawns: 0,
  effects: 0,
  exits: 1,
});
const sfile = (file: string, functions: number): ScopeFile => ({ file, functions, decisions: 0, loops: 0, tries: 0 });
const flowStats = {
  functions: 0,
  files: 0,
  calls: 0,
  resolved: 0,
  external: 0,
  unresolved: 0,
  inbound: 0,
  entries: 0,
  functionsTotal: 0,
  functionsNoise: 0,
  unreferenced: 0,
  unreferencedNoise: 0,
  unreferencedOutside: 0,
};

const DIFF = "packages/core/src/diff.ts";
const UTIL = "packages/core/src/util.ts";
const INDEX = "packages/flow/src/index.ts";
const MAIN = "apps/web/src/main.ts";
const DIFF_A = `${DIFF}#diffA`;
const DIFF_B = `${DIFF}#diffB`;
const FMT = `${UTIL}#fmt`;
const HELPER = "lib/x.ts#helper";

const rootFlow: ScopeFlow = {
  granularity: "files",
  functions: [],
  unreferenced: [],
  calls: [
    { from: DIFF, to: UTIL, count: 3, external: false },
    { from: INDEX, to: DIFF, count: 2, external: false },
    { from: MAIN, to: INDEX, count: 1, external: false },
  ],
  externals: [],
  entries: [MAIN],
  files: [sfile(MAIN, 1), sfile(DIFF, 2), sfile(UTIL, 1), sfile(INDEX, 1)],
  stats: { ...flowStats, files: 4, calls: 3, resolved: 3, entries: 1 },
};

const coreFlow: ScopeFlow = {
  granularity: "functions",
  functions: [sfn(DIFF_A, "diffA", DIFF, 3), sfn(DIFF_B, "diffB", DIFF, 9), sfn(FMT, "fmt", UTIL, 1)],
  unreferenced: [],
  calls: [
    { from: DIFF, to: DIFF_A, count: 1, external: false },
    { from: DIFF_A, to: DIFF_B, count: 4, external: false },
    { from: DIFF_A, to: FMT, count: 2, external: false },
    { from: FMT, to: HELPER, count: 1, external: true },
  ],
  externals: [{ id: HELPER, name: "helper", file: "lib/x.ts" }],
  entries: [DIFF_A],
  files: [sfile(DIFF, 2), sfile(UTIL, 1)],
  stats: { ...flowStats, functions: 3, files: 2, calls: 4, resolved: 3, external: 1, entries: 1 },
};

const tree = buildScopeTree([rootFlow, coreFlow]);
const links = mergeCalls([
  { scope: "", flow: rootFlow },
  { scope: "packages/core", flow: coreFlow },
]);

const srcOpen = openFor(tree, folderId("packages/core/src"));
const fileOpen = openFor(tree, fileId(DIFF));

describe("sizes", () => {
  it("gives a closed node the size of its kind, and an unknown id the stub size", () => {
    expect(collapsedSize(tree, fileId(DIFF))).toEqual(ZOOM_SIZE.file);
    expect(collapsedSize(tree, DIFF_A)).toEqual(ZOOM_SIZE.fn);
    expect(collapsedSize(tree, folderId("packages"))).toEqual(ZOOM_SIZE.folder);
    expect(collapsedSize(tree, HELPER)).toEqual(ZOOM_SIZE.stub);
  });

  it("adds the header and padding to a frame's content", () => {
    expect(frameSize({ w: 100, h: 50 })).toEqual({ w: 100 + 2 * ZOOM_SIZE.pad, h: 50 + ZOOM_SIZE.head + ZOOM_SIZE.pad });
  });
});

describe("layoutContainerOf", () => {
  it("lays a function out in its file, and a folder or file in itself", () => {
    expect(layoutContainerOf(tree, DIFF_A)).toBe(fileId(DIFF));
    expect(layoutContainerOf(tree, fileId(DIFF))).toBe(fileId(DIFF));
    expect(layoutContainerOf(tree, folderId("packages"))).toBe(folderId("packages"));
    expect(layoutContainerOf(tree, PROJECT_ID)).toBe(PROJECT_ID);
  });
});

describe("layoutGraphOf", () => {
  it("gives each child its collapsed size unless it is open", () => {
    const closed = layoutGraphOf(tree, folderId("packages/core/src"), new Map(), [], links);
    const byId = new Map(closed.children.map((c) => [c.id, c]));
    expect(byId.get(fileId(DIFF))).toMatchObject({ width: ZOOM_SIZE.file.w, height: ZOOM_SIZE.file.h });
    expect(byId.get(fileId(UTIL))).toMatchObject({ width: ZOOM_SIZE.file.w, height: ZOOM_SIZE.file.h });

    const expanded = new Map([[fileId(DIFF), { w: 400, h: 300 }]]);
    const open = layoutGraphOf(tree, folderId("packages/core/src"), expanded, [], links);
    expect(open.children.find((c) => c.id === fileId(DIFF))).toMatchObject({ width: 400, height: 300 });
  });

  it("joins two children by the calls between them, once each, with no self edges", () => {
    const g = layoutGraphOf(tree, folderId("packages/core/src"), new Map(), [], links);
    const kids = new Set(g.children.map((c) => c.id));
    expect(g.edges).toEqual([{ id: "e0", sources: [fileId(DIFF)], targets: [fileId(UTIL)] }]);
    for (const e of g.edges) {
      expect(kids.has(e.sources[0] ?? "")).toBe(true);
      expect(kids.has(e.targets[0] ?? "")).toBe(true);
      expect(e.sources[0]).not.toBe(e.targets[0]);
    }
  });

  it("adds the stubs as children and joins a call from a child to a stub", () => {
    const g = layoutGraphOf(tree, fileId(UTIL), new Map(), [HELPER], links);
    expect(g.children.map((c) => c.id).sort()).toEqual([FMT, HELPER].sort());
    expect(g.children.find((c) => c.id === HELPER)).toMatchObject({ width: ZOOM_SIZE.stub.w, height: ZOOM_SIZE.stub.h });
    expect(g.edges).toEqual([{ id: "e0", sources: [FMT], targets: [HELPER] }]);
  });
});

describe("stubsFor", () => {
  it("lists the external callees a container's calls reach", () => {
    expect(stubsFor(tree, links, openFor(tree, fileId(UTIL)), fileId(UTIL))).toEqual([HELPER]);
  });

  it("lists a stub for a container that calls out of the tree, and nothing for one that does not", () => {
    expect(stubsFor(tree, links, srcOpen, folderId("packages/core/src"))).toEqual([HELPER]);
    expect(stubsFor(tree, links, openFor(tree, folderId("packages/flow")), folderId("packages/flow"))).toEqual([]);
  });
});

describe("readLayout", () => {
  it("keeps the graph's sizes and takes the solver's positions", () => {
    const graph = layoutGraphOf(tree, folderId("packages/core/src"), new Map(), [], links);
    const laid = readLayout(graph, {
      width: 600,
      height: 120,
      children: [
        { id: fileId(DIFF), x: 0, y: 0 },
        { id: fileId(UTIL), x: 300, y: 10 },
      ],
    });
    expect(laid.slots).toEqual([
      { id: fileId(DIFF), x: 0, y: 0, w: ZOOM_SIZE.file.w, h: ZOOM_SIZE.file.h },
      { id: fileId(UTIL), x: 300, y: 10, w: ZOOM_SIZE.file.w, h: ZOOM_SIZE.file.h },
    ]);
    expect(laid.w).toBe(600);
    expect(laid.h).toBe(120);
  });

  it("grows to hold the slots when the solver gives no size", () => {
    const graph = { id: "c", layoutOptions: {}, children: [{ id: "a", width: 10, height: 5 }], edges: [] };
    expect(readLayout(graph, { children: [{ id: "a", x: 3, y: 2 }] })).toEqual({ w: 13, h: 7, slots: [{ id: "a", x: 3, y: 2, w: 10, h: 5 }] });
  });
});

describe("placeScene", () => {
  // A small hand-made tree of layouts: packages holds core, core holds diff.ts (open) and util.ts (closed),
  // and diff.ts holds its two functions.
  const layouts = new Map<string, ContainerLayout>([
    [PROJECT_ID, { w: 400, h: 300, slots: [{ id: folderId("packages"), x: 20, y: 10, w: 300, h: 200 }] }],
    [folderId("packages"), { w: 280, h: 180, slots: [{ id: folderId("packages/core"), x: 0, y: 0, w: 200, h: 150 }] }],
    [
      folderId("packages/core"),
      {
        w: 300,
        h: 300,
        slots: [
          { id: fileId(DIFF), x: 0, y: 0, w: 300, h: 200 },
          { id: fileId(UTIL), x: 0, y: 220, w: 220, h: 44 },
        ],
      },
    ],
    [
      fileId(DIFF),
      {
        w: 230,
        h: 110,
        slots: [
          { id: DIFF_A, x: 0, y: 0, w: 230, h: 44 },
          { id: DIFF_B, x: 0, y: 60, w: 230, h: 44 },
        ],
      },
    ],
  ]);
  const origin = { x: 100, y: 50 };

  it("places each slot inside its parent's content, below the header", () => {
    const placed = placeScene(tree, layouts, origin);
    expect(placed.rects.get(folderId("packages"))).toEqual({ x: 120, y: 60, w: 300, h: 200 });
    expect(placed.rects.get(folderId("packages/core"))).toEqual({ x: 136, y: 90, w: 200, h: 150 });
    expect(placed.rects.get(fileId(DIFF))).toEqual({ x: 152, y: 120, w: 300, h: 200 });
    expect(placed.rects.get(DIFF_A)).toEqual({ x: 168, y: 150, w: 230, h: 44 });
    expect(placed.rects.get(fileId(UTIL))).toEqual({ x: 152, y: 340, w: 220, h: 44 });
    expect(placed.width).toBe(400);
    expect(placed.height).toBe(300);
  });

  it("gives an open container a frame with its inner area, and a closed one a box", () => {
    const placed = placeScene(tree, layouts, origin);
    const byId = new Map(placed.items.map((i) => [i.id, i]));
    expect(byId.get(fileId(DIFF))).toMatchObject({
      kind: "frame",
      inner: { x: 168, y: 150, w: 268, h: 154 },
    });
    expect(byId.get(fileId(UTIL))?.kind).toBe("box");
    expect(byId.get(DIFF_A)?.kind).toBe("box");
  });

  it("draws the focused function as a chart in its slot, sized to the chart", () => {
    const placed = placeScene(tree, layouts, origin, { id: DIFF_A, w: 400, h: 300 });
    const cfg = placed.items.find((i) => i.id === DIFF_A);
    expect(cfg?.kind).toBe("cfg");
    // The slot is at (168, 150); the chart sits inside its padding and header.
    expect(cfg?.inner).toEqual({ x: 184, y: 180, w: 400, h: 300 });
  });

  it("draws a callee outside the tree as a stub", () => {
    const withStub = new Map(layouts);
    withStub.set(fileId(DIFF), { w: 230, h: 110, slots: [{ id: HELPER, x: 0, y: 0, w: 200, h: 40 }] });
    const placed = placeScene(tree, withStub, origin);
    expect(placed.items.find((i) => i.id === HELPER)?.kind).toBe("stub");
  });

  it("places nothing when there is no project layout", () => {
    expect(placeScene(tree, new Map(), origin)).toEqual({ items: [], rects: new Map(), width: 0, height: 0 });
  });
});

describe("edgeCurve", () => {
  it("leaves the right side of a box to the left side of a box on its right", () => {
    expect(edgeCurve({ x: 0, y: 0, w: 10, h: 10 }, { x: 100, y: 0, w: 10, h: 10 })).toMatch(/^M10 5 C/);
    expect(edgeCurve({ x: 0, y: 0, w: 10, h: 10 }, { x: 100, y: 0, w: 10, h: 10 })).toMatch(/ 100 5$/);
  });

  it("leaves the bottom of a box to the top of a box below it", () => {
    expect(edgeCurve({ x: 0, y: 0, w: 10, h: 10 }, { x: 0, y: 100, w: 10, h: 10 })).toMatch(/^M5 10 C/);
    expect(edgeCurve({ x: 0, y: 0, w: 10, h: 10 }, { x: 0, y: 100, w: 10, h: 10 })).toMatch(/ 5 100$/);
  });
});

describe("placeEdges", () => {
  it("places a call between the boxes on screen, and skips one whose end has no rectangle", () => {
    // With diff.ts open, its functions are on screen and util.ts is a closed box that holds fmt.
    const rects = new Map([
      [DIFF_A, { x: 0, y: 0, w: 230, h: 44 }],
      [fileId(UTIL), { x: 300, y: 0, w: 220, h: 44 }],
    ]);
    const placed = placeEdges(tree, links, fileOpen, fileId(DIFF), rects);
    const toUtil = placed.find((e) => e.from === DIFF_A && e.to === fileId(UTIL));
    expect(toUtil?.count).toBe(2);
    expect(toUtil?.d.startsWith("M230 22 C")).toBe(true);
    expect(placed.some((e) => e.to === DIFF_B)).toBe(false);
  });
});

describe("layoutKey", () => {
  it("is the same for the same inputs whatever order the sizes were added in", () => {
    const a = new Map([
      [fileId(DIFF), { w: 1, h: 2 }],
      [fileId(UTIL), { w: 3, h: 4 }],
    ]);
    const b = new Map([
      [fileId(UTIL), { w: 3, h: 4 }],
      [fileId(DIFF), { w: 1, h: 2 }],
    ]);
    expect(layoutKey("c", a, [HELPER], 1)).toBe(layoutKey("c", b, [HELPER], 1));
  });

  it("changes with the tree version, the container, the sizes and the stubs", () => {
    const sizes = new Map([[fileId(DIFF), { w: 1, h: 2 }]]);
    const base = layoutKey("c", sizes, [], 1);
    expect(layoutKey("c", sizes, [], 2)).not.toBe(base);
    expect(layoutKey("d", sizes, [], 1)).not.toBe(base);
    expect(layoutKey("c", new Map([[fileId(DIFF), { w: 9, h: 2 }]]), [], 1)).not.toBe(base);
    expect(layoutKey("c", sizes, [HELPER], 1)).not.toBe(base);
  });
});

describe("isUnder", () => {
  it("is true for the node itself and for every node below it", () => {
    expect(isUnder(tree, DIFF_A, fileId(DIFF))).toBe(true);
    expect(isUnder(tree, DIFF_A, folderId("packages"))).toBe(true);
    expect(isUnder(tree, DIFF_A, fileId(UTIL))).toBe(false);
    expect(isUnder(tree, fileId(DIFF), fileId(DIFF))).toBe(true);
  });
});
