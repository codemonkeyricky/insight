import { describe, expect, it } from "vitest";
import {
  CHART_HEAD,
  CHART_PAD,
  EXEC_LEVELS,
  NO_RUNTIME_NOTE,
  EXEC_PROJECT_ROOT,
  layoutScene,
  type ExecFunctionRef,
  type LayoutGraph,
  type Scene,
  type SceneNode,
  type SolvedGraph,
} from "@insight/flow";
import { execBuild, execFocus, execMapNode, execOpenSet, execResolve, execSelected, execUrl, splitExecFocus } from "../src/zoom/execMap.js";
import { chartOrigin } from "../src/components/zoom/BoxChart.js";
import { deepestAt, edgeClass, edgeKey, edgeTitle, edgeWidth } from "../src/zoom/source.js";

describe("deepestAt", () => {
  const depths: Record<string, number> = { a: 1, b: 2, c: 2 };
  const depth = (id: string) => depths[id] ?? -1;
  const boxes = [
    { id: "a", x: 0, y: 0, w: 100, h: 100 },
    { id: "b", x: 10, y: 10, w: 50, h: 50 },
    { id: "c", x: 10, y: 10, w: 20, h: 20 },
  ];

  it("picks the deepest box under the point, and the smaller of two at one depth", () => {
    expect(deepestAt(boxes, depth, 15, 15)).toBe("c");
    expect(deepestAt(boxes, depth, 40, 40)).toBe("b");
    expect(deepestAt(boxes, depth, 90, 90)).toBe("a");
  });

  it("answers undefined off every box", () => {
    expect(deepestAt(boxes, depth, 200, 5)).toBeUndefined();
    expect(deepestAt([], depth, 0, 0)).toBeUndefined();
  });
});

describe("edges", () => {
  const base = { from: "a", to: "b", count: 1, stubCount: 0, stub: false, candidate: false, d: "" };

  it("keeps the call classes and marks spawns and dispatches by kind", () => {
    expect(edgeClass(base)).toBe("zm-edge");
    expect(edgeClass({ ...base, stub: true })).toBe("zm-edge stub");
    expect(edgeClass({ ...base, candidate: true })).toBe("zm-edge candidate");
    expect(edgeClass({ ...base, kind: "sync", how: "lock" })).toBe("zm-edge sync lock");
    expect(edgeClass({ ...base, kind: "sync", how: "channel" })).toBe("zm-edge sync channel");
    expect(edgeTitle({ stub: false, count: 2, stubCount: 0, kind: "sync", how: "lock" })).toBe("2 locks both take");
    expect(edgeKey({ from: "a", to: "b", kind: "sync", how: "lock" })).not.toBe(edgeKey({ from: "a", to: "b", kind: "sync", how: "channel" }));
    expect(edgeClass({ ...base, kind: "call" })).toBe("zm-edge");
    expect(edgeClass({ ...base, kind: "spawn" })).toBe("zm-edge spawn");
    expect(edgeClass({ ...base, kind: "dispatch", candidate: true })).toBe("zm-edge candidate dispatch");
  });

  it("titles, widths and keys", () => {
    expect(edgeTitle({ ...base, count: 3 })).toBe("3 calls");
    expect(edgeTitle({ ...base, count: 3, stub: true, stubCount: 2 })).toBe("3 calls, 2 leave the scope");
    expect(edgeTitle({ ...base, kind: "dispatch", count: 2 })).toBe("2 dispatches");
    expect(edgeWidth({ count: 1 })).toBe(1);
    expect(edgeWidth({ count: 1000 })).toBe(4);
    expect(edgeWidth({ count: 1, kind: "spawn" })).toBe(2);
    expect(edgeKey({ from: "a", to: "b", kind: "call" })).not.toBe(edgeKey({ from: "a", to: "b", kind: "dispatch" }));
  });
});

