import { describe, expect, it } from "vitest";
import type { IRNode } from "@insight/ir";
import { execModel, type ExecCoroutine, type ExecDispatch, type ExecFunctionRef, type ExecModel, type ExecModelStats, type ExecResource, type ExecSpawn, type ExecThread } from "../src/exec-model.js";
import { buildExecScene } from "../src/exec-scene.js";
import type { Scene } from "../src/scene.js";
import { MORE_KEEP, MORE_SUFFIX, unrootedFunctions, unrootedReach, unrootedScene } from "../src/unrooted.js";
import { callEdge, fnNode, lockOf, spawnEdge, spawnNode } from "./synthetic.js";

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
  channels: 0,
  condvars: 0,
  semaphores: 0,
  atomics: 0,
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

/** A file's module entry, `<file>#(module)`. */
const moduleOf = (file: string): ExecFunctionRef => ({ id: `${file}#(module)`, name: file, file, line: 1, inScope: true, runtime: "thread", module: true });

const thread = (id: string, roots: string[], reached: string[] = roots, coroutines: ExecCoroutine[] = [], spawn?: ExecSpawn): ExecThread => ({
  id,
  kind: id === "main" ? "main" : "thread",
  grounded: true,
  ...(spawn !== undefined ? { spawn } : {}),
  roots,
  reach: reached.length,
  reached: [...reached].sort(),
  coroutines,
  coroutineOnly: [],
});

/** A spawn that a function (or a file, for module-level code) starts. Its thread is `to`, and it draws as spawned by `owner`. */
const spawnedBy = (owner: string | undefined, file = "src/app.ts"): ExecSpawn => ({
  node: `${file}@spawn`,
  ...(owner !== undefined ? { owner } : {}),
  file,
  line: 1,
  how: "thread",
  status: "resolved",
  candidates: false,
});

/** A model from functions, threads, calls and dispatches given by function id. */
function model(parts: {
  functions: ExecFunctionRef[];
  threads?: ExecThread[];
  calls?: [string, string][];
  dispatches?: [string, string][];
  unthreaded?: string[];
  resources?: ExecResource[];
}): ExecModel {
  const index = new Map(parts.functions.map((f, i) => [f.id, i]));
  const at = (id: string): number => {
    const i = index.get(id);
    if (i === undefined) throw new Error(`no function ${id}`);
    return i;
  };
  const dispatches: ExecDispatch[] = (parts.dispatches ?? []).map(([from, to]) => ({ from, how: "callback", targets: [to], candidates: false, file: "src/app.ts", line: 1 }));
  return {
    scope: "",
    truncated: false,
    functions: parts.functions,
    threads: parts.threads ?? [],
    dispatches,
    programs: [],
    calls: (parts.calls ?? []).map(([a, b]) => [at(a), at(b)] as [number, number]),
    unthreaded: parts.unthreaded ?? [],
    ...(parts.resources !== undefined ? { resources: parts.resources } : {}),
    stats: ZERO_STATS,
  };
}

const allIds = (m: ExecModel): Set<string> => new Set(m.functions.map((f) => f.id));
const refsOf = (scene: ReturnType<typeof unrootedScene>): string[] => [...scene.nodes.values()].filter((n) => n.kind === "function").map((n) => n.ref ?? "");
/** The name a scene node is known by in these tests: its function, or its id (the "+N more" card, the root). */
const nameOf = (scene: Scene, id: string): string => scene.nodes.get(id)?.ref ?? id;
/** The functions a scene draws, by id. */
const drawnOf = (scene: Scene): Set<string> => new Set([...scene.nodes.values()].filter((n) => n.kind === "function").map((n) => n.ref ?? ""));
const syncOf = (scene: Scene): [string, string, string[]][] =>
  scene.edges
    .filter((e) => e.kind === "sync")
    .map((e) => [nameOf(scene, e.from), nameOf(scene, e.to), (e.resources ?? []).map((r) => r.name).sort()] as [string, string, string[]])
    .sort((a, b) => (a[0] + a[1] < b[0] + b[1] ? -1 : a[0] + a[1] > b[0] + b[1] ? 1 : 0));
