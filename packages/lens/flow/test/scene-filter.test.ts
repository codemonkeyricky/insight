import { describe, expect, it } from "vitest";
import type { ExecFunctionRef, ExecModel, ExecModelStats, ExecThread } from "../src/exec-model.js";
import { buildExecScene, execFnId, execThreadId } from "../src/exec-scene.js";
import { execRootsOnly, keepScene } from "../src/scene-filter.js";
import type { Scene, SceneNode } from "../src/scene.js";

const ZERO_STATS: ExecModelStats = {
  threads: 0,
  programs: 0,
  spawns: 0,
  resolved: 0,
  outside: 0,
  unresolved: 0,
  candidates: 0,
  coroutines: 0,
  dispatches: 0,
  functionsInScope: 0,
  functionsThreaded: 0,
  functionsCoroutineOnly: 0,
  functionsUnthreaded: 0,
  functionsListed: 0,
};

const fn = (id: string, line = 1, extra: Partial<ExecFunctionRef> = {}): ExecFunctionRef => ({
  id,
  name: id,
  file: "src/app.ts",
  line,
  inScope: true,
  runtime: "thread",
  ...extra,
});

/** A model from functions, threads and calls given by function id. */
function model(parts: {
  functions: ExecFunctionRef[];
  threads: ExecThread[];
  calls?: [string, string][];
  unthreaded?: string[];
}): ExecModel {
  const index = new Map(parts.functions.map((f, i) => [f.id, i]));
  const at = (id: string): number => {
    const i = index.get(id);
    if (i === undefined) throw new Error(`no function ${id}`);
    return i;
  };
  return {
    scope: "",
    truncated: false,
    functions: parts.functions,
    threads: parts.threads,
    dispatches: [],
    programs: [],
    calls: (parts.calls ?? []).map(([a, b]) => [at(a), at(b)] as [number, number]),
    unthreaded: parts.unthreaded ?? [],
    stats: ZERO_STATS,
  };
}

const mainThread = (t: Partial<ExecThread>): ExecThread => ({
  id: "main",
  kind: "main",
  grounded: true,
  roots: [],
  reach: t.reached?.length ?? 0,
  reached: [],
  coroutines: [],
  coroutineOnly: [],
  ...t,
});

const keysOf = (s: Scene) => [...s.nodes.keys()].sort();
const edgesOf = (s: Scene) => s.edges.map((e) => [e.from, e.to, e.kind]);

// main calls a and awaits co, which calls h. main spawns a thread that runs work. f runs on no thread.
const basic = (): ExecModel =>
  model({
    functions: [
      fn("main", 1),
      fn("a", 10),
      fn("co", 20, { runtime: "coroutine" }),
      fn("h", 30, { runtime: "coroutine" }),
      fn("work", 40),
      fn("f", 50, { runtime: "none" }),
    ],
    threads: [
      mainThread({
        roots: ["main"],
        reached: ["a", "co", "h", "main"],
        coroutineOnly: ["co", "h"],
        coroutines: [{ target: "co", how: "await", dispatchedBy: ["main"], callees: ["h"] }],
      }),
      {
        id: "spawn:1",
        kind: "thread",
        grounded: true,
        spawn: { node: "spawn:1", owner: "main", file: "src/app.ts", line: 5, how: "thread", status: "resolved", candidates: false },
        roots: ["work"],
        reach: 1,
        reached: ["work"],
        coroutines: [],
        coroutineOnly: [],
      },
    ],
    calls: [
      ["main", "a"],
      ["main", "co"],
      ["co", "h"],
    ],
    unthreaded: ["f"],
  });

