import elkBundled from "elkjs/lib/elk.bundled.js";
import { describe, expect, it } from "vitest";
import type { Scene, SceneEdge, SceneLevel, SceneNode } from "../src/scene.js";
import {
  layoutCovers,
  COLUMNS,
  LAYERED_MAX_CHILDREN,
  PACKED,
  callColumns,
  layoutScene,
  packRows,
  sceneLayoutOptions,
  placeSceneEdges,
  placeSceneLayout,
  sceneBoxOf,
  sceneBreadcrumb,
  sceneClosedSize,
  sceneContainers,
  sceneDepth,
  sceneEdgeContainer,
  sceneEdges,
  sceneFocusAt,
  sceneFrontier,
  sceneLayoutGraph,
  sceneNodeSize,
  sceneOpenFor,
  scopeScene,
  type SceneSolver,
} from "../src/scene-layout.js";
import { PROJECT_ID, buildScopeTree, fileId, folderId, mergeCalls, openFor } from "../src/scope-map.js";
import type { ScopeFile, ScopeFlow, ScopeFunction } from "../src/types.js";
import { LAYERED, ZOOM_SIZE, edgeCurve, frameSize, layoutGraphOf, stubsFor, type LayoutGraph, type Size } from "../src/zoom-layout.js";

// elk.bundled.js sets module.exports to the ELK class itself, but its typings declare an ES default export, so under
// NodeNext the default import is typed as the module and its `default` as the class.
const ELK = elkBundled as unknown as typeof elkBundled.default;
const elk = new ELK();
const solveElk: SceneSolver = (g) => elk.layout(g);

/** A deterministic stand-in for ELK: children in a grid of `cols` columns, each cell as big as the largest child plus a gap. */
const gridSolver =
  (cols = 2, gap = 10): SceneSolver =>
  async (g: LayoutGraph) => {
    const cw = Math.max(0, ...g.children.map((c) => c.width)) + gap;
    const ch = Math.max(0, ...g.children.map((c) => c.height)) + gap;
    return { children: g.children.map((c, i) => ({ id: c.id, x: (i % cols) * cw, y: Math.floor(i / cols) * ch })) };
  };

const overlaps = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

// --- The scope fixture, the same kind as zoom-layout.test.ts ---

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
  functionsNonNoise: 0,
};

const DIFF = "packages/core/src/diff.ts";
const UTIL = "packages/core/src/util.ts";
const INDEX = "packages/flow/src/index.ts";
const MAIN = "apps/web/src/main.ts";
const DIFF_A = `${DIFF}#diffA`;
const DIFF_B = `${DIFF}#diffB`;
const DIFF_C = `${DIFF}#diffC`;
const FMT = `${UTIL}#fmt`;
const PAD = `${UTIL}#pad`;
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
  files: [sfile(MAIN, 1), sfile(DIFF, 3), sfile(UTIL, 2), sfile(INDEX, 1)],
  stats: { ...flowStats, files: 4, calls: 3, resolved: 3, entries: 1 },
};

const coreFlow: ScopeFlow = {
  granularity: "functions",
  functions: [sfn(DIFF_A, "diffA", DIFF, 3), sfn(DIFF_B, "diffB", DIFF, 9), sfn(DIFF_C, "diffC", DIFF, 20), sfn(FMT, "fmt", UTIL, 1), sfn(PAD, "pad", UTIL, 8)],
  unreferenced: [],
  calls: [
    { from: DIFF, to: DIFF_A, count: 1, external: false },
    { from: DIFF_A, to: DIFF_B, count: 4, external: false },
    { from: DIFF_B, to: DIFF_C, count: 1, external: false },
    { from: DIFF_A, to: DIFF_C, count: 1, external: false },
    { from: DIFF_A, to: FMT, count: 2, external: false },
    { from: FMT, to: PAD, count: 1, external: false },
    { from: FMT, to: HELPER, count: 1, external: true },
  ],
  externals: [{ id: HELPER, name: "helper", file: "lib/x.ts" }],
  entries: [DIFF_A],
  files: [sfile(DIFF, 3), sfile(UTIL, 2)],
  stats: { ...flowStats, functions: 5, files: 2, calls: 7, resolved: 6, external: 1, entries: 1 },
};

const tree = buildScopeTree([rootFlow, coreFlow]);
const links = mergeCalls([
  { scope: "", flow: rootFlow },
  { scope: "packages/core", flow: coreFlow },
]);