/** A lock the listed functions acquire, one site per function, in the order given. */
const lockRes = (name: string, fns: string[]): ExecResource => ({
  id: `lock:${name}`,
  kind: "lock",
  name,
  threads: [],
  sites: fns.map((fn, i) => ({ fn, op: "acquire", file: "src/app.ts", line: i + 1 })),
});
/** A file's module entry as the TypeScript frontend emits it: `<file>#(module)`. */
const moduleNode = (file: string): IRNode => ({ ...fnNode(file, "(module)", 0), attrs: { name: "(module)", module: true } });

describe("unrootedFunctions: the cards of a scope", () => {
  it("(a) draws a function two threads start once", () => {
    const m = model({
      functions: [fn("x", 1), fn("y", 2)],
      threads: [thread("main", ["x"]), thread("t1", ["x", "y"])],
    });
    const flat = unrootedScene(buildExecScene(m), m);
    expect(refsOf(flat).filter((r) => r === "x")).toEqual(["x"]);
    expect(flat.nodes.get(flat.root)?.children.length).toBe(2);
  });

  it("(a) a function called from two threads is not a card, and is not drawn twice", () => {
    const m = model({
      functions: [fn("a", 1), fn("b", 2), fn("shared", 3)],
      threads: [thread("t1", ["a"], ["a", "shared"]), thread("t2", ["b"], ["b", "shared"])],
      calls: [
        ["a", "shared"],
        ["b", "shared"],
      ],
    });
    expect(unrootedFunctions(m, allIds(m))).toEqual(["a", "b"]);
    const flat = unrootedScene(buildExecScene(m), m);
    expect(refsOf(flat).sort()).toEqual(["a", "b"]);
  });

  it("(b) a module entry that calls something is a card; one that calls nothing is not", () => {
    const m = model({
      functions: [moduleOf("src/a.ts"), fn("alpha", 2), moduleOf("src/b.ts"), fn("beta", 3)],
      threads: [thread("main", ["src/a.ts#(module)", "src/b.ts#(module)"], ["src/a.ts#(module)", "src/b.ts#(module)", "alpha"])],
      calls: [["src/a.ts#(module)", "alpha"]],
    });
    expect(unrootedFunctions(m, allIds(m))).toEqual(["beta", "src/a.ts#(module)"]);
    const flat = unrootedScene(buildExecScene(m), m);
    const entry = [...flat.nodes.values()].find((n) => n.ref === "src/a.ts#(module)");
    expect(entry?.detail?.startsWith("top level · ")).toBe(true);
    expect(refsOf(flat)).not.toContain("src/b.ts#(module)");
  });

  it("(c) a cycle no outside function enters yields one card", () => {
    const m = model({
      functions: [fn("a", 1), fn("b", 2)],
      calls: [
        ["a", "b"],
        ["b", "a"],
      ],
    });
    expect(unrootedFunctions(m, allIds(m))).toEqual(["a"]);
  });

  it("(c) a cycle an outside function enters yields no card of its own", () => {
    const m = model({
      functions: [fn("main", 1), fn("a", 2), fn("b", 3)],
      calls: [
        ["main", "a"],
        ["a", "b"],
        ["b", "a"],
      ],
    });
    expect(unrootedFunctions(m, allIds(m))).toEqual(["main"]);
  });
});