describe("exec map", () => {
  const n = (id: string, kind: string, parent: string | undefined, extra: Partial<SceneNode> = {}): SceneNode => ({
    id,
    kind,
    label: id,
    children: [],
    ...(parent !== undefined ? { parent } : {}),
    ...extra,
  });
  const list = [
    n("program", "program", undefined, { detail: "2 threads" }),
    n("thread:main", "thread", "program", { label: "Main thread", detail: "2 functions" }),
    n("thread:w", "thread", "program", { label: "Thread · work" }),
    n("thread:main>a#run", "function", "thread:main", { label: "run", ref: "a#run" }),
    n("thread:main>a#help", "function", "thread:main", { label: "help", ref: "a#help", note: "A helper." }),
    n("thread:w>a#help", "function", "thread:w", { label: "help", ref: "a#help" }),
  ];
  const nodes = new Map(list.map((x) => [x.id, x]));
  for (const x of list) if (x.parent !== undefined) nodes.get(x.parent)?.children.push(x.id);
  const scene: Scene = {
    root: "program",
    nodes,
    edges: [
      { from: "thread:main>a#run", to: "thread:main>a#help", kind: "call", count: 1 },
      { from: "thread:main>a#run", to: "thread:w", kind: "spawn", count: 1, how: "thread" },
    ],
    levels: EXEC_LEVELS,
  };
  // Stacks the children in a column, 10 apart.
  const column = async (g: LayoutGraph): Promise<SolvedGraph> => {
    let y = 0;
    const children = g.children.map((c) => {
      const out = { id: c.id, x: 0, y };
      y += c.height + 10;
      return out;
    });
    return { children };
  };

  it("maps scene nodes, with the note as the tooltip and no file bands", () => {
    expect(execMapNode(scene, "thread:main")).toEqual({ id: "thread:main", kind: "thread", label: "Main thread", title: "Main thread", detail: "2 functions", parent: "program" });
    expect(execMapNode(scene, "thread:main>a#help")?.title).toBe("A helper.");
    expect(execMapNode(scene, "program")?.parent).toBeUndefined();
    expect(execMapNode(scene, "nope")).toBeUndefined();
  });

  it("carries a function's id and chart size to the box, and no chart to a box without one", () => {
    const withChart: Scene = { ...scene, nodes: new Map(scene.nodes) };
    const id = "thread:main>a#help";
    const helper = scene.nodes.get(id);
    if (helper === undefined) throw new Error("no helper");
    withChart.nodes.set(id, { ...helper, chart: { w: 300, h: 200 } });
    expect(execMapNode(withChart, id)).toMatchObject({ kind: "function", ref: helper.ref, chart: { w: 300, h: 200 } });
    expect(execMapNode(scene, id)?.chart).toBeUndefined();
    expect(execMapNode(withChart, "thread:main")?.chart).toBeUndefined();
  });

  it("puts a chart under the name's header, centred across a wider box", () => {
    const rect = { x: 100, y: 50, w: 400, h: 300 };
    expect(chartOrigin(rect, { w: 200, h: 100 })).toEqual({ x: 200, y: 50 + CHART_HEAD + CHART_PAD });
    // A chart as wide as the box minus its padding sits at the padding.
    expect(chartOrigin({ x: 0, y: 0, w: 224, h: 200 }, { w: 200, h: 100 })).toEqual({ x: 12, y: CHART_HEAD + CHART_PAD });
  });

  it("resolves a function to its first placement, else the root", () => {
    expect(execResolve(scene, "a#help")).toBe("thread:main>a#help");
    expect(execResolve(scene, "a#run")).toBe("thread:main>a#run");
    expect(execResolve(scene, "missing")).toBe("program");
    expect(execResolve(scene)).toBe("program");
  });

  it("writes the scope, and the function for a function focus", () => {
    expect(execUrl(scene, "src", "thread:w>a#help")).toEqual({ scope: "src", fn: "a#help" });
    expect(execUrl(scene, "src", "thread:w")).toEqual({ scope: "src" });
    expect(execUrl(scene, "src", "program")).toEqual({ scope: "src" });
    expect(execUrl(scene, "src", "nope")).toBeUndefined();
  });

  it("builds the map for a focus from one whole layout, named by its scope and node", async () => {
    const layout = await layoutScene(scene, column);
    // The project's own view is the first view: every thread box is open, so its functions are drawn.
    const top = execBuild(scene, layout, "src", "program");
    expect(top.path).toBe("src");
    expect(top.focus).toBe(execFocus("src", "program"));
    expect(top.nodeId).toBe("program");
    expect(top.selected).toBeUndefined();
    expect(top.placed.items.filter((i) => i.kind === "frame").map((i) => i.id).sort()).toEqual(["thread:main", "thread:w"]);
    expect(top.placed.items.filter((i) => i.kind === "box").map((i) => i.id).sort()).toEqual([
      "thread:main>a#help",
      "thread:main>a#run",
      "thread:w>a#help",
    ]);
    expect(top.crumbs.map((c) => c.id)).toEqual(["program"]);
    expect(top.depth("thread:w>a#help")).toBe(2);

    const deep = execBuild(scene, layout, "src", "thread:w>a#help");
    expect(deep.focus).toBe(execFocus("src", "thread:w>a#help"));
    expect(deep.placed.items.filter((i) => i.kind === "frame").map((i) => i.id)).toEqual(["thread:main", "thread:w"]);
    expect(deep.crumbs.map((c) => c.label)).toEqual(["program", "Thread · work", "help"]);
    // Every focus shares the layout, so a box sits in the same place open or closed.
    expect(deep.placed.rects.get("thread:w")).toEqual(top.placed.rects.get("thread:w"));
  });
});