describe("scopeScene", () => {
  const scene = scopeScene(tree, links);

  it("mirrors every tree node, with labels, details, notes and refs", () => {
    expect(scene.root).toBe(PROJECT_ID);
    expect(scene.nodes.size).toBe(tree.nodes.size);
    for (const [id, n] of tree.nodes) {
      const s = scene.nodes.get(id);
      expect(s).toMatchObject({ id, kind: n.kind, children: n.children, note: n.path });
      expect(s?.parent).toBe(n.parent);
    }
    expect(scene.nodes.get(PROJECT_ID)?.label).toBe("Project");
    expect(scene.nodes.get(fileId(DIFF))).toMatchObject({ label: "diff.ts", detail: "3 functions" });
    expect(scene.nodes.get(DIFF_A)).toMatchObject({ label: "diffA", ref: DIFF_A });
    expect(scene.nodes.get(DIFF_A)?.detail).toBeUndefined();
    expect(scene.nodes.get(fileId(MAIN))?.detail).toBe("1 function");
  });

  it("keeps the calls between tree nodes and drops the calls to externals", () => {
    const inTree = links.filter((l) => tree.nodes.has(l.from) && tree.nodes.has(l.to));
    expect(inTree.length).toBeLessThan(links.length);
    expect(scene.edges).toEqual(inTree.map((l) => ({ from: l.from, to: l.to, kind: "call", count: l.count, candidate: l.candidate })));
    expect(scene.edges.some((e) => e.to === HELPER || e.from === HELPER)).toBe(false);
  });

  it("gives each kind the scope map's box size and the layered layout", () => {
    expect(scene.levels.project?.box).toEqual(ZOOM_SIZE.folder);
    expect(scene.levels.folder?.box).toEqual(ZOOM_SIZE.folder);
    expect(scene.levels.file?.box).toEqual(ZOOM_SIZE.file);
    expect(scene.levels.function?.box).toEqual(ZOOM_SIZE.fn);
    for (const l of Object.values(scene.levels)) expect(l.layout).toEqual(LAYERED);
  });

  it("builds the same container graphs as layoutGraphOf, minus the stubs", () => {
    const cases: [string, Map<string, Size>][] = [
      [PROJECT_ID, new Map([[folderId("packages"), { w: 700, h: 400 }]])],
      [folderId("packages"), new Map()],
      [folderId("packages/core/src"), new Map([[fileId(DIFF), { w: 520, h: 110 }]])],
      [fileId(DIFF), new Map()],
      [fileId(UTIL), new Map()],
    ];
    let edgesSeen = 0;
    for (const [c, sizes] of cases) {
      const stubs = stubsFor(tree, links, openFor(tree, c), c);
      const stubSet = new Set(stubs);
      const want = layoutGraphOf(tree, c, sizes, stubs, links);
      const got = sceneLayoutGraph(scene, c, sizes);
      expect(got.id).toBe(c);
      expect(got.layoutOptions).toEqual(want.layoutOptions);
      expect(got.children).toEqual(want.children.filter((k) => !stubSet.has(k.id)));
      const pairs = (g: LayoutGraph) => g.edges.map((e) => [e.sources, e.targets]);
      const wantEdges = want.edges.filter((e) => !stubSet.has(e.sources[0] ?? "") && !stubSet.has(e.targets[0] ?? ""));
      expect(pairs(got)).toEqual(pairs({ ...want, edges: wantEdges }));
      expect(got.edges.map((e) => e.id)).toEqual(got.edges.map((_, i) => `e${i}`));
      edgesSeen += got.edges.length;
    }
    // The fixture must exercise edges: apps -> packages, flow -> core, diff -> util, and the functions in each file.
    expect(edgesSeen).toBeGreaterThanOrEqual(5);
  });

  it("lays the whole scope tree out with elkjs", async () => {
    const layout = await layoutScene(scene, solveElk);
    expect(layoutCovers(scene, layout)).toBe(true);
    expect(Object.keys(layout.containers).sort()).toEqual([...tree.nodes.values()].filter((n) => n.children.length > 0).map((n) => n.id).sort());
  });
});

// --- A hand-built execution-like scene: program -> thread -> coroutine -> function ---
//
//   P (program)
//   ├── T1 (thread)
//   │   ├── C1 (coroutine): f1, f2
//   │   └── C2 (coroutine): f3
//   └── T2 (thread)
//       ├── C3 (coroutine): g1, g2
//       └── g3 (task, a kind with no level)

const LEVELS: Record<string, SceneLevel> = {
  program: { box: { w: 300, h: 80 } },
  thread: { box: { w: 260, h: 60 } },
  coroutine: { box: { w: 240, h: 50 } },
  function: { box: { w: 230, h: 44 } },
};

function makeScene(spec: Record<string, { kind: string; parent?: string }>, edges: SceneEdge[], levels: Record<string, SceneLevel>, root: string): Scene {
  const nodes = new Map<string, SceneNode>();
  for (const [id, s] of Object.entries(spec)) {
    const node: SceneNode = { id, kind: s.kind, label: id, children: [] };
    if (s.parent !== undefined) node.parent = s.parent;
    nodes.set(id, node);
  }
  for (const n of nodes.values()) if (n.parent !== undefined) nodes.get(n.parent)?.children.push(n.id);
  return { root, nodes, edges, levels };
}

const exec = makeScene(
  {
    P: { kind: "program" },
    T1: { kind: "thread", parent: "P" },
    C1: { kind: "coroutine", parent: "T1" },
    f1: { kind: "function", parent: "C1" },
    f2: { kind: "function", parent: "C1" },
    C2: { kind: "coroutine", parent: "T1" },
    f3: { kind: "function", parent: "C2" },
    T2: { kind: "thread", parent: "P" },
    C3: { kind: "coroutine", parent: "T2" },
    g1: { kind: "function", parent: "C3" },
    g2: { kind: "function", parent: "C3" },
    g3: { kind: "task", parent: "T2" },
  },
  [
    { from: "f1", to: "g1", kind: "call", count: 2 },
    { from: "f2", to: "g2", kind: "call", count: 3, candidate: true },
    { from: "f1", to: "f2", kind: "call", count: 1 },
    { from: "f3", to: "g1", kind: "spawn", count: 1, how: "thread" },
    { from: "T1", to: "f1", kind: "spawn", count: 1 },
  ],
  LEVELS,
  "P",
);