describe("keepScene", () => {
  // root r has children a and b; a has a1; b has none. Calls: a1 -> b, a -> a1.
  const scene: Scene = {
    root: "r",
    nodes: new Map<string, SceneNode>([
      ["r", { id: "r", kind: "item", label: "root", children: ["a", "b"] }],
      ["a", { id: "a", kind: "item", label: "a", parent: "r", children: ["a1"] }],
      ["a1", { id: "a1", kind: "item", label: "a1", parent: "a", children: [], ref: "fn-a1", note: "kept note" }],
      ["b", { id: "b", kind: "item", label: "b", parent: "r", children: [] }],
    ]),
    edges: [
      { from: "a1", to: "b", kind: "call", count: 1 },
      { from: "a", to: "a1", kind: "call", count: 2 },
    ],
    levels: { item: { box: { w: 10, h: 10 } } },
  };

  it("keeps the nodes asked for, their ancestors and the root", () => {
    const out = keepScene(scene, new Set(["a1"]));
    expect(keysOf(out)).toEqual(["a", "a1", "r"]);
    expect(out.root).toBe("r");
    expect(out.levels).toBe(scene.levels);
  });

  it("filters the children of each kept node, in their order, and keeps a node's own fields", () => {
    const out = keepScene(scene, new Set(["b", "a1"]));
    expect(out.nodes.get("r")?.children).toEqual(["a", "b"]);
    expect(out.nodes.get("a")?.children).toEqual(["a1"]);
    expect(out.nodes.get("a1")).toEqual({ id: "a1", kind: "item", label: "a1", parent: "a", children: [], ref: "fn-a1", note: "kept note" });
    const one = keepScene(scene, new Set(["b"]));
    expect(one.nodes.get("r")?.children).toEqual(["b"]);
  });

  it("keeps an edge only when both of its ends are kept", () => {
    expect(edgesOf(keepScene(scene, new Set(["a1"])))).toEqual([["a", "a1", "call"]]);
    expect(edgesOf(keepScene(scene, new Set(["a1", "b"])))).toEqual([
      ["a1", "b", "call"],
      ["a", "a1", "call"],
    ]);
  });

  it("keeps only the root when nothing is asked for, and ignores ids the scene does not have", () => {
    const empty = keepScene(scene, new Set());
    expect(keysOf(empty)).toEqual(["r"]);
    expect(empty.nodes.get("r")?.children).toEqual([]);
    expect(empty.edges).toEqual([]);
    expect(keysOf(keepScene(scene, new Set(["nope"])))).toEqual(["r"]);
  });

  it("does not change the scene it is given", () => {
    keepScene(scene, new Set(["a1"]));
    expect(scene.nodes.get("r")?.children).toEqual(["a", "b"]);
    expect(scene.nodes.size).toBe(4);
    expect(scene.edges.length).toBe(2);
  });
});