describe("unrootedScene: the flat grid", () => {
  it("(d) draws no program, thread, coroutine or group node", () => {
    const m = model({
      functions: [fn("main", 1), fn("a", 2), fn("co", 3), fn("h", 4), fn("lone", 5)],
      threads: [
        thread("main", ["main"], ["main", "a"]),
        thread("t1", ["a"], ["a", "co", "h"], [{ target: "co", how: "await", dispatchedBy: ["main"], callees: ["h"] } as ExecCoroutine]),
      ],
      calls: [
        ["main", "a"],
        ["co", "h"],
      ],
      unthreaded: ["lone"],
    });
    const flat = unrootedScene(buildExecScene(m), m);
    const kinds = new Set([...flat.nodes.values()].map((n) => n.kind));
    expect([...kinds].sort()).toEqual(["function", "project"]);
  });

  it("shows the first cards and one '+N more' card when the grid is long, and every card once expanded", () => {
    const names = Array.from({ length: 30 }, (_, i) => `f${String(i).padStart(2, "0")}`);
    const m = model({
      functions: names.map((id, i) => fn(id, i + 1)),
      threads: [thread("main", names)],
    });
    const full = buildExecScene(m);
    const flat = unrootedScene(full, m);
    const root = flat.nodes.get(flat.root);
    expect(root?.children.length).toBe(MORE_KEEP + 1);
    const more = root?.children.at(-1) ?? "";
    expect(more).toBe(`${flat.root}${MORE_SUFFIX}`);
    expect(flat.nodes.get(more)?.label).toBe(`+${names.length - MORE_KEEP} more`);
    const open = unrootedScene(full, m, new Set([flat.root]));
    expect(open.nodes.get(open.root)?.children.length).toBe(names.length);
    expect([...open.nodes.values()].some((n) => n.kind === "more")).toBe(false);
  });
});

describe("sync edges in the flat grid", () => {
  it("(i) main takes lock a and spawns a thread whose work takes a: the card is main, and the edge joins main to itself, so main carries a as syncSelf", () => {
    const nodes = [
      fnNode("src/m.ts", "main", 0),
      lockOf("src/m.ts", 1, "src/m.ts#main", "a"),
      spawnNode("src/m.ts", 3, "src/m.ts#main"),
      fnNode("src/w.ts", "work", 0),
      lockOf("src/w.ts", 1, "src/w.ts#work", "a"),
    ];
    const m = execModel(nodes, [spawnEdge("src/m.ts", 3, "src/w.ts#work")], "src");
    const full = buildExecScene(m);
    expect(syncOf(full)).toEqual([["src/m.ts#main", "src/w.ts#work", ["a"]]]);
    // work has no card of its own: main spawns it, so main's card reaches it and both ends join main.
    expect(unrootedReach(m, drawnOf(full)).cardOf("src/w.ts#work")).toBe("src/m.ts#main");
    const flat = unrootedScene(full, m);
    expect(refsOf(flat)).toEqual(["src/m.ts#main"]);
    // The renderer draws no self-edge (sceneEdges drops a == b), so the flat grid keeps none. Its resource stays on the card.
    expect(syncOf(flat)).toEqual([]);
    const card = [...flat.nodes.values()].find((n) => n.kind === "function");
    expect(card?.ref).toBe("src/m.ts#main");
    expect(card?.syncSelf).toEqual([{ name: "a", kind: "lock" }]);
  });

  it("(i) a card with no self-sync edge carries no syncSelf", () => {
    const nodes = [
      fnNode("src/m.ts", "main", 0),
      lockOf("src/m.ts", 1, "src/m.ts#main", "a"),
      spawnNode("src/m.ts", 3, "src/m.ts#main"),
      fnNode("src/w.ts", "work", 0),
      lockOf("src/w.ts", 1, "src/w.ts#work", "b"),
    ];
    const m = execModel(nodes, [spawnEdge("src/m.ts", 3, "src/w.ts#work")], "src");
    const flat = unrootedScene(buildExecScene(m), m);
    expect(syncOf(flat)).toEqual([]);
    expect([...flat.nodes.values()].some((n) => n.syncSelf !== undefined)).toBe(false);
  });

  it("(ii) a sync site in a card's callee joins that card, not a sibling card of its thread", () => {
    // The entry is named main, so the main thread is grounded (exec-scene draws only grounded threads' functions in boxes).
    const nodes = [
      fnNode("src/m.ts", "main", 12),
      fnNode("src/m.ts", "alpha", 0),
      fnNode("src/m.ts", "m1", 4),
      fnNode("src/m.ts", "s1", 8),
      lockOf("src/m.ts", 9, "src/m.ts#s1", "m"),
      // A thread started from outside the scope: no in-scope owner, so its root w1 has no spawner and is a card of its own.
      { ...spawnNode("src/m.ts", 20, "src/m.ts#alpha"), parent: undefined },
      fnNode("src/w.ts", "w1", 0),
      lockOf("src/w.ts", 1, "src/w.ts#w1", "m"),
    ];
    const edges = [callEdge("src/m.ts#m1", "src/m.ts#s1", "src/m.ts", 5), spawnEdge("src/m.ts", 20, "src/w.ts#w1")];
    const m = execModel(nodes, edges, "src");
    const full = buildExecScene(m);
    const flat = unrootedScene(full, m);
    expect(refsOf(flat).sort()).toEqual(["src/m.ts#alpha", "src/m.ts#m1", "src/m.ts#main", "src/w.ts#w1"]);
    // alpha is a card of the same thread, but does not reach s1: the edge runs from m1.
    expect(syncOf(flat)).toEqual([["src/m.ts#m1", "src/w.ts#w1", ["m"]]]);
  });

  it("m6: a sync edge whose card is hidden behind '+N more' reattaches to that card, and an edge that lands on one pair stays one", () => {
    const names = Array.from({ length: 30 }, (_, i) => `f${String(i).padStart(2, "0")}`);
    const m = model({
      functions: [...names.map((id, i) => fn(id, i + 1)), fn("w", 40)],
      threads: [thread("main", names), thread("t1", ["w"])],
      resources: [
        lockRes("a", ["f00", "w"]),
        lockRes("b", ["f26", "w"]),
        lockRes("c", ["f01", "w"]),
        lockRes("d", ["f00", "w"]),
      ],
    });
    const flat = unrootedScene(buildExecScene(m), m);
    // w sorts past the first 23 cards, so it is hidden: f00 and f01 keep their edges to the "+N more" card, and a pair of two
    // hidden ends (f26 and w) draws nothing. a and d join f00 to w, so they merge into one edge.
    expect(flat.nodes.get(flat.root)?.children.at(-1)).toBe(`${flat.root}${MORE_SUFFIX}`);
    expect(refsOf(flat)).not.toContain("f26");
    expect(syncOf(flat)).toEqual([
      ["f00", `${flat.root}${MORE_SUFFIX}`, ["a", "d"]],
      ["f01", `${flat.root}${MORE_SUFFIX}`, ["c"]],
    ]);
    const merged = flat.edges.find((e) => e.kind === "sync" && nameOf(flat, e.from) === "f00");
    expect(merged?.count).toBe(2);
  });
});