describe("scene queries", () => {
  it("counts depth from the root, and -1 for unknown ids", () => {
    expect(sceneDepth(exec, "P")).toBe(0);
    expect(sceneDepth(exec, "T2")).toBe(1);
    expect(sceneDepth(exec, "C1")).toBe(2);
    expect(sceneDepth(exec, "f1")).toBe(3);
    expect(sceneDepth(exec, "nope")).toBe(-1);
  });

  it("lists the breadcrumb root first", () => {
    expect(sceneBreadcrumb(exec, "f1").map((n) => n.id)).toEqual(["P", "T1", "C1", "f1"]);
    expect(sceneBreadcrumb(exec, "g3").map((n) => n.id)).toEqual(["P", "T2", "g3"]);
    expect(sceneBreadcrumb(exec, "nope")).toEqual([]);
  });

  it("opens every ancestor but the root, and the focus when it has children", () => {
    expect([...sceneOpenFor(exec, "f1")].sort()).toEqual(["C1", "T1"]);
    expect([...sceneOpenFor(exec, "C3")].sort()).toEqual(["C3", "T2"]);
    expect([...sceneOpenFor(exec, "g3")]).toEqual(["T2"]);
    expect([...sceneOpenFor(exec, "T1")]).toEqual(["T1"]);
    expect(sceneOpenFor(exec, "nope").size).toBe(0);
  });

  it("shows the root's children, and the children of open containers", () => {
    expect(sceneFrontier(exec, new Set())).toEqual(["T1", "T2"]);
    expect(sceneFrontier(exec, new Set(["T1"]))).toEqual(["C1", "C2", "T2"]);
    expect(sceneFrontier(exec, new Set(["T1", "C1", "T2"]))).toEqual(["f1", "f2", "C2", "C3", "g3"]);
    // An open leaf is still a box, and an open node under a closed one is not reached.
    expect(sceneFrontier(exec, new Set(["g3", "C1"]))).toEqual(["T1", "T2"]);
    expect(sceneFrontier({ ...exec, root: "nope" }, new Set())).toEqual([]);
  });

  it("climbs an id to its deepest visible ancestor", () => {
    const closed = new Set(sceneFrontier(exec, new Set()));
    expect(sceneBoxOf(exec, closed, "f1")).toBe("T1");
    expect(sceneBoxOf(exec, closed, "g3")).toBe("T2");
    expect(sceneBoxOf(exec, closed, "T1")).toBe("T1");
    expect(sceneBoxOf(exec, closed, "P")).toBeUndefined();
    expect(sceneBoxOf(exec, closed, "nope")).toBeUndefined();
    const deep = new Set(sceneFrontier(exec, new Set(["T1", "T2"])));
    expect(sceneBoxOf(exec, deep, "f1")).toBe("C1");
    expect(sceneBoxOf(exec, deep, "g2")).toBe("C3");
    expect(sceneBoxOf(exec, new Set(), "f1")).toBeUndefined();
  });

  it("climbs edges to the top-level boxes when closed, summing counts per kind and dropping self-edges", () => {
    expect(sceneEdges(exec, new Set())).toEqual([
      { from: "T1", to: "T2", kind: "call", count: 5, candidate: true },
      { from: "T1", to: "T2", kind: "spawn", count: 1, candidate: false },
    ]);
  });

  it("climbs edges to deeper boxes when open", () => {
    expect(sceneEdges(exec, new Set(["T1", "T2"]))).toEqual([
      { from: "C1", to: "C3", kind: "call", count: 5, candidate: true },
      { from: "C2", to: "C3", kind: "spawn", count: 1, candidate: false },
    ]);
    expect(sceneEdges(exec, new Set(["T1", "C1", "T2", "C3"]))).toEqual([
      { from: "f1", to: "g1", kind: "call", count: 2, candidate: false },
      { from: "f2", to: "g2", kind: "call", count: 3, candidate: true },
      { from: "f1", to: "f2", kind: "call", count: 1, candidate: false },
      { from: "C2", to: "g1", kind: "spawn", count: 1, candidate: false },
    ]);
  });

  it("keeps lock and channel sync edges apart, with their how, and sums the same how", () => {
    const syncScene: Scene = {
      ...exec,
      edges: [
        { from: "f1", to: "g1", kind: "sync", how: "lock", count: 1 },
        { from: "f2", to: "g2", kind: "sync", how: "lock", count: 1 },
        { from: "f1", to: "g2", kind: "sync", how: "channel", count: 1 },
      ],
    };
    expect(sceneEdges(syncScene, new Set())).toEqual([
      { from: "T1", to: "T2", kind: "sync", how: "lock", count: 2, candidate: false },
      { from: "T1", to: "T2", kind: "sync", how: "channel", count: 1, candidate: false },
    ]);
  });

  it("lands each edge in the container of its ends' deepest common ancestor", () => {
    expect(sceneEdgeContainer(exec, { from: "f1", to: "g1" })).toEqual({ container: "P", a: "T1", b: "T2" });
    expect(sceneEdgeContainer(exec, { from: "f1", to: "f3" })).toEqual({ container: "T1", a: "C1", b: "C2" });
    expect(sceneEdgeContainer(exec, { from: "f1", to: "f2" })).toEqual({ container: "C1", a: "f1", b: "f2" });
    // An end under the other, a self-edge, or an unknown end lands nowhere.
    expect(sceneEdgeContainer(exec, { from: "T1", to: "f1" })).toBeUndefined();
    expect(sceneEdgeContainer(exec, { from: "f1", to: "T1" })).toBeUndefined();
    expect(sceneEdgeContainer(exec, { from: "f1", to: "f1" })).toBeUndefined();
    expect(sceneEdgeContainer(exec, { from: "f1", to: "nope" })).toBeUndefined();
  });

  it("builds each container's graph from its children and the edges that land in it", () => {
    const p = sceneLayoutGraph(exec, "P", new Map([["T1", { w: 900, h: 200 }]]));
    expect(p.children).toEqual([
      { id: "T1", width: 900, height: 200 },
      { id: "T2", width: 260, height: 60 },
    ]);
    expect(p.edges).toEqual([{ id: "e0", sources: ["T1"], targets: ["T2"] }]);
    expect(p.layoutOptions).toEqual(LAYERED);
    const t2 = sceneLayoutGraph(exec, "T2", new Map());
    // A kind with no level falls back to the function box.
    expect(t2.children).toEqual([
      { id: "C3", width: 240, height: 50 },
      { id: "g3", width: ZOOM_SIZE.fn.w, height: ZOOM_SIZE.fn.h },
    ]);
    expect(t2.edges).toEqual([]);
    expect(sceneLayoutGraph(exec, "C1", new Map()).edges).toEqual([{ id: "e0", sources: ["f1"], targets: ["f2"] }]);
    expect(sceneLayoutGraph(exec, "f1", new Map())).toMatchObject({ children: [], edges: [] });
  });

  it("orders the containers children first", () => {
    expect(sceneContainers(exec)).toEqual(["C1", "C2", "T1", "C3", "T2", "P"]);
  });
});