describe("exec focus", () => {
  it("carries the scope and the node in one string, and splits them back", () => {
    const focus = execFocus("src/a b.py", "thread:w>a#help");
    expect(focus).toBe("src/a b.py\u0001thread:w>a#help");
    expect(splitExecFocus(focus)).toEqual({ scope: "src/a b.py", nodeId: "thread:w>a#help" });
  });

  it("keeps the project scope as the empty string", () => {
    expect(splitExecFocus(execFocus("", "program"))).toEqual({ scope: "", nodeId: "program" });
  });

  it("reads a focus with no separator as a node of the project", () => {
    expect(splitExecFocus("program")).toEqual({ scope: "", nodeId: "program" });
  });

  it("splits at the first separator, so a node id that holds one stays whole", () => {
    expect(splitExecFocus(execFocus("src", "a\u0001b"))).toEqual({ scope: "src", nodeId: "a\u0001b" });
  });
});

describe("exec selected function", () => {
  const n = (id: string, kind: string, parent: string | undefined, extra: Partial<SceneNode> = {}): SceneNode => ({
    id,
    kind,
    label: id,
    children: [],
    ...(parent !== undefined ? { parent } : {}),
    ...extra,
  });
  // The nodes are listed in the order the scene builds them, so the placements come out in that order.
  const list = [
    n(EXEC_PROJECT_ROOT, "project", undefined, { label: "Project" }),
    n("thread:main", "thread", EXEC_PROJECT_ROOT, { label: "Main thread" }),
    n("thread:main>a#help", "function", "thread:main", { label: "help", ref: "a#help" }),
    n("co:main:c", "coroutine", "thread:main", { label: "step loop" }),
    n("co:main:c>a#help", "function", "co:main:c", { label: "help", ref: "a#help" }),
    n("co:main:c>c#step", "function", "co:main:c", { label: "step", ref: "c#step", note: "A step." }),
    n("thread:w", "thread", EXEC_PROJECT_ROOT, { label: "Thread · work" }),
    n("thread:w>a#help", "function", "thread:w", { label: "help", ref: "a#help" }),
    // A plain function, with no runtime box: it sits on the project.
    n(`${EXEC_PROJECT_ROOT}>f#plain`, "function", EXEC_PROJECT_ROOT, { label: "plain", ref: "f#plain", note: NO_RUNTIME_NOTE }),
  ];
  const nodes = new Map(list.map((x) => [x.id, x]));
  for (const x of list) if (x.parent !== undefined) nodes.get(x.parent)?.children.push(x.id);
  const scene: Scene = { root: EXEC_PROJECT_ROOT, nodes, edges: [], levels: EXEC_LEVELS };
  const fns = new Map<string, ExecFunctionRef>([
    ["a#help", { id: "a#help", name: "help", file: "src/a.py", line: 7, inScope: true, runtime: "thread" }],
    ["c#step", { id: "c#step", name: "step", file: "src/c.py", line: 3, inScope: true, runtime: "coroutine" }],
    ["f#plain", { id: "f#plain", name: "plain", file: "src/f.py", line: 9, inScope: true, runtime: "none" }],
  ]);
  const column = async (g: LayoutGraph): Promise<SolvedGraph> => ({ children: g.children.map((c, i) => ({ id: c.id, x: 0, y: i * 10 })) });

  it("says where a function in a thread runs, and lists its other places", () => {
    expect(execSelected(scene, fns, "thread:main>a#help")).toEqual({
      ref: "a#help",
      name: "help",
      file: "src/a.py",
      line: 7,
      runtime: "thread",
      thread: "Main thread",
      placements: [
        { nodeId: "co:main:c>a#help", label: "Main thread in coroutine step loop" },
        { nodeId: "thread:w>a#help", label: "Thread · work" },
      ],
    });
  });

  it("says the coroutine a function runs in, with its thread", () => {
    expect(execSelected(scene, fns, "co:main:c>c#step")).toEqual({
      ref: "c#step",
      name: "step",
      file: "src/c.py",
      line: 3,
      runtime: "coroutine",
      thread: "Main thread",
      coroutine: "step loop",
      note: "A step.",
      placements: [],
    });
  });

  it("says a plain function on the project runs nowhere, with the explanation", () => {
    const sel = execSelected(scene, fns, `${EXEC_PROJECT_ROOT}>f#plain`);
    expect(sel).toMatchObject({ runtime: "none", note: NO_RUNTIME_NOTE, placements: [] });
    expect(sel?.thread).toBeUndefined();
  });

  it("falls back to the node's label when the model does not list the function, and answers nothing for a non-function", () => {
    expect(execSelected(scene, new Map(), "thread:w>a#help")).toMatchObject({ name: "help", file: "", line: 0, runtime: "thread" });
    expect(execSelected(scene, fns, "thread:main")).toBeUndefined();
    expect(execSelected(scene, fns, "nope")).toBeUndefined();
  });

  it("puts the selected function on the build, when the model's functions are given", async () => {
    const layout = await layoutScene(scene, column);
    const build = execBuild(scene, layout, "src", "co:main:c>c#step", fns);
    expect(build.selected).toMatchObject({ ref: "c#step", runtime: "coroutine", coroutine: "step loop" });
    expect(build.crumbs.map((c) => c.label)).toEqual(["Project", "Main thread", "step loop", "step"]);
    expect(execBuild(scene, layout, "src", EXEC_PROJECT_ROOT, fns).selected).toBeUndefined();
  });
});

