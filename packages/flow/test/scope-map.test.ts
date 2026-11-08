import { describe, expect, it } from "vitest";
import {
  COLLAPSE_PX,
  EXPAND_PX,
  PROJECT_ID,
  boxOf,
  breadcrumb,
  buildScopeTree,
  depthOf,
  fileBands,
  fileId,
  fitCamera,
  focusAt,
  focusFromUrl,
  folderId,
  frontier,
  insideScope,
  levelOf,
  mapEdges,
  mergeCalls,
  nextOpen,
  openFor,
  urlFocus,
  visibleWorld,
  type MapEdge,
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
  functionsTests: 0,
  unreferenced: 0,
  unreferencedTests: 0,
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

// The project's flow, in files granularity: one row per file, file-level calls.
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

// The packages/core flow, in functions granularity. Its module-level call from diff.ts and its calls from
// functions are the ones the project flow must not repeat.
const coreFlow: ScopeFlow = {
  granularity: "functions",
  functions: [sfn(DIFF_A, "diffA", DIFF, 3), sfn(DIFF_B, "diffB", DIFF, 9), sfn(FMT, "fmt", UTIL, 1)],
  // Every function here is called in its scope: diff.ts calls diffA, diffA calls diffB and fmt.
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

// Open: the packages folder chain down to diff.ts, so its two functions are on screen and util.ts is a closed box.
const OPEN = new Set([folderId("packages"), folderId("packages/core"), folderId("packages/core/src"), fileId(DIFF)]);

const find = (edges: MapEdge[], from: string, to: string) => edges.find((e) => e.from === from && e.to === to);

describe("buildScopeTree", () => {
  it("nests folders by path and counts functions bottom-up", () => {
    expect(tree.nodes.get(PROJECT_ID)?.functions).toBe(5);
    expect(tree.nodes.get(folderId("packages/core"))?.functions).toBe(3);
    expect(tree.nodes.get(folderId("packages/flow"))?.functions).toBe(1);
    expect(tree.nodes.get(fileId(DIFF))?.functions).toBe(2);
    expect(tree.nodes.get(fileId(UTIL))?.functions).toBe(1);
    expect(tree.nodes.get(DIFF_A)?.parent).toBe(fileId(DIFF));
    expect(tree.nodes.get(folderId("packages/core/src"))?.children.sort()).toEqual([fileId(DIFF), fileId(UTIL)].sort());
  });

  it("lists every file in path order", () => {
    expect(tree.files).toEqual([MAIN, DIFF, UTIL, INDEX]);
  });

  it("keeps the external callees of every flow", () => {
    expect(tree.externals.get(HELPER)?.file).toBe("lib/x.ts");
  });

  it("gives each node its depth and kind", () => {
    expect(depthOf(tree, PROJECT_ID)).toBe(0);
    expect(depthOf(tree, folderId("packages"))).toBe(1);
    expect(depthOf(tree, fileId(DIFF))).toBe(4);
    expect(depthOf(tree, DIFF_A)).toBe(5);
    expect(depthOf(tree, "missing")).toBe(-1);
    expect(levelOf(tree, DIFF_A)).toBe("function");
    expect(levelOf(tree, fileId(DIFF))).toBe("file");
    expect(levelOf(tree, "missing")).toBeUndefined();
  });
});

describe("mergeCalls", () => {
  it("counts each call once, from the deepest scope that holds its caller", () => {
    expect(links).toHaveLength(6);
    // Caller diff.ts sits in packages/core, so the project's copy of its file-level call is dropped.
    expect(links.find((l) => l.from === fileId(DIFF) && l.to === fileId(UTIL))).toBeUndefined();
    expect(links.find((l) => l.from === fileId(INDEX) && l.to === fileId(DIFF))).toMatchObject({ count: 2, external: false });
    expect(links.find((l) => l.from === fileId(DIFF) && l.to === DIFF_A)).toMatchObject({ count: 1 });
    expect(links.find((l) => l.from === DIFF_A && l.to === FMT)).toMatchObject({ count: 2 });
    expect(links.find((l) => l.from === FMT && l.to === HELPER)).toMatchObject({ count: 1, external: true });
  });

  it("does not double a flow that is given twice", () => {
    const twice = mergeCalls([
      { scope: "packages/core", flow: coreFlow },
      { scope: "packages/core", flow: coreFlow },
    ]);
    expect(twice.find((l) => l.from === DIFF_A && l.to === DIFF_B)?.count).toBe(4);
  });

  it("takes a call whose caller no scope holds once, from the first flow that lists it", () => {
    const orphan = mergeCalls([
      { scope: "packages/flow", flow: rootFlow },
      { scope: "packages/flow", flow: rootFlow },
    ]);
    // main.ts is in no given scope, so its call is taken once.
    expect(orphan.find((l) => l.from === fileId(MAIN))?.count).toBe(1);
    // index.ts is in packages/flow, which is the authority for its call.
    expect(orphan.find((l) => l.from === fileId(INDEX))?.count).toBe(2);
  });
});

describe("insideScope", () => {
  it("holds every path for the project, and only the folder's own paths otherwise", () => {
    expect(insideScope(MAIN, "")).toBe(true);
    expect(insideScope(DIFF, "packages/core")).toBe(true);
    expect(insideScope(DIFF, DIFF)).toBe(true);
    expect(insideScope("packages/corex/a.ts", "packages/core")).toBe(false);
  });
});

describe("frontier", () => {
  it("shows the top-level folders when nothing is open", () => {
    expect(frontier(tree, new Set()).sort()).toEqual([folderId("apps"), folderId("packages")].sort());
  });

  it("opens the chain down to a file and shows its functions", () => {
    expect(frontier(tree, OPEN).sort()).toEqual([folderId("apps"), folderId("packages/flow"), fileId(UTIL), DIFF_A, DIFF_B].sort());
  });
});

describe("boxOf", () => {
  const visible = new Set(frontier(tree, OPEN));

  it("returns a node that is on screen as its own box", () => {
    expect(boxOf(tree, OPEN, visible, DIFF_A)).toBe(DIFF_A);
  });

  it("returns a function under a closed file as that file", () => {
    expect(boxOf(tree, OPEN, visible, FMT)).toBe(fileId(UTIL));
  });

  it("returns a file in a closed folder as that folder", () => {
    expect(boxOf(tree, OPEN, visible, fileId(MAIN))).toBe(folderId("apps"));
  });

  it("returns an open file for its own module-level code", () => {
    expect(boxOf(tree, OPEN, visible, fileId(DIFF))).toBe(fileId(DIFF));
  });

  it("returns an external callee as itself", () => {
    expect(boxOf(tree, OPEN, visible, HELPER)).toBe(HELPER);
  });

  it("returns undefined for an id the tree does not hold", () => {
    expect(boxOf(tree, OPEN, visible, "nope")).toBeUndefined();
  });
});

describe("mapEdges", () => {
  it("sums the calls between boxes and marks the ones that cross the focus as stubs", () => {
    const edges = mapEdges(tree, links, OPEN, folderId("packages/core"));
    expect(edges).toHaveLength(6);
    expect(find(edges, folderId("packages/flow"), fileId(DIFF))).toMatchObject({ count: 2, stubCount: 2, stub: true });
    expect(find(edges, DIFF_A, DIFF_B)).toMatchObject({ count: 4, stubCount: 0, stub: false });
    expect(find(edges, DIFF_A, fileId(UTIL))).toMatchObject({ count: 2, stub: false });
    expect(find(edges, fileId(UTIL), HELPER)).toMatchObject({ count: 1, stubCount: 1, stub: true });
    expect(find(edges, folderId("apps"), folderId("packages/flow"))).toMatchObject({ count: 1, stub: false });
  });

  it("turns a stub into a resolved call once the focus widens to take in the other end", () => {
    const narrow = mapEdges(tree, links, openFor(tree, folderId("packages/flow")), folderId("packages/flow"));
    const wide = mapEdges(tree, links, openFor(tree, folderId("packages")), folderId("packages"));
    expect(find(narrow, folderId("packages/flow/src"), folderId("packages/core"))).toMatchObject({ count: 2, stub: true });
    expect(find(wide, folderId("packages/flow"), folderId("packages/core"))).toMatchObject({ count: 2, stub: false });
  });

  it("counts an unknown focus as the project, where only calls to unloaded code are stubs", () => {
    const edges = mapEdges(tree, links, new Set([PROJECT_ID]), "nope");
    expect(edges.filter((e) => e.stub).map((e) => e.to)).toEqual([HELPER]);
  });
});

describe("focusAt", () => {
  const boxes = [
    { id: folderId("packages"), x: 0, y: 0, w: 1000, h: 1000 },
    { id: fileId(DIFF), x: 100, y: 100, w: 300, h: 300 },
    { id: DIFF_A, x: 120, y: 120, w: 50, h: 50 },
  ];

  it("picks the deepest box under the point", () => {
    expect(focusAt(tree, boxes, 130, 130)).toBe(DIFF_A);
    expect(focusAt(tree, boxes, 300, 300)).toBe(fileId(DIFF));
    expect(focusAt(tree, boxes, 50, 50)).toBe(folderId("packages"));
  });

  it("returns undefined when no box holds the point", () => {
    expect(focusAt(tree, boxes, 2000, 2000)).toBeUndefined();
  });
});

describe("openFor", () => {
  const chain = new Set([folderId("packages/core/src"), folderId("packages/core"), folderId("packages"), fileId(DIFF)]);

  it("opens a file's folders and the file itself", () => {
    expect(openFor(tree, fileId(DIFF))).toEqual(chain);
  });

  it("opens the folders above a function, and its file", () => {
    expect(openFor(tree, DIFF_A)).toEqual(chain);
  });

  it("opens nothing for an unknown focus", () => {
    expect(openFor(tree, "missing").size).toBe(0);
  });
});

describe("expansion hysteresis", () => {
  it("opens a box only once it is wider than EXPAND_PX", () => {
    expect(EXPAND_PX).toBe(240);
    expect(nextOpen(null, null, { id: "a", width: 240 })).toBeNull();
    expect(nextOpen(null, null, { id: "a", width: 241 })).toBe("a");
  });

  it("keeps an open box until it is narrower than COLLAPSE_PX", () => {
    expect(COLLAPSE_PX).toBe(200);
    expect(nextOpen("a", 200, null)).toBe("a");
    expect(nextOpen("a", 199.9, null)).toBeNull();
  });

  it("does not let a neighbour that is not wide enough take over an open box", () => {
    expect(nextOpen("a", 220, { id: "b", width: 230 })).toBe("a");
  });

  it("lets a wider neighbour take over", () => {
    expect(nextOpen("a", 220, { id: "b", width: 260 })).toBe("b");
  });

  it("stays closed with nothing under the focus", () => {
    expect(nextOpen(null, null, null)).toBeNull();
  });
});

describe("camera fit", () => {
  const target = { x: 100, y: 50, w: 200, h: 100 };
  const vp = { width: 800, height: 400 };

  it("centres the target in the viewport and fills it, with padding", () => {
    const cam = fitCamera(target, vp);
    expect(cam.k).toBeCloseTo(3.68);
    expect((target.x + target.w / 2) * cam.k + cam.x).toBeCloseTo(vp.width / 2);
    expect((target.y + target.h / 2) * cam.k + cam.y).toBeCloseTo(vp.height / 2);
  });

  it("shows the whole target", () => {
    const cam = fitCamera(target, vp);
    const seen = visibleWorld(cam, vp);
    expect(seen.x).toBeLessThanOrEqual(target.x);
    expect(seen.x + seen.w).toBeGreaterThanOrEqual(target.x + target.w);
    expect(seen.y).toBeLessThanOrEqual(target.y);
    expect(seen.y + seen.h).toBeGreaterThanOrEqual(target.y + target.h);
  });

  it("honours the padding option and clamps the scale", () => {
    expect(fitCamera(target, vp, { padding: 1 }).k).toBeCloseTo(4);
    expect(fitCamera({ x: 0, y: 0, w: 1, h: 1 }, vp).k).toBe(16);
    expect(fitCamera({ x: 0, y: 0, w: 1e6, h: 1e6 }, vp).k).toBe(0.02);
  });
});

describe("breadcrumb and URL", () => {
  it("lists the path from the project down to a function", () => {
    expect(breadcrumb(tree, DIFF_A).map((n) => n.name)).toEqual(["", "packages", "core", "src", "diff.ts", "diffA"]);
  });

  it("maps a focus to a scope and a function", () => {
    expect(urlFocus(tree, DIFF_A)).toEqual({ scope: DIFF, fn: DIFF_A });
    expect(urlFocus(tree, fileId(DIFF))).toEqual({ scope: DIFF });
    expect(urlFocus(tree, folderId("packages/core"))).toEqual({ scope: "packages/core" });
    expect(urlFocus(tree, PROJECT_ID)).toEqual({ scope: "" });
    expect(urlFocus(tree, "missing")).toBeUndefined();
  });

  it("reads back every node's own URL", () => {
    for (const id of tree.nodes.keys()) {
      const u = urlFocus(tree, id);
      expect(u).toBeDefined();
      expect(focusFromUrl(tree, u!.scope, u!.fn)).toBe(id);
    }
  });

  it("falls back from an unknown function to its scope, and returns undefined for an unknown scope", () => {
    expect(focusFromUrl(tree, "packages/core", "packages/core/src/gone.ts#x")).toBe(folderId("packages/core"));
    expect(focusFromUrl(tree, "nope")).toBeUndefined();
  });
});

describe("fileBands", () => {
  it("gives each file a band in path order, wrapping after the last band", () => {
    expect([...fileBands(tree, 3).values()]).toEqual([0, 1, 2, 0]);
    expect(fileBands(tree, 0).get(MAIN)).toBe(0);
  });
});