describe("layoutScene", () => {
  it("lays every container out with elkjs, open children at their frame size", async () => {
    const layout = await layoutScene(exec, solveElk);
    expect(Object.keys(layout.containers).sort()).toEqual(["C1", "C2", "C3", "P", "T1", "T2"]);
    expect(layoutCovers(exec, layout)).toBe(true);
    for (const id of sceneContainers(exec)) {
      const own = layout.containers[id];
      expect(own).toBeDefined();
      for (const s of own?.slots ?? []) {
        const child = layout.containers[s.id];
        const want = child ? frameSize({ w: child.w, h: child.h }) : (LEVELS[exec.nodes.get(s.id)?.kind ?? ""]?.box ?? ZOOM_SIZE.fn);
        expect({ w: s.w, h: s.h }).toEqual(want);
        expect(sceneNodeSize(exec, s.id, layout)).toEqual(want);
      }
      for (const [i, a] of (own?.slots ?? []).entries()) for (const b of own?.slots.slice(i + 1) ?? []) expect(overlaps(a, b)).toBe(false);
    }
  });

  it("a saved layout from before a chart was sized does not cover the scene", async () => {
    const saved = await layoutScene(exec, solveElk);
    const next: Scene = { ...exec, nodes: new Map(exec.nodes) };
    const f1 = exec.nodes.get("f1");
    if (f1 === undefined) throw new Error("no f1");
    next.nodes.set("f1", { ...f1, chart: { w: 500, h: 400 }, compact: { w: 120, h: 36 } });
    expect(layoutCovers(next, saved)).toBe(false);
    // Laid out again with the chart open, the box is the chart's size and the layout covers.
    const open = new Set(["f1"]);
    expect(layoutCovers(next, saved, open)).toBe(false);
    const fresh = await layoutScene(next, solveElk, { expanded: open });
    expect(layoutCovers(next, fresh, open)).toBe(true);
    const slot = fresh.containers.C1?.slots.find((s) => s.id === "f1");
    expect(slot?.w).toBeGreaterThanOrEqual(500);
    expect(slot?.h).toBeGreaterThanOrEqual(400);
  });

  it("gives the same layout twice", async () => {
    const a = await layoutScene(exec, solveElk);
    const b = await layoutScene(exec, solveElk);
    expect(b).toEqual(a);
  });

  it("a closed coroutine is a compact box, and its subtree is not laid out", async () => {
    const open = new Set(["P", "T1", "T2"]);
    const layout = await layoutScene(exec, solveElk, { open });
    expect(Object.keys(layout.containers).sort()).toEqual(["P", "T1", "T2"]);
    expect(layoutCovers(exec, layout, undefined, open)).toBe(true);
    const slot = layout.containers.T1?.slots.find((s) => s.id === "C1");
    const label = exec.nodes.get("C1")?.label ?? "";
    expect(slot).toMatchObject({ w: Math.max(110, 8 * label.length + 40), h: 40 });
    expect(sceneClosedSize(exec, "C1")).toEqual({ w: slot?.w, h: 40 });
    // The children of a closed coroutine have no slot anywhere.
    for (const c of layout.containers.T1?.slots ?? []) expect(["f1", "f2"]).not.toContain(c.id);
  });

  it("an open coroutine is laid out at its children's size", async () => {
    const closed = await layoutScene(exec, solveElk, { open: new Set(["P", "T1", "T2"]) });
    const open = new Set(["P", "T1", "T2", "C1"]);
    const layout = await layoutScene(exec, solveElk, { open });
    expect(layout.containers.C1).toBeDefined();
    expect(layoutCovers(exec, layout, undefined, open)).toBe(true);
    const slot = layout.containers.T1?.slots.find((s) => s.id === "C1");
    const own = layout.containers.C1;
    expect(own).toBeDefined();
    expect({ w: slot?.w, h: slot?.h }).toEqual(frameSize({ w: own?.w ?? 0, h: own?.h ?? 0 }));
    expect(own?.h).toBeGreaterThan(40);
    expect(closed.containers.T1?.slots.find((s) => s.id === "C1")).toMatchObject({ h: 40 });
  });

  it("opening a closed container over the default layout matches a fresh layout", async () => {
    const base = await layoutScene(exec, solveElk, { open: new Set(["P", "T1", "T2"]) });
    const open = new Set(["P", "T1", "T2", "C1"]);
    const reused = await layoutScene(exec, solveElk, { open, reuse: { from: base, changed: ["C1"] } });
    const fresh = await layoutScene(exec, solveElk, { open });
    expect(reused).toEqual(fresh);
  });

  it("gives the same layout with a set of open containers twice", async () => {
    const open = new Set(["P", "T1", "T2", "C1"]);
    const a = await layoutScene(exec, solveElk, { open });
    const b = await layoutScene(exec, solveElk, { open });
    expect(b).toEqual(a);
  });

  it("works with any solver, and the frame sizes add up", async () => {
    const layout = await layoutScene(exec, gridSolver());
    expect(layoutCovers(exec, layout)).toBe(true);
    expect(layout.containers.C1).toEqual({
      w: 470,
      h: 44,
      slots: [
        { id: "f1", x: 0, y: 0, w: 230, h: 44 },
        { id: "f2", x: 240, y: 0, w: 230, h: 44 },
      ],
    });
    // C1's frame is 502 x 90 and C2's is 262 x 90, side by side in cells 512 wide.
    expect(layout.containers.T1).toEqual({
      w: 774,
      h: 90,
      slots: [
        { id: "C1", x: 0, y: 0, w: 502, h: 90 },
        { id: "C2", x: 512, y: 0, w: 262, h: 90 },
      ],
    });
    expect(layout.containers.P).toMatchObject({ w: 816 + 774, h: 136 });
  });

  it("reports a layout that misses a container or a slot", async () => {
    const layout = await layoutScene(exec, gridSolver());
    const { C2: _gone, ...rest } = layout.containers;
    expect(layoutCovers(exec, { containers: rest })).toBe(false);
    const c1 = layout.containers.C1;
    expect(c1).toBeDefined();
    if (c1) expect(layoutCovers(exec, { containers: { ...layout.containers, C1: { ...c1, slots: c1.slots.slice(1) } } })).toBe(false);
  });

  it("lays a rectpacking level out with no overlapping slots", async () => {
    const spec: Record<string, { kind: string; parent?: string }> = { G: { kind: "group" } };
    for (let i = 0; i < 6; i += 1) spec[`n${i}`] = { kind: "function", parent: "G" };
    const groups = makeScene(spec, [], { group: { box: { w: 300, h: 80 }, layout: { "elk.algorithm": "rectpacking" } }, function: LEVELS.function ?? { box: ZOOM_SIZE.fn } }, "G");
    expect(sceneLayoutGraph(groups, "G", new Map()).layoutOptions).toEqual({ "elk.algorithm": "rectpacking" });
    const layout = await layoutScene(groups, solveElk);
    expect(layoutCovers(groups, layout)).toBe(true);
    const slots = layout.containers.G?.slots ?? [];
    expect(slots).toHaveLength(6);
    for (const [i, a] of slots.entries()) for (const b of slots.slice(i + 1)) expect(overlaps(a, b)).toBe(false);
  });
});

