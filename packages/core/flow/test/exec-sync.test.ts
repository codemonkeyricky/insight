import { describe, expect, it } from "vitest";
import type { IREdge, IRNode } from "@insight/ir";
import { execModel, resourcesOf, type ExecFunctionRef, type ExecModel, type ExecModelStats, type ExecResource, type ExecThread } from "../src/exec-model.js";
import { buildExecScene, execFnId, execThreadId } from "../src/exec-scene.js";
import { execRootsOnly, keepScene } from "../src/scene-filter.js";
import type { Scene, SceneNode } from "../src/scene.js";
import { PROVENANCE, callEdge, fnNode } from "./synthetic.js";

const spanAt = (file: string, line: number) => ({ file, start: [line, 2] as [number, number], end: [line, 8] as [number, number] });

/** An IR node in `parent` on `line` of `file`. Its id is unique per kind and line. */
function syncNode(file: string, line: number, parent: string, kind: string, attrs: Record<string, unknown>, facet = "sync"): IRNode {
  return { id: `${file}@${kind}:${line + 1}:2`, facet, kind, parent, span: spanAt(file, line), attrs, provenance: PROVENANCE };
}

/** A spawn of a thread on `line` of `file`, started by `owner`. Its id is the one the exec model uses for the thread. */
function spawnNode(file: string, line: number, owner: string): IRNode {
  return { id: `${file}@spawn:${line + 1}:2`, facet: "concurrency", kind: "concurrency.spawn-thread", parent: owner, span: spanAt(file, line), attrs: {}, provenance: PROVENANCE };
}

/** The spawns edge of that spawn: the thread it starts is `to`. */
function spawnEdge(file: string, line: number, to: IREdge["to"]): IREdge {
  return { from: `${file}@spawn:${line + 1}:2`, to, facet: "concurrency", kind: "concurrency.spawns", attrs: { how: "thread" }, span: spanAt(file, line), provenance: PROVENANCE };
}

/** The id the exec model gives the thread a spawn on `line` of `file` starts. */
const spawnThread = (file: string, line: number) => `${file}@spawn:${line + 1}:2`;

const lockOf = (file: string, line: number, parent: string, lock: string): IRNode => syncNode(file, line, parent, "sync.lock-acquire", { lock, mode: "exclusive" });

const syncEdges = (s: Scene) => s.edges.filter((e) => e.kind === "sync");

describe("execModel: condvars, semaphores and atomics", () => {
  it("a condvar with a lock attribute is its own resource, and also a site of the lock's resource", () => {
    // The function locks m on line 2, then waits on condvar cv (tied to m) on line 3.
    const nodes = [
      fnNode("src/m.ts", "main", 0),
      lockOf("src/m.ts", 1, "src/m.ts#main", "m"),
      syncNode("src/m.ts", 2, "src/m.ts#main", "sync.condvar", { op: "wait", name: "cv", lock: "m" }),
    ];
    const model = execModel(nodes, [], "src");
    expect(model.resources.map((r) => r.id)).toEqual(["condvar:cv", "lock:m"]);
    expect(model.resources.find((r) => r.id === "condvar:cv")).toMatchObject({
      kind: "condvar",
      name: "cv",
      sites: [{ fn: "src/m.ts#main", op: "wait", file: "src/m.ts", line: 3 }],
    });
    expect(model.resources.find((r) => r.id === "lock:m")?.sites.map((s) => [s.op, s.line])).toEqual([
      ["acquire", 2],
      ["wait", 3],
    ]);
    expect(model.stats).toMatchObject({ condvars: 1, semaphores: 0, atomics: 0 });
  });

  it("makes a semaphore and an atomic resources, and names an atomic with no lock <dynamic>", () => {
    const nodes = [
      fnNode("src/m.ts", "main", 0),
      syncNode("src/m.ts", 1, "src/m.ts#main", "sync.semaphore", { op: "acquire", name: "slots" }),
      syncNode("src/m.ts", 2, "src/m.ts#main", "sync.atomic-op", { op: "op", lock: "ctr" }),
      syncNode("src/m.ts", 3, "src/m.ts#main", "sync.atomic-op", { op: "op" }),
      syncNode("src/m.ts", 4, "src/m.ts#main", "sync.atomic-op", { op: "op", api: "std::atomic::fetch_add" }),
    ];
    const model = execModel(nodes, [], "src");
    expect(model.resources.map((r) => [r.id, r.kind])).toEqual([
      ["atomic:<dynamic>", "atomic"],
      ["atomic:ctr", "atomic"],
      ["semaphore:slots", "semaphore"],
    ]);
    expect(model.stats).toMatchObject({ semaphores: 1, atomics: 2 });
  });

  it("gives a lock-release a site with op release in the lock's resource", () => {
    const nodes = [
      fnNode("src/m.ts", "main", 0),
      lockOf("src/m.ts", 1, "src/m.ts#main", "m"),
      syncNode("src/m.ts", 2, "src/m.ts#main", "sync.lock-release", { lock: "m" }),
    ];
    const model = execModel(nodes, [], "src");
    expect(model.resources).toMatchObject([{ id: "lock:m", kind: "lock", sites: [{ op: "acquire" }, { fn: "src/m.ts#main", op: "release", line: 3 }] }]);
  });

  it("lists a dynamic channel as a resource, but draws no sync edge for it", () => {
    const nodes = [
      fnNode("src/m.ts", "main", 0),
      spawnNode("src/m.ts", 3, "src/m.ts#main"),
      fnNode("src/w.ts", "work", 0),
      syncNode("src/m.ts", 1, "src/m.ts#main", "concurrency.channel-send", { channel: "<dynamic>" }, "concurrency"),
      syncNode("src/w.ts", 2, "src/w.ts#work", "concurrency.channel-recv", { channel: "<dynamic>" }, "concurrency"),
    ];
    const model = execModel(nodes, [spawnEdge("src/m.ts", 3, "src/w.ts#work")], "src");
    expect(model.resources.map((r) => r.id)).toEqual(["channel:<dynamic>"]);
    expect(model.stats).toMatchObject({ channels: 1 });
    const s = buildExecScene(model);
    expect(syncEdges(s)).toEqual([]);
  });

  it("returns the resources a function has a site in", () => {
    const nodes = [
      fnNode("src/m.ts", "main", 0),
      lockOf("src/m.ts", 1, "src/m.ts#main", "m"),
      syncNode("src/m.ts", 2, "src/m.ts#main", "sync.condvar", { op: "wait", name: "cv", lock: "m" }),
      fnNode("src/m.ts", "other", 6),
    ];
    const model = execModel(nodes, [], "src");
    expect(resourcesOf(model, "src/m.ts#main").map((r) => r.id)).toEqual(["condvar:cv", "lock:m"]);
    expect(resourcesOf(model, "src/m.ts#other")).toEqual([]);
  });
});