describe("unguarded threads in the flat grid", () => {
  it("N2: a card whose reach holds a function of a thread with unguarded shared state carries that thread's names; an unrelated card does not", () => {
    const m = model({
      functions: [fn("main", 1), fn("lone", 2), fn("w", 3)],
      threads: [
        thread("main", ["main", "lone"], ["main", "lone"]),
        { ...thread("t1", ["w"], ["w"], [], spawnedBy("main")), unguardedWrites: ["counter"] },
      ],
    });
    const full = buildExecScene(m);
    // The thread's own box carries the names in the full scene: the flat grid drops that box, so its cards must carry them.
    expect([...full.nodes.values()].find((n) => n.kind === "thread" && n.unguarded !== undefined)?.unguarded).toEqual(["counter"]);
    const flat = unrootedScene(full, m);
    expect(refsOf(flat).sort()).toEqual(["lone", "main"]);
    const card = (ref: string) => [...flat.nodes.values()].find((n) => n.kind === "function" && n.ref === ref);
    // main spawns w, so main's card reaches the unguarded thread; lone reaches nothing of it.
    expect(card("main")?.unguarded).toEqual(["counter"]);
    expect(card("lone")?.unguarded).toBeUndefined();
    expect([...flat.nodes.values()].some((n) => n.kind === "thread")).toBe(false);
  });

  it("N2: a thread's own card carries the thread's names when the thread has no spawner in scope", () => {
    const m = model({
      functions: [fn("a", 1), fn("b", 2)],
      threads: [thread("main", ["a"]), { ...thread("t1", ["b"]), unguardedWrites: ["q", "p"] }],
    });
    const flat = unrootedScene(buildExecScene(m), m);
    const card = (ref: string) => [...flat.nodes.values()].find((n) => n.kind === "function" && n.ref === ref);
    expect(card("b")?.unguarded).toEqual(["p", "q"]);
    expect(card("a")?.unguarded).toBeUndefined();
  });
});