describe("placeSceneLayout", () => {
  it("places frames and boxes at exact positions from the layout", async () => {
    const layout = await layoutScene(exec, gridSolver());
    const placed = placeSceneLayout(exec, layout, new Set(["T1", "C1", "T2"]), { x: 100, y: 50 });
    expect(placed.width).toBe(1590);
    expect(placed.height).toBe(136);
    expect(placed.rects.get("P")).toEqual({ x: 100, y: 50, w: 1590, h: 136 });
    const byId = new Map(placed.items.map((i) => [i.id, i]));
    expect(byId.get("T1")).toEqual({ id: "T1", kind: "frame", rect: { x: 100, y: 50, w: 806, h: 136 }, inner: { x: 116, y: 80, w: 774, h: 90 }, depth: 1 });
    expect(byId.get("C1")).toMatchObject({ kind: "frame", rect: { x: 116, y: 80, w: 502, h: 90 }, depth: 2 });
    expect(byId.get("f1")).toEqual({ id: "f1", kind: "box", rect: { x: 132, y: 110, w: 230, h: 44 }, depth: 3 });
    expect(byId.get("f2")?.rect).toEqual({ x: 372, y: 110, w: 230, h: 44 });
    expect(byId.get("C2")).toMatchObject({ kind: "box", rect: { x: 628, y: 80, w: 262, h: 90 } });
    expect(byId.get("T2")).toMatchObject({ kind: "frame", rect: { x: 916, y: 50, w: 774, h: 136 } });
    // C3 is closed, so it is a box at its full frame size and its functions are not placed.
    expect(byId.get("C3")).toMatchObject({ kind: "box", rect: { x: 932, y: 80, w: 502, h: 90 } });
    expect(byId.get("g3")?.rect).toEqual({ x: 1444, y: 80, w: 230, h: 44 });
    expect(byId.has("g1")).toBe(false);
    expect(byId.has("P")).toBe(false);
  });

  it("does not move anything when a node opens or closes", async () => {
    const layout = await layoutScene(exec, solveElk);
    const sets = [new Set<string>(), new Set(["T1"]), new Set(["T1", "C1"]), new Set(["T1", "C1", "T2", "C3"]), new Set(["T2", "C3"])];
    const all = sets.map((s) => placeSceneLayout(exec, layout, s));
    for (const p of all) {
      expect(p.width).toBe(all[0]?.width);
      expect(p.height).toBe(all[0]?.height);
      for (const q of all) {
        for (const [id, r] of p.rects) if (q.rects.has(id)) expect(q.rects.get(id)).toEqual(r);
      }
    }
    // T1 sits in the same place whether it is open or closed, and f1 whether T2 is open or closed.
    expect(all[1]?.rects.get("T1")).toEqual(all[0]?.rects.get("T1"));
    expect(all[3]?.rects.get("f1")).toEqual(all[2]?.rects.get("f1"));
  });

  it("leaves the children of closed nodes out, puts frames before their children, and includes the root's rect", async () => {
    const layout = await layoutScene(exec, solveElk);
    const placed = placeSceneLayout(exec, layout, new Set(["T1"]));
    expect(placed.items.map((i) => i.id)).toEqual(["T1", "C1", "C2", "T2"]);
    expect(placed.items.map((i) => i.kind)).toEqual(["frame", "box", "box", "box"]);
    expect([...placed.rects.keys()].sort()).toEqual(["C1", "C2", "P", "T1", "T2"]);
    expect(placed.rects.get("P")).toEqual({ x: 0, y: 0, w: layout.containers.P?.w, h: layout.containers.P?.h });

    const deep = placeSceneLayout(exec, layout, new Set(["T1", "C1", "C2", "T2", "C3"]));
    const index = new Map(deep.items.map((it, i) => [it.id, i]));
    for (const it of deep.items) {
      const parent = exec.nodes.get(it.id)?.parent;
      if (parent !== undefined && parent !== exec.root) expect(index.get(parent) ?? Infinity).toBeLessThan(index.get(it.id) ?? -1);
    }
    expect(deep.items.filter((i) => i.kind === "frame").map((i) => i.id)).toEqual(["T1", "C1", "C2", "T2", "C3"]);
    // An open leaf, or an open node with no layout, is still a box.
    const leaf = placeSceneLayout(exec, layout, new Set(["T2", "g3"]));
    expect(leaf.items.find((i) => i.id === "g3")?.kind).toBe("box");
    expect(placeSceneLayout(exec, { containers: {} }, new Set())).toEqual({ items: [], rects: new Map(), width: 0, height: 0 });
  });

  it("finds the deepest box under a point", async () => {
    const layout = await layoutScene(exec, solveElk);
    const placed = placeSceneLayout(exec, layout, new Set(["T1", "C1"]));
    const boxes = placed.items.map((i) => ({ id: i.id, ...i.rect }));
    const f1 = placed.rects.get("f1");
    const c2 = placed.rects.get("C2");
    expect(f1 && c2).toBeTruthy();
    if (!f1 || !c2) return;
    expect(sceneFocusAt(exec, boxes, f1.x + f1.w / 2, f1.y + f1.h / 2)).toBe("f1");
    expect(sceneFocusAt(exec, boxes, c2.x + c2.w / 2, c2.y + c2.h / 2)).toBe("C2");
    expect(sceneFocusAt(exec, boxes, -10, -10)).toBeUndefined();
  });

  it("places the edges between the visible boxes", async () => {
    const layout = await layoutScene(exec, solveElk);
    const open = new Set(["T1", "C1", "T2", "C3"]);
    const placed = placeSceneLayout(exec, layout, open);
    const edges = placeSceneEdges(exec, open, placed.rects);
    expect(edges.map((e) => [e.from, e.to, e.kind, e.count])).toEqual([
      ["f1", "g1", "call", 2],
      ["f2", "g2", "call", 3],
      ["f1", "f2", "call", 1],
      ["C2", "g1", "spawn", 1],
    ]);
    for (const e of edges) {
      expect(e.stub).toBe(false);
      expect(e.stubCount).toBe(0);
      const a = placed.rects.get(e.from);
      const b = placed.rects.get(e.to);
      if (a && b) expect(e.d).toBe(edgeCurve(a, b));
    }
    // An end with no rectangle is skipped.
    const partial = new Map(placed.rects);
    partial.delete("g1");
    expect(placeSceneEdges(exec, open, partial).map((e) => e.to)).toEqual(["g2", "f2"]);
  });
});

