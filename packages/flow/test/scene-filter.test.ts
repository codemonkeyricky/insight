import { describe, expect, it } from "vitest";
import type { ExecFunctionRef, ExecModel, ExecModelStats, ExecThread } from "../src/exec-model.js";
import { buildExecScene, execFileId, execFnId, execThreadId, NO_RUNTIME_GROUP } from "../src/exec-scene.js";
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
  it("keeps each thread and the placements of its roots, and drops coroutines and the no-runtime group", () => {
    const m = basic();
    const full = buildExecScene(m);
    // The full scene has the nodes the cut must remove.
    expect(full.nodes.has("co:main:co")).toBe(true);
    expect(full.nodes.has(NO_RUNTIME_GROUP)).toBe(true);

    const out = execRootsOnly(full, m);
    expect(keysOf(out)).toEqual(
      [
        full.root,
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
        { id: "spawn:2", kind: "thread", roots: [], reach: 0, reached: [], coroutines: [], coroutineOnly: [] },
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
    expect(keysOf(out)).toEqual([full.root, execThreadId("main"), execFnId(execThreadId("main"), "main")].sort());
  });

  describe("a thread with more than one file", () => {
    // 26 functions over two files: past FILE_GROUP_MIN, so the thread groups them by file.
    const names = (prefix: string) => Array.from({ length: 13 }, (_, i) => `${prefix}${i}`);
    const aNames = names("a");
    const bNames = names("b");
    const functions = [
      ...aNames.map((id, i) => fn(id, i + 1, { file: "src/a.ts" })),
      ...bNames.map((id, i) => fn(id, i + 1, { file: "src/b.ts" })),
    ];
    const reached = [...aNames, ...bNames].sort();

    it("keeps the file node of a root, with only the root under it", () => {
      const m = model({
        functions,
        threads: [mainThread({ roots: ["a0"], reached, reach: reached.length })],
        calls: [
          ["a0", "a1"],
          ["a1", "b0"],
        ],
      });
      const full = buildExecScene(m);
      const thread = execThreadId("main");
      const aFile = execFileId(thread, "src/a.ts");
      expect(full.nodes.get(aFile)?.kind).toBe("file");

      const out = execRootsOnly(full, m);
      expect(out.nodes.get(aFile)?.kind).toBe("file");
      expect(out.nodes.get(aFile)?.parent).toBe(thread);
      expect(out.nodes.get(aFile)?.children).toEqual([execFnId(thread, "a0")]);
      expect(out.nodes.has(execFnId(thread, "a1"))).toBe(false);
      expect(out.nodes.has(execFileId(thread, "src/b.ts"))).toBe(false);
      expect(out.nodes.get(thread)?.children).toEqual([aFile]);
    });

    it("keeps a file node for each file with a root", () => {
      const m = model({ functions, threads: [mainThread({ roots: ["a0", "b0"], reached, reach: reached.length })] });
      const thread = execThreadId("main");
      const out = execRootsOnly(buildExecScene(m), m);
      expect(out.nodes.get(thread)?.children).toEqual([execFileId(thread, "src/a.ts"), execFileId(thread, "src/b.ts")]);
      expect(out.nodes.has(execFnId(thread, "b0"))).toBe(true);
      expect(out.nodes.has(execFnId(thread, "b1"))).toBe(false);
    });
  });
});