describe("execRootsOnly", () => {
  it("keeps each thread and the placements of its roots, and drops coroutines and the non-root plain code flow", () => {
    const m = basic();
    const full = buildExecScene(m);
    // The full scene has the nodes the cut must remove.
    expect(full.nodes.has("co:main:co")).toBe(true);
    expect(full.nodes.has("project>f")).toBe(true);

    const out = execRootsOnly(full, m);
    // "project>f" runs on no thread and nothing calls it, so it is a root of the plain code flow and is kept.
    expect(keysOf(out)).toEqual(
      [
        full.root,
        "prog:main",
        execFnId(full.root, "f"),
        execThreadId("main"),
        execFnId(execThreadId("main"), "main"),
        execThreadId("spawn:1"),
        execFnId(execThreadId("spawn:1"), "work"),
      ].sort(),
    );
    expect(out.root).toBe(full.root);
    expect(out.nodes.get(execThreadId("main"))?.children).toEqual([execFnId(execThreadId("main"), "main")]);
  });

  it("keeps the spawn edge between kept ends and drops the call edges that leave the roots", () => {
    const m = basic();
    const out = execRootsOnly(buildExecScene(m), m);
    expect(edgesOf(out)).toEqual([[execFnId(execThreadId("main"), "main"), execThreadId("spawn:1"), "spawn"]]);
  });

  it("keeps a thread that starts no function the scene holds", () => {
    const m = model({
      functions: [fn("main", 1), fn("x", 2)],
      threads: [
        mainThread({ roots: ["main"], reached: ["main", "x"] }),
        { id: "spawn:2", kind: "thread", grounded: true, roots: [], reach: 0, reached: [], coroutines: [], coroutineOnly: [] },
      ],
    });
    const out = execRootsOnly(buildExecScene(m), m);
    expect(out.nodes.has(execThreadId("spawn:2"))).toBe(true);
    expect(out.nodes.get(execThreadId("spawn:2"))?.children).toEqual([]);
    expect(out.nodes.has(execFnId(execThreadId("main"), "x"))).toBe(false);
  });

  it("ignores a root the thread runs only in a coroutine, and a root the model does not list", () => {
    const m = model({
      functions: [fn("main", 1), fn("co", 2, { runtime: "coroutine" })],
      threads: [
        mainThread({
          roots: ["main", "co", "ghost"],
          reached: ["co", "main"],
          coroutineOnly: ["co"],
          coroutines: [{ target: "co", how: "await", dispatchedBy: ["main"], callees: [] }],
        }),
      ],
    });
    const full = buildExecScene(m);
    const out = execRootsOnly(full, m);
    expect(keysOf(out)).toEqual(["prog:main", full.root, execThreadId("main"), execFnId(execThreadId("main"), "main")].sort());
  });

  it("keeps the flat roots of plain code flow: an ungrounded thread's roots and the functions nothing calls", () => {
    // No thread is grounded: main (an inferred entry) calls helper, and lone is called by nothing.
    const m = model({
      functions: [fn("main", 1), fn("helper", 2), fn("lone", 3), fn("leaf", 4)],
      threads: [mainThread({ id: "main", kind: "main", grounded: false, roots: ["main"], reached: ["main", "helper", "leaf"] })],
      calls: [
        ["main", "helper"],
        ["helper", "leaf"],
      ],
      unthreaded: ["lone"],
    });
    const full = buildExecScene(m);
    expect(full.nodes.has("project>main")).toBe(true);
    const out = execRootsOnly(full, m);
    expect(keysOf(out)).toEqual([full.root, "project>lone", "project>main"].sort());
    expect(out.nodes.get(full.root)?.children).toEqual(["project>main", "project>lone"]);
    expect(out.nodes.has("project>helper")).toBe(false);
    expect(edgesOf(out)).toEqual([]);
  });

  describe("a thread with many functions over two files", () => {
    // 26 functions over two files. The cut keeps the roots' placements directly under the thread, with no file node.
    const names = (prefix: string) => Array.from({ length: 13 }, (_, i) => `${prefix}${i}`);
    const aNames = names("a");
    const bNames = names("b");
    const functions = [
      ...aNames.map((id, i) => fn(id, i + 1, { file: "src/a.ts" })),
      ...bNames.map((id, i) => fn(id, i + 1, { file: "src/b.ts" })),
    ];
    const reached = [...aNames, ...bNames].sort();

    it("keeps the placement of each root under its thread, and drops the others", () => {
      const m = model({
        functions,
        threads: [mainThread({ roots: ["a0", "b0"], reached, reach: reached.length })],
        calls: [
          ["a0", "a1"],
          ["a1", "b0"],
        ],
      });
      const thread = execThreadId("main");
      const out = execRootsOnly(buildExecScene(m), m);
      expect(keysOf(out)).toEqual(["prog:main", "project", thread, execFnId(thread, "a0"), execFnId(thread, "b0")].sort());
      expect(out.nodes.get(thread)?.children).toEqual([execFnId(thread, "a0"), execFnId(thread, "b0")]);
      expect(out.nodes.has(execFnId(thread, "a1"))).toBe(false);
      expect([...out.nodes.values()].some((n) => n.kind === "file")).toBe(false);
    });
  });
});

describe("flattenRoots", () => {
  it("drops every container: the roots are boxes directly on the project, once each", async () => {
    const { flattenRoots } = await import("../src/scene-filter.js");
    const m = basic();
    const cut = execRootsOnly(buildExecScene(m), m);
    const flat = flattenRoots(cut, m);
    const kinds = [...flat.nodes.values()].map((n) => n.kind);
    expect(kinds.every((k) => k === "function" || k === "project")).toBe(true);
    expect(flat.nodes.get(flat.root)?.children.every((c) => flat.nodes.get(c)?.parent === flat.root)).toBe(true);
    const refs = [...flat.nodes.values()].filter((n) => n.kind === "function").map((n) => n.ref);
    expect(new Set(refs).size).toBe(refs.length);
  });

  it("gives each box its file relative to the scope as the subtitle", async () => {
    const { flattenRoots } = await import("../src/scene-filter.js");
    const m = { ...basic(), scope: "src" };
    const flat = flattenRoots(execRootsOnly(buildExecScene(m), m), m);
    const box = [...flat.nodes.values()].find((n) => n.kind === "function");
    expect(box?.detail).toMatch(/^app\.ts:\d+$/);
  });
});