// The layered algorithm grows much faster than linearly: one thread of 600 functions with about 1200 random calls
// took about 7 s, and 1500 with about 3000 calls 24 to 26 s, under Node 22. Past LAYERED_MAX_CHILDREN a container is
// packed instead, so a scene that did not group its children still lays out quickly.
describe("a large scene", () => {
  it("packs a container past LAYERED_MAX_CHILDREN, and lays 1500 functions with 3000 calls out quickly", async () => {
    const LEAVES = 1500;
    const spec: Record<string, { kind: string; parent?: string }> = { P: { kind: "program" }, T: { kind: "thread", parent: "P" } };
    for (let i = 0; i < LEAVES; i += 1) spec[`f${i}`] = { kind: "function", parent: "T" };
    // A fixed linear congruential generator, so the graph is the same on every run.
    let seed = 12345;
    const next = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed;
    };
    const edges: SceneEdge[] = [];
    for (let i = 0; i < 2 * LEAVES; i += 1) {
      const a = next() % LEAVES;
      const b = next() % LEAVES;
      if (a !== b) edges.push({ from: `f${a}`, to: `f${b}`, kind: "call", count: 1 });
    }
    const big = makeScene(spec, edges, LEVELS, "P");
    expect(sceneLayoutOptions(big, "T")).toBe(COLUMNS);
    expect(sceneLayoutOptions(big, "P")["elk.algorithm"]).toBe("layered");
    const t0 = performance.now();
    const layout = await layoutScene(big, solveElk);
    const ms = performance.now() - t0;
    console.log(`scene-layout: ${LEAVES} leaves, ${edges.length} edges laid out in ${ms.toFixed(0)} ms`);
    expect(layoutCovers(big, layout)).toBe(true);
    expect(layout.containers.T?.slots).toHaveLength(LEAVES);
    expect(ms).toBeLessThan(5_000);
  }, 15_000);

  it("keeps the layered algorithm at LAYERED_MAX_CHILDREN children, and a level's own non-layered layout past it", () => {
    const spec: Record<string, { kind: string; parent?: string }> = { P: { kind: "program" }, T: { kind: "thread", parent: "P" }, G: { kind: "group", parent: "P" } };
    for (let i = 0; i < LAYERED_MAX_CHILDREN; i += 1) spec[`t${i}`] = { kind: "function", parent: "T" };
    for (let i = 0; i < LAYERED_MAX_CHILDREN + 1; i += 1) spec[`g${i}`] = { kind: "function", parent: "G" };
    const own = { "elk.algorithm": "box" };
    const s = makeScene(spec, [], { ...LEVELS, group: { box: { w: 100, h: 40 }, layout: own } }, "P");
    expect(sceneLayoutOptions(s, "T")["elk.algorithm"]).toBe("layered");
    expect(sceneLayoutOptions(s, "G")).toBe(own);
  });
});