describe("buildExecScene: named sync edges", () => {
  it("merges two locks shared by the same two threads into one edge that names both", () => {
    const nodes = [
      fnNode("src/m.ts", "main", 0),
      lockOf("src/m.ts", 1, "src/m.ts#main", "a"),
      lockOf("src/m.ts", 2, "src/m.ts#main", "b"),
      spawnNode("src/m.ts", 4, "src/m.ts#main"),
      fnNode("src/w.ts", "work", 0),
      lockOf("src/w.ts", 1, "src/w.ts#work", "a"),
      lockOf("src/w.ts", 2, "src/w.ts#work", "b"),
    ];
    const model = execModel(nodes, [spawnEdge("src/m.ts", 4, "src/w.ts#work")], "src");
    const edges = syncEdges(buildExecScene(model));
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      from: execFnId(execThreadId("main"), "src/m.ts#main"),
      to: execFnId(execThreadId(spawnThread("src/m.ts", 4)), "src/w.ts#work"),
      count: 2,
      how: "lock",
      directed: false,
      resources: [
        { name: "a", kind: "lock" },
        { name: "b", kind: "lock" },
      ],
    });
  });

  it("points a channel edge from the sender to the receiver", () => {
    const nodes = [
      fnNode("src/m.ts", "main", 0),
      syncNode("src/m.ts", 1, "src/m.ts#main", "concurrency.channel-send", { channel: "jobs" }, "concurrency"),
      spawnNode("src/m.ts", 3, "src/m.ts#main"),
      fnNode("src/w.ts", "work", 0),
      syncNode("src/w.ts", 2, "src/w.ts#work", "concurrency.channel-recv", { channel: "jobs" }, "concurrency"),
    ];
    const model = execModel(nodes, [spawnEdge("src/m.ts", 3, "src/w.ts#work")], "src");
    const edges = syncEdges(buildExecScene(model));
    expect(edges).toEqual([
      {
        from: execFnId(execThreadId("main"), "src/m.ts#main"),
        to: execFnId(execThreadId(spawnThread("src/m.ts", 3)), "src/w.ts#work"),
        kind: "sync",
        count: 1,
        how: "channel",
        directed: true,
        resources: [{ name: "jobs", kind: "channel" }],
      },
    ]);
  });

  it("keeps the roots that reach a site, and joins them with the named edge, when the scene is cut to roots only", () => {
    // main's root m1 calls s1, which locks m. The worker's root w1 calls w2, which locks m too. s1 and w2 are not roots.
    const functions: ExecFunctionRef[] = [
      { id: "m1", name: "m1", file: "src/app.ts", line: 1, inScope: true, runtime: "thread" },
      { id: "s1", name: "s1", file: "src/app.ts", line: 5, inScope: true, runtime: "thread" },
      { id: "w1", name: "w1", file: "src/app.ts", line: 10, inScope: true, runtime: "thread" },
      { id: "w2", name: "w2", file: "src/app.ts", line: 14, inScope: true, runtime: "thread" },
    ];
    const thread = (id: string, roots: string[], reached: string[]): ExecThread => ({
      id,
      kind: id === "main" ? "main" : "thread",
      grounded: true,
      roots,
      reach: reached.length,
      reached: [...reached].sort(),
      coroutines: [],
      coroutineOnly: [],
    });
    const index = new Map(functions.map((f, i) => [f.id, i]));
    const model: ExecModel = {
      scope: "",
      truncated: false,
      functions,
      threads: [thread("main", ["m1"], ["m1", "s1"]), thread("t1", ["w1"], ["w1", "w2"])],
      programs: [],
      dispatches: [],
      calls: [
        [index.get("m1") as number, index.get("s1") as number],
        [index.get("w1") as number, index.get("w2") as number],
      ],
      unthreaded: [],
      resources: [
        {
          id: "lock:m",
          kind: "lock",
          name: "m",
          threads: ["main", "t1"],
          sites: [
            { fn: "s1", op: "acquire", file: "src/app.ts", line: 6 },
            { fn: "w2", op: "acquire", file: "src/app.ts", line: 15 },
          ],
        },
      ],
      stats: {} as ExecModelStats,
    };
    const full = buildExecScene(model);
    expect(syncEdges(full).map((e) => [e.from, e.to])).toEqual([[execFnId(execThreadId("main"), "s1"), execFnId(execThreadId("t1"), "w2")]]);

    const cut = execRootsOnly(full, model);
    expect(cut.nodes.has(execFnId(execThreadId("main"), "m1"))).toBe(true);
    expect(cut.nodes.has(execFnId(execThreadId("main"), "s1"))).toBe(false);
    expect(cut.nodes.has(execFnId(execThreadId("t1"), "w2"))).toBe(false);
    expect(syncEdges(cut)).toEqual([
      {
        from: execThreadId("main"),
        to: execThreadId("t1"),
        kind: "sync",
        count: 1,
        how: "lock",
        directed: false,
        resources: [{ name: "m", kind: "lock" }],
      },
    ]);
  });

  it("drops a sync edge whose two ends re-attach to the same box", () => {
    // Two functions in two threads, both in one program. Neither thread is kept, so both ends re-attach to the program.
    const node = (id: string, kind: string, parent: string | undefined, label: string): SceneNode => ({ id, kind, label, parent, children: [] } as SceneNode);
    const nodes = new Map<string, SceneNode>([
      ["project", { id: "project", kind: "project", label: "project", children: ["prog:P"] } as SceneNode],
      ["prog:P", { ...node("prog:P", "program", "project", "P"), children: ["thread:A", "thread:B", "prog:P>z"] }],
      ["thread:A", { ...node("thread:A", "thread", "prog:P", "A"), children: ["thread:A>x"] }],
      ["thread:B", { ...node("thread:B", "thread", "prog:P", "B"), children: ["thread:B>y"] }],
      ["thread:A>x", { ...node("thread:A>x", "function", "thread:A", "x"), children: [] }],
      ["thread:B>y", { ...node("thread:B>y", "function", "thread:B", "y"), children: [] }],
      ["prog:P>z", { ...node("prog:P>z", "function", "prog:P", "z"), children: [] }],
    ]);
    const scene: Scene = {
      root: "project",
      nodes,
      edges: [{ from: "thread:A>x", to: "thread:B>y", kind: "sync", count: 1, how: "lock", directed: false, resources: [{ name: "m", kind: "lock" }] }],
      levels: {},
    };
    const cut = keepScene(scene, new Set(["prog:P>z"]));
    expect(cut.nodes.has("prog:P")).toBe(true);
    expect(cut.edges).toEqual([]);
  });
});