describe("unrootedFunctions: the rules of the cards", () => {
  it("m2: a module entry whose top-level code calls only out of scope is a card; one that calls nothing is not", () => {
    const nodes = [moduleNode("src/a.ts"), moduleNode("src/b.ts"), fnNode("lib/x.ts", "x", 0)];
    const m = execModel(nodes, [callEdge("src/a.ts#(module)", "lib/x.ts#x", "src/a.ts", 3)], "src");
    expect(m.functions.map((f) => f.id)).not.toContain("lib/x.ts#x");
    expect(m.functions.find((f) => f.id === "src/a.ts#(module)")?.callsOut).toBe(true);
    expect(unrootedFunctions(m, drawnOf(buildExecScene(m)))).toEqual(["src/a.ts#(module)"]);
    expect(refsOf(unrootedScene(buildExecScene(m), m))).toEqual(["src/a.ts#(module)"]);
  });

  it("m7: a dispatch edge suppresses its target's card", () => {
    const m = model({ functions: [fn("a", 1), fn("b", 2)], threads: [thread("main", ["a", "b"])], dispatches: [["a", "b"]] });
    expect(unrootedFunctions(m, allIds(m))).toEqual(["a"]);
  });

  it("m7: a spawn whose owner is a file counts as the file's module entry", () => {
    const m = model({
      functions: [moduleOf("src/boot.ts"), fn("w", 3, { file: "src/w.ts" })],
      threads: [thread("main", ["src/boot.ts#(module)"]), thread("t1", ["w"], ["w"], [], spawnedBy("src/boot.ts", "src/boot.ts"))],
    });
    // The module starts t1, so it is the spawner and reaches w: w is not a card.
    expect(unrootedFunctions(m, allIds(m))).toEqual(["src/boot.ts#(module)"]);
  });

  it("m7: a module entry that only spawns is a card, even when its spawn targets lie outside the scope", () => {
    const m = model({
      functions: [moduleOf("src/boot.ts")],
      threads: [thread("main", ["src/boot.ts#(module)"]), thread("t1", [], [], [], spawnedBy("src/boot.ts", "src/boot.ts"))],
    });
    expect(unrootedFunctions(m, allIds(m))).toEqual(["src/boot.ts#(module)"]);
  });

  it("m7: a coroutine's dispatchers reach its target, so the target is no card", () => {
    const m = model({
      functions: [fn("main", 1), fn("h", 2)],
      threads: [thread("main", ["main"], ["main", "h"], [{ target: "h", how: "await", dispatchedBy: ["main"], callees: [] }])],
    });
    expect(unrootedFunctions(m, allIds(m))).toEqual(["main"]);
  });

  it("m7: a coroutine dispatched from module-level code is reached from the file's module entry", () => {
    const m = model({
      functions: [moduleOf("src/a.ts"), fn("h", 2, { file: "src/a.ts" })],
      threads: [thread("main", ["src/a.ts#(module)"], ["src/a.ts#(module)", "h"], [{ target: "h", how: "start", dispatchedBy: ["src/a.ts"], callees: [] }])],
    });
    expect(unrootedFunctions(m, allIds(m))).toEqual(["src/a.ts#(module)"]);
  });

  it("unrootedReach: a function is drawn under the nearest card that reaches it", () => {
    // a calls b, b calls c, and d calls c: c is two calls from a and one from d, so it is drawn under d.
    const m = model({
      functions: [fn("a", 1), fn("b", 2), fn("c", 3), fn("d", 4)],
      threads: [thread("main", ["a", "d"])],
      calls: [
        ["a", "b"],
        ["b", "c"],
        ["d", "c"],
      ],
    });
    const reach = unrootedReach(m, allIds(m));
    expect(reach.cards).toEqual(["a", "d"]);
    expect(reach.cardOf("c")).toBe("d");
    expect(reach.cardOf("b")).toBe("a");
    expect(reach.reachOf("a")).toEqual(["a", "b", "c"]);
  });
});