describe("callColumns", () => {
  it("puts each callee in a column right of its caller, and places every child without overlap", () => {
    const graph: LayoutGraph = {
      id: "G",
      layoutOptions: { "elk.algorithm": "insight.columns", "elk.spacing.nodeNode": "24" },
      children: ["a", "b", "c", "d"].map((id) => ({ id, width: 100, height: 50 })),
      edges: [
        { id: "e0", sources: ["a"], targets: ["b"] },
        { id: "e1", sources: ["b"], targets: ["c"] },
      ],
    };
    const solved = callColumns(graph);
    const at = new Map((solved.children ?? []).map((c) => [c.id, c]));
    expect([...at.keys()].sort()).toEqual(["a", "b", "c", "d"]);
    expect(at.get("a")?.x).toBeLessThan(at.get("b")?.x ?? 0);
    expect(at.get("b")?.x).toBeLessThan(at.get("c")?.x ?? 0);
    // d is called by nothing and calls nothing: a source, so it shares column 0 with a.
    expect(at.get("d")?.x).toBe(at.get("a")?.x);
    const rects = graph.children.map((c) => ({ ...c, x: at.get(c.id)?.x ?? 0, y: at.get(c.id)?.y ?? 0 }));
    for (let i = 0; i < rects.length; i += 1) {
      for (let j = i + 1; j < rects.length; j += 1) expect(overlaps(rects[i]!, rects[j]!)).toBe(false);
    }
  });
});

describe("packRows", () => {
  // The chart heights of the function boxes in the group of packages/flow/test/zoom-layout.test.ts's scope, which ELK's rectpacking never returned for.
  const HEIGHTS = [82, 82, 82, 442, 142, 82, 622, 82, 502, 82, 142, 450, 82, 202, 82, 82, 82, 322, 442, 82, 502, 142, 502, 382, 262, 82, 142, 82, 202, 82, 142, 82, 202, 202, 82, 262, 142];
  const graphOfSizes = (sizes: { w: number; h: number }[]): LayoutGraph => ({
    id: "G",
    layoutOptions: { "elk.algorithm": "rectpacking", "elk.spacing.nodeNode": "24" },
    children: sizes.map((s, i) => ({ id: `c${i}`, width: s.w, height: s.h })),
    edges: [],
  });

  it("places every child without overlap, in order, and returns at once for the mix ELK's rectpacking hung on", () => {
    const sizes = HEIGHTS.map((h, i) => ({ w: i === 11 ? 316 : 236, h }));
    const graph = graphOfSizes(sizes);
    const t0 = performance.now();
    const solved = packRows(graph);
    expect(performance.now() - t0).toBeLessThan(100);
    const rects = (solved.children ?? []).map((c, i) => ({ id: c.id, x: c.x ?? 0, y: c.y ?? 0, w: sizes[i]!.w, h: sizes[i]!.h }));
    expect(rects.map((r) => r.id)).toEqual(graph.children.map((c) => c.id));
    for (let i = 0; i < rects.length; i += 1) {
      for (let j = i + 1; j < rects.length; j += 1) expect(overlaps(rects[i]!, rects[j]!)).toBe(false);
    }
    const right = Math.max(...rects.map((r) => r.x + r.w));
    const bottom = Math.max(...rects.map((r) => r.y + r.h));
    expect(solved.width).toBe(right);
    expect(solved.height).toBe(bottom);
    // Rows of mixed heights waste some height, so the block comes out squarer than the 1.5 it aims for.
    expect(right / bottom).toBeGreaterThan(0.5);
    expect(right / bottom).toBeLessThan(3);
  });

  it("is deterministic, handles no children, and keeps a child wider than the row on its own row", () => {
    const sizes = [{ w: 200, h: 50 }, { w: 5000, h: 50 }, { w: 200, h: 50 }];
    expect(packRows(graphOfSizes(sizes))).toEqual(packRows(graphOfSizes(sizes)));
    expect(packRows(graphOfSizes([]))).toEqual({ width: 0, height: 0, children: [] });
    const wide = packRows(graphOfSizes(sizes));
    expect(wide.children?.map((c) => c.x)).toEqual([0, 0, 0]);
    expect(wide.width).toBe(5000);
  });

  it("is used for a rectpacking container, whose solve is never asked for", async () => {
    const spec: Record<string, { kind: string; parent?: string }> = { P: { kind: "program" }, G: { kind: "group", parent: "P" } };
    for (let i = 0; i < 6; i += 1) spec[`f${i}`] = { kind: "function", parent: "G" };
    const levels = { ...LEVELS, group: { box: { w: 100, h: 40 }, layout: { "elk.algorithm": "rectpacking", "elk.spacing.nodeNode": "24" } } };
    const scene = makeScene(spec, [], levels, "P");
    for (let i = 0; i < 6; i += 1) scene.nodes.get(`f${i}`)!.chart = { w: 236, h: 82 + 60 * i };
    const asked: string[] = [];
    const layout = await layoutScene(scene, (g) => {
      asked.push(g.id);
      return gridSolver()(g);
    });
    expect(asked).toEqual(["P"]);
    expect(layout.containers.G?.slots).toHaveLength(6);
    expect(layoutCovers(scene, layout)).toBe(true);
  });
});