describe("exec first view", () => {
  // A project with two threads: the main thread holds a coroutine, and the project holds one plain function.
  const n = (id: string, kind: string, parent: string | undefined, extra: Partial<SceneNode> = {}): SceneNode => ({
    id,
    kind,
    label: id,
    children: [],
    ...(parent !== undefined ? { parent } : {}),
    ...extra,
  });
  const list = [
    n(EXEC_PROJECT_ROOT, "project", undefined, { label: "Project" }),
    n("prog:main", "program", EXEC_PROJECT_ROOT, { label: "Process · main" }),
    n("thread:main", "thread", "prog:main", { label: "Main thread" }),
    n("thread:main>a#help", "function", "thread:main", { label: "help", ref: "a#help" }),
    n("co:main:c", "coroutine", "thread:main", { label: "step loop" }),
    n("co:main:c>c#step", "function", "co:main:c", { label: "step", ref: "c#step" }),
    n(`${EXEC_PROJECT_ROOT}>f#plain`, "function", EXEC_PROJECT_ROOT, { label: "plain", ref: "f#plain" }),
  ];
  const nodes = new Map(list.map((x) => [x.id, x]));
  for (const x of list) if (x.parent !== undefined) nodes.get(x.parent)?.children.push(x.id);
  const scene: Scene = { root: EXEC_PROJECT_ROOT, nodes, edges: [], levels: EXEC_LEVELS };
  const column = async (g: LayoutGraph): Promise<SolvedGraph> => ({ children: g.children.map((c, i) => ({ id: c.id, x: 0, y: i * 10 })) });

  it("opens every process and thread box, and no coroutine", () => {
    expect([...execOpenSet(scene, new Set())].sort()).toEqual([EXEC_PROJECT_ROOT, "prog:main", "thread:main"].sort());
  });

  it("draws the process and thread frames on the project's view, with the coroutine as a closed box", async () => {
    const layout = await layoutScene(scene, column);
    const build = execBuild(scene, layout, "", EXEC_PROJECT_ROOT, new Map());
    expect(build.placed.items.filter((i) => i.kind === "frame").map((i) => i.id).sort()).toEqual(["prog:main", "thread:main"]);
    expect(build.placed.items.filter((i) => i.kind === "box").map((i) => i.id).sort()).toEqual(
      [`${EXEC_PROJECT_ROOT}>f#plain`, "co:main:c", "thread:main>a#help"].sort(),
    );
  });
});