describe("buildExecScene: atomics pair only by the variable they name", () => {
  /** A fetch_add on a variable (`lock`), or on one with no name when `lock` is undefined. */
  const atomicOn = (file: string, line: number, parent: string, lock: string | undefined) =>
    syncNode(file, line, parent, "sync.atomic-op", { op: "op", api: "std::atomic::fetch_add", ...(lock !== undefined ? { lock } : {}) });
  /** Main does a fetch_add on `mine`, then spawns a worker that does one on `theirs`. */
  const twoThreads = (mine: string | undefined, theirs: string | undefined) => {
    const nodes = [fnNode("src/m.ts", "main", 0), atomicOn("src/m.ts", 1, "src/m.ts#main", mine), spawnNode("src/m.ts", 3, "src/m.ts#main"), fnNode("src/w.ts", "work", 0), atomicOn("src/w.ts", 2, "src/w.ts#work", theirs)];
    const model = execModel(nodes, [spawnEdge("src/m.ts", 3, "src/w.ts#work")], "src");
    return syncEdges(buildExecScene(model));
  };

  it("gives no sync edge between two threads' fetch_add on different variables", () => {
    expect(twoThreads("x", "y")).toEqual([]);
  });

  it("gives a sync edge between two threads' fetch_add on the same variable", () => {
    expect(twoThreads("x", "x")).toHaveLength(1);
  });

  it("gives no sync edge between two atomics whose variable is unknown", () => {
    expect(twoThreads(undefined, undefined)).toEqual([]);
  });
});