// --- Collapsed and expanded function charts: a chart box is compact until it is expanded ---

describe("collapsed and expanded charts", () => {
  /** The exec fixture with every function holding a chart: collapsed boxes are 120 x 36, expanded ones hold 400 x 300. */
  const charted = (): Scene => {
    const scene: Scene = { ...exec, nodes: new Map(exec.nodes) };
    for (const id of ["f1", "f2", "f3", "g1", "g2"]) {
      const n = exec.nodes.get(id);
      if (n === undefined) throw new Error(`no ${id}`);
      scene.nodes.set(id, { ...n, chart: { w: 400, h: 300 }, compact: { w: 120, h: 36 } });
    }
    return scene;
  };

  it("a collapsed chart box is compact, and an expanded one holds its chart", async () => {
    const scene = charted();
    const open = new Set(["f1"]);
    const collapsed = await layoutScene(scene, solveElk);
    expect(layoutCovers(scene, collapsed)).toBe(true);
    expect(collapsed.containers.C1?.slots.find((s) => s.id === "f1")).toMatchObject({ w: 120, h: 36 });
    // The collapsed layout does not cover an expanded set: the chart needs its own slot.
    expect(layoutCovers(scene, collapsed, open)).toBe(false);
    const expanded = await layoutScene(scene, solveElk, { expanded: open });
    expect(layoutCovers(scene, expanded, open)).toBe(true);
    // The chart plus its padding, and the header above it: 400 + 2 * 12 by 28 + 300 + 2 * 12.
    expect(expanded.containers.C1?.slots.find((s) => s.id === "f1")).toMatchObject({ w: 424, h: 352 });
  });

  it("reusing the collapsed layout gives the layout from scratch, and solves only the path above the open charts", async () => {
    const scene = charted();
    const open = new Set(["f1"]);
    const base = await layoutScene(scene, gridSolver());
    let fromScratch = 0;
    const fresh = await layoutScene(scene, (g) => {
      fromScratch += 1;
      return gridSolver()(g);
    }, { expanded: open });
    let reusing = 0;
    const reused = await layoutScene(scene, (g) => {
      reusing += 1;
      return gridSolver()(g);
    }, { expanded: open, reuse: { from: base, changed: [...open] } });
    expect(reused).toEqual(fresh);
    expect(reusing).toBeLessThan(fromScratch);
    // f1 sits in C1, under T1 and P: those three are solved again. C2, C3 and T2 are reused as they are.
    expect(reusing).toBe(3);
  });

  it("a 300-child container is laid out in call columns, without the solver, in under 200 ms", async () => {
    const spec: Record<string, { kind: string; parent?: string }> = { P: { kind: "program" } };
    const edges: SceneEdge[] = [];
    for (let i = 0; i < 300; i += 1) spec[`c${i}`] = { kind: "function", parent: "P" };
    for (let i = 1; i < 300; i += 1) edges.push({ from: `c${i - 1}`, to: `c${i}`, kind: "call", count: 1 });
    const scene = makeScene(spec, edges, LEVELS, "P");
    for (let i = 0; i < 300; i += 1) {
      const n = scene.nodes.get(`c${i}`);
      if (n !== undefined) {
        n.chart = { w: 300, h: 200 };
        n.compact = { w: 120, h: 36 };
      }
    }
    const noSolver: SceneSolver = () => {
      throw new Error("the solver was asked for a container that is laid out in columns");
    };
    const t0 = performance.now();
    const layout = await layoutScene(scene, noSolver);
    expect(performance.now() - t0).toBeLessThan(200);
    expect(layoutCovers(scene, layout)).toBe(true);
  });
});
