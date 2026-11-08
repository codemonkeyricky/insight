import { describe, expect, it } from "vitest";
import {
  EXEC_LEVELS,
  EXEC_PROJECT_ROOT,
  EXEC_ROOT,
  NO_RUNTIME_GROUP,
  NO_RUNTIME_NOTE,
  buildExecScene,
  execCoroutineId,
  execProgramId,
  FILE_GROUP_MIN,
  execFileId,
  execFnId,
  execThreadId,
  MAX_SYNC_EDGES_PER_RESOURCE,
} from "../src/exec-scene.js";
import type { ExecFunctionRef, ExecModel, ExecModelStats, ExecProgram, ExecResource, ExecThread } from "../src/exec-model.js";
import type { Scene } from "../src/scene.js";

const ZERO_STATS: ExecModelStats = {
  threads: 0,
  spawns: 0,
  programs: 0,
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
  locks: 0,
  channels: 0,
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
  dispatches?: ExecModel["dispatches"];
  programs?: ExecProgram[];
  resources?: ExecResource[];
  scope?: string;
  truncated?: boolean;
}): ExecModel {
  const index = new Map(parts.functions.map((f, i) => [f.id, i]));
  const at = (id: string): number => {
    const i = index.get(id);
    if (i === undefined) throw new Error(`no function ${id}`);
    return i;
  };
  return {
    scope: parts.scope ?? "",
    truncated: parts.truncated ?? false,
    functions: parts.functions,
    threads: parts.threads,
    programs: parts.programs ?? [],
    dispatches: parts.dispatches ?? [],
    calls: (parts.calls ?? []).map(([a, b]) => [at(a), at(b)] as [number, number]),
    unthreaded: parts.unthreaded ?? [],
    resources: parts.resources ?? [],
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

/** The tree as id -> [kind, children], in insertion order. */
const shape = (s: Scene): [string, string, string[]][] => [...s.nodes.values()].map((n) => [n.id, n.kind, n.children]);

const node = (s: Scene, id: string) => {
  const n = s.nodes.get(id);
  if (n === undefined) throw new Error(`no node ${id}`);
  return n;
};

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
        reach: 4,
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

describe("exec scene ids", () => {
  it("builds the ids from their parts", () => {
    expect(EXEC_ROOT).toBe("program");
    expect(NO_RUNTIME_GROUP).toBe("group:none");
    expect(execThreadId("main")).toBe("thread:main");
    expect(execCoroutineId("main", "co")).toBe("co:main:co");
    expect(execFnId("thread:main", "a")).toBe("thread:main>a");
  });
});

describe("buildExecScene", () => {
  it("builds the program, thread, coroutine and group tree with its edges", () => {
    const s = buildExecScene(basic());
    expect(s.root).toBe("program");
    expect(s.levels).toBe(EXEC_LEVELS);
    expect(shape(s)).toEqual([
      ["program", "program", ["thread:main", "thread:spawn:1", "group:none"]],
      ["thread:main", "thread", ["thread:main>main", "thread:main>a", "co:main:co"]],
      ["thread:main>main", "function", []],
      ["thread:main>a", "function", []],
      ["co:main:co", "coroutine", ["co:main:co>co", "co:main:co>h"]],
      ["co:main:co>co", "function", []],
      ["co:main:co>h", "function", []],
      ["thread:spawn:1", "thread", ["thread:spawn:1>work"]],
      ["thread:spawn:1>work", "function", []],
      ["group:none", "group", ["group:none>f"]],
      ["group:none>f", "function", []],
    ]);

    const root = node(s, "program");
    expect(root.label).toBe("Program");
    expect(root.detail).toBe("2 threads");
    expect(root.note).toBeUndefined();

    const main = node(s, "thread:main");
    expect(main).toMatchObject({ label: "Main thread", detail: "4 functions", parent: "program" });
    expect(main.note).toBeUndefined();
    const spawned = node(s, "thread:spawn:1");
    expect(spawned).toMatchObject({ label: "Thread · work", detail: "1 function" });
    expect(spawned.note).toBe("Spawned at src/app.ts:5.");

    expect(node(s, "co:main:co")).toMatchObject({
      label: "co",
      detail: "awaited",
      note: "Dispatched by main.",
      parent: "thread:main",
    });
    expect(node(s, "thread:main>a")).toEqual({
      id: "thread:main>a",
      kind: "function",
      label: "a",
      parent: "thread:main",
      children: [],
      detail: "src/app.ts:10",
      ref: "a",
    });

    const group = node(s, "group:none");
    expect(group.label).toBe("No runtime context");
    expect(group.detail).toBe("1 function");
    expect(group.note).toContain("module-level");
    expect(group.note).toContain("wider scope");
    expect(node(s, "group:none>f")).toMatchObject({ ref: "f", note: NO_RUNTIME_NOTE });

    expect(s.edges).toEqual([
      { from: "co:main:co>co", to: "co:main:co>h", kind: "call", count: 1 },
      { from: "thread:main>main", to: "co:main:co", kind: "dispatch", count: 1, how: "await" },
      { from: "thread:main>main", to: "co:main:co>co", kind: "call", count: 1 },
      { from: "thread:main>main", to: "thread:main>a", kind: "call", count: 1 },
      { from: "thread:main>main", to: "thread:spawn:1", kind: "spawn", count: 1, how: "thread" },
    ]);
  });

  it("places a helper once per thread and keeps each thread's calls inside it", () => {
    const m = model({
      functions: [fn("main"), fn("work"), fn("h"), fn("cb", 9, { anonymous: true, parent: "main" })],
      threads: [
        mainThread({ roots: ["main"], reached: ["cb", "h", "main"], reach: 3 }),
        {
          id: "spawn:1",
          kind: "process",
          spawn: { node: "spawn:1", owner: "src/mod.ts", file: "src/mod.ts", line: 3, how: "process", status: "resolved", candidates: false },
          roots: ["work"],
          reach: 2,
          reached: ["h", "work"],
          coroutines: [],
          coroutineOnly: [],
        },
      ],
      calls: [
        ["main", "h"],
        ["work", "h"],
        ["main", "cb"],
      ],
      dispatches: [
        { from: "main", how: "callback", targets: ["cb"], candidates: true, file: "src/app.ts", line: 2 },
        { from: "main", how: "await", targets: ["h"], candidates: false, file: "src/app.ts", line: 3 },
      ],
    });
    const s = buildExecScene(m);
    const refs = [...s.nodes.values()].filter((n) => n.ref === "h").map((n) => n.id);
    expect(refs).toEqual(["thread:main>h", "thread:spawn:1>h"]);
    expect(node(s, "thread:main").children).toEqual(["thread:main>main", "thread:main>cb", "thread:main>h"]);
    expect(node(s, "thread:main>cb").note).toBe("An anonymous function written in main.");

    const spawned = node(s, "thread:spawn:1");
    expect(spawned.label).toBe("Process · work");
    expect(spawned.note).toBe("Spawned at src/mod.ts:3. Started by module-level code in src/mod.ts.");

    // No spawn edge: the owner is module-level code, which has no placement. The await dispatch is not same-thread.
    expect(s.edges).toEqual([
      { from: "thread:main>main", to: "thread:main>cb", kind: "call", count: 1 },
      { from: "thread:main>main", to: "thread:main>cb", kind: "dispatch", count: 1, how: "callback", candidate: true },
      { from: "thread:main>main", to: "thread:main>h", kind: "call", count: 1 },
      { from: "thread:spawn:1>work", to: "thread:spawn:1>h", kind: "call", count: 1 },
    ]);
  });

  it("nests a coroutine under its parent and draws a function both called and awaited twice", () => {
    const m = model({
      functions: [fn("main"), fn("outer"), fn("inner"), fn("b")],
      threads: [
        mainThread({
          roots: ["main"],
          reach: 4,
          reached: ["b", "inner", "main", "outer"],
          coroutineOnly: ["inner", "outer"],
          coroutines: [
            { target: "outer", how: "await", dispatchedBy: ["main"], callees: [] },
            { target: "inner", how: "start", parent: "outer", dispatchedBy: ["outer"], callees: [] },
            { target: "b", how: "await", dispatchedBy: ["main"], callees: [] },
          ],
        }),
      ],
      calls: [["main", "b"]],
    });
    const s = buildExecScene(m);
    expect(node(s, "thread:main").children).toEqual(["thread:main>main", "thread:main>b", "co:main:outer", "co:main:b"]);
    expect(node(s, "co:main:outer").children).toEqual(["co:main:outer>outer", "co:main:inner"]);
    expect(node(s, "co:main:inner")).toMatchObject({ parent: "co:main:outer", detail: "started", children: ["co:main:inner>inner"] });
    expect(node(s, "thread:main>b").ref).toBe("b");
    expect(node(s, "co:main:b>b").ref).toBe("b");

    expect(s.edges).toEqual([
      { from: "co:main:outer>outer", to: "co:main:inner", kind: "dispatch", count: 1, how: "start" },
      { from: "thread:main>main", to: "co:main:b", kind: "dispatch", count: 1, how: "await" },
      { from: "thread:main>main", to: "co:main:outer", kind: "dispatch", count: 1, how: "await" },
      // The call goes to the thread-level placement of b, not to the coroutine's.
      { from: "thread:main>main", to: "thread:main>b", kind: "call", count: 1 },
    ]);
  });

  it("does not depend on the order of the call pairs", () => {
    const m = basic();
    const reversed: ExecModel = { ...m, calls: [...m.calls].reverse() };
    const a = buildExecScene(m);
    const b = buildExecScene(reversed);
    expect([...b.nodes.entries()]).toEqual([...a.nodes.entries()]);
    expect(b.edges).toEqual(a.edges);
  });

  it("draws an unresolved spawn as an empty thread with a note", () => {
    const m = model({
      functions: [fn("main")],
      threads: [
        mainThread({ roots: ["main"], reached: ["main"], reach: 1 }),
        {
          id: "spawn:2",
          kind: "thread",
          spawn: { node: "spawn:2", owner: "main", file: "src/app.ts", line: 7, how: "thread", status: "unresolved", candidates: false },
          roots: [],
          reach: 0,
          reached: [],
          coroutines: [],
          coroutineOnly: [],
        },
        {
          id: "spawn:3",
          kind: "process",
          spawn: {
            node: "spawn:3",
            owner: "main",
            file: "src/app.ts",
            line: 8,
            how: "process",
            status: "outside",
            candidates: true,
            script: "workers/job.py",
          },
          roots: [],
          reach: 0,
          reached: [],
          coroutines: [],
          coroutineOnly: [],
        },
      ],
    });
    const s = buildExecScene(m);
    const stub = node(s, "thread:spawn:2");
    expect(stub.label).toBe("Thread · unresolved");
    expect(stub.children).toEqual([]);
    expect(stub.detail).toBe("0 functions");
    expect(stub.note).toBe("Spawned at src/app.ts:7. The spawn target could not be resolved.");
    const outside = node(s, "thread:spawn:3");
    expect(outside.label).toBe("Process · job.py");
    expect(outside.note).toContain("outside this scope");
    expect(outside.note).toContain("several possible targets");
    expect(s.edges).toEqual([
      { from: "thread:main>main", to: "thread:spawn:2", kind: "spawn", count: 1, how: "thread" },
      { from: "thread:main>main", to: "thread:spawn:3", kind: "spawn", count: 1, how: "process", candidate: true },
    ]);
  });

  it("leaves out the group when every function runs on a thread", () => {
    const m = model({
      functions: [fn("main")],
      threads: [mainThread({ roots: ["main"], reached: ["main"], reach: 1 })],
      scope: "src/app",
      truncated: true,
    });
    const s = buildExecScene(m);
    expect(s.nodes.has(NO_RUNTIME_GROUP)).toBe(false);
    const root = node(s, "program");
    expect(root.children).toEqual(["thread:main"]);
    expect(root.label).toBe("src/app");
    expect(root.detail).toBe("1 thread");
    expect(root.note).toContain("1 function");
  });

  it("links calls among unthreaded functions inside the group", () => {
    const m = model({
      functions: [fn("f", 1, { runtime: "none" }), fn("g", 2, { runtime: "none" })],
      threads: [mainThread({})],
      calls: [["f", "g"]],
      unthreaded: ["f", "g"],
    });
    const s = buildExecScene(m);
    expect(node(s, "group:none").children).toEqual(["group:none>f", "group:none>g"]);
    expect(s.edges).toEqual([{ from: "group:none>f", to: "group:none>g", kind: "call", count: 1 }]);
  });

  it("groups a large container's functions by file, root's file first, and keeps placement ids and calls", () => {
    // FILE_GROUP_MIN + 6 functions over three files. The root is in the last file by path, so its file comes first.
    const files = ["src/a.ts", "src/b.ts", "src/c.ts"];
    const fns = Array.from({ length: FILE_GROUP_MIN + 6 }, (_, i) => fn(`f${String(i).padStart(2, "0")}`, i + 1, { file: files[i % 3] as string }));
    const ids = fns.map((f) => f.id);
    const root = ids[2] as string; // in src/c.ts
    const m = model({
      functions: fns,
      threads: [mainThread({ roots: [root], reached: ids })],
      calls: [[root, ids[0] as string]], // c.ts -> a.ts, across file nodes
    });
    const s = buildExecScene(m);
    const t = node(s, "thread:main");
    expect(t.children).toEqual([execFileId("thread:main", "src/c.ts"), execFileId("thread:main", "src/a.ts"), execFileId("thread:main", "src/b.ts")]);
    const c = node(s, execFileId("thread:main", "src/c.ts"));
    expect(c).toMatchObject({ kind: "file", label: "c.ts", parent: "thread:main", note: "src/c.ts", detail: "10 functions" });
    // The root leads its file; the rest follow by id.
    expect(c.children[0]).toBe(execFnId("thread:main", root));
    // Placement ids name the thread, not the file node, so they do not depend on grouping.
    expect(node(s, execFnId("thread:main", ids[0] as string)).parent).toBe(execFileId("thread:main", "src/a.ts"));
    expect(s.edges).toEqual([{ from: execFnId("thread:main", root), to: execFnId("thread:main", ids[0] as string), kind: "call", count: 1 }]);
    expect(s.levels.file).toBeDefined();
  });

  it("does not group a container at or under FILE_GROUP_MIN functions, or one with a single file", () => {
    const small = Array.from({ length: FILE_GROUP_MIN }, (_, i) => fn(`s${i}`, i + 1, { file: i % 2 === 0 ? "src/a.ts" : "src/b.ts" }));
    const s1 = buildExecScene(model({ functions: small, threads: [mainThread({ reached: small.map((f) => f.id) })] }));
    expect([...s1.nodes.values()].some((n) => n.kind === "file")).toBe(false);
    const one = Array.from({ length: FILE_GROUP_MIN + 10 }, (_, i) => fn(`o${i}`, i + 1));
    const s2 = buildExecScene(model({ functions: one, threads: [mainThread({ reached: one.map((f) => f.id) })] }));
    expect([...s2.nodes.values()].some((n) => n.kind === "file")).toBe(false);
  });

  it("groups the no-runtime group by file too, and keeps the note on each function", () => {
    const fns = Array.from({ length: FILE_GROUP_MIN + 1 }, (_, i) => fn(`u${String(i).padStart(2, "0")}`, i + 1, { runtime: "none", file: i < 5 ? "src/x.ts" : "src/y.ts" }));
    const s = buildExecScene(model({ functions: fns, threads: [mainThread({})], unthreaded: fns.map((f) => f.id) }));
    expect(node(s, NO_RUNTIME_GROUP).children).toEqual([execFileId(NO_RUNTIME_GROUP, "src/x.ts"), execFileId(NO_RUNTIME_GROUP, "src/y.ts")]);
    expect(node(s, execFnId(NO_RUNTIME_GROUP, "u00")).note).toBe(NO_RUNTIME_NOTE);
  });
});

describe("buildExecScene with programs", () => {
  const spawnAt = (id: string, file: string, line: number, root: string): ExecThread => ({
    id,
    kind: "thread",
    spawn: { node: id, file, line, how: "thread", status: "resolved", candidates: false },
    roots: [root],
    reach: 1,
    reached: [root],
    coroutines: [],
    coroutineOnly: [],
  });

  // Two programs. The client spawns `w` (listed by client only) and `s`, which the server also lists because its main
  // reaches `s`'s spawn. `t` is a spawn in no program's files, so no program lists it.
  const programModel = (): ExecModel =>
    model({
      functions: [
        fn("client", 1, { file: "src/client/main.cc" }),
        fn("server", 10, { file: "src/server/main.cc" }),
        fn("w", 20, { file: "src/client/net.cc" }),
        fn("s", 30, { file: "src/core/core.cc" }),
        fn("t", 40, { file: "src/app.ts" }),
        fn("lone", 50, { file: "src/app.ts" }),
        fn("f", 60, { file: "src/app.ts", runtime: "none" }),
      ],
      threads: [
        mainThread({ roots: ["lone"], reach: 1, reached: ["lone"] }),
        mainThread({ id: "main:app:client", kind: "main", roots: ["client"], reach: 1, reached: ["client"] }),
        mainThread({ id: "main:app:server", kind: "main", roots: ["server"], reach: 1, reached: ["server"] }),
        spawnAt("spawn:1", "src/client/main.cc", 3, "w"),
        spawnAt("spawn:2", "src/core/core.cc", 4, "s"),
        spawnAt("spawn:3", "src/app.ts", 5, "t"),
      ],
      unthreaded: ["f"],
      programs: [
        {
          id: "app:client",
          name: "client",
          targetKind: "cc_binary",
          files: ["src/client/main.cc", "src/client/net.cc"],
          main: "client",
          threads: ["main:app:client", "spawn:1", "spawn:2"],
        },
        { id: "app:server", name: "server", targetKind: "cc_binary", files: ["src/server/main.cc"], main: "server", threads: ["main:app:server", "spawn:2"] },
      ],
    });

  it("roots the scene at the project, with one program node per program", () => {
    const s = buildExecScene(programModel());
    expect(s.root).toBe(EXEC_PROJECT_ROOT);
    expect(EXEC_PROJECT_ROOT).toBe("project");
    expect(node(s, "project")).toMatchObject({ kind: "project", label: "Project", detail: "2 programs", children: [
      execProgramId("app:client"),
      execProgramId("app:server"),
      "thread:main",
      "thread:spawn:3",
      NO_RUNTIME_GROUP,
    ] });
    expect(node(s, execProgramId("app:client"))).toMatchObject({ kind: "program", label: "client", parent: "project", detail: "cc_binary" });
    expect(node(s, execProgramId("app:client")).note).toBe("Built from 2 files. Main function: client. Shares 1 thread with other programs.");
    expect(node(s, execProgramId("app:server")).note).toBe("Built from 1 file. Main function: server. Shares 1 thread with other programs.");
    expect(s.levels.project).toEqual({ box: { w: 300, h: 64 }, layout: EXEC_LEVELS.program?.layout });
  });

  it("puts each thread under the first program that lists it, and the unlisted threads at the root", () => {
    const s = buildExecScene(programModel());
    expect(node(s, execProgramId("app:client")).children).toEqual(["thread:main:app:client", "thread:spawn:1", "thread:spawn:2"]);
    expect(node(s, execProgramId("app:server")).children).toEqual(["thread:main:app:server"]);
    expect(node(s, "thread:spawn:2").parent).toBe(execProgramId("app:client"));
    expect(node(s, "thread:main").parent).toBe("project");
    expect(node(s, "thread:spawn:3").parent).toBe("project");
    expect(node(s, NO_RUNTIME_GROUP).parent).toBe("project");
    // The shared thread is drawn once, so its functions appear once.
    expect([...s.nodes.values()].filter((n) => n.ref === "s")).toHaveLength(1);
  });

  it("keeps the spawn edges and the thread labels for the programs' threads", () => {
    const s = buildExecScene(programModel());
    expect(node(s, "thread:spawn:1")).toMatchObject({ label: "Thread · w", detail: "1 function" });
    expect(node(s, "thread:main:app:client")).toMatchObject({ label: "Main thread", parent: execProgramId("app:client") });
  });

  it("names the scope on the project root, and notes a program with no main and no shared thread", () => {
    const solo: ExecModel = model({
      scope: "src",
      functions: [fn("m", 1), fn("w", 20)],
      threads: [mainThread({ roots: ["m"], reach: 1, reached: ["m"] }), spawnAt("spawn:1", "src/x.py", 2, "w")],
      programs: [{ id: "lib:x", name: "x", targetKind: "py_binary", files: ["src/x.py"], threads: ["spawn:1"] }],
    });
    const s = buildExecScene(solo);
    expect(node(s, "project")).toMatchObject({ label: "src", detail: "1 program" });
    expect(node(s, execProgramId("lib:x")).note).toBe("Built from 1 file. No main function in the IR.");
    expect(node(s, "thread:spawn:1").parent).toBe(execProgramId("lib:x"));
  });

  it("keeps the program root when the model has no programs", () => {
    const s = buildExecScene(model({ functions: [fn("m", 1)], threads: [mainThread({ roots: ["m"], reach: 1, reached: ["m"] })] }));
    expect(s.root).toBe(EXEC_ROOT);
    expect(node(s, EXEC_ROOT)).toMatchObject({ kind: "program", label: "Program", detail: "1 thread" });
    expect([...s.nodes.keys()].some((id) => id.startsWith("prog:") || id === "project")).toBe(false);
  });
});

describe("buildExecScene: sync edges", () => {
  /** A thread that runs `reached` on its own, with an optional coroutine. */
  const worker = (id: string, reached: string[], extra: Partial<ExecThread> = {}): ExecThread => ({
    id,
    kind: "thread",
    roots: reached.slice(0, 1),
    reach: reached.length,
    reached: [...reached].sort(),
    coroutines: [],
    coroutineOnly: [],
    ...extra,
  });
  /** A resource whose sites are given as [fn, op] pairs, in the order they are listed. */
  const resource = (kind: "lock" | "channel", name: string, sites: [string, ExecResource["sites"][number]["op"]][], threads: string[] = []): ExecResource => ({
    id: `${kind}:${name}`,
    kind,
    name,
    threads,
    sites: sites.map(([fn, op], i) => ({ fn, op, file: "src/app.ts", line: i + 1 })),
  });
  const syncEdges = (s: Scene) => s.edges.filter((e) => e.kind === "sync");
  const at = (threadId: string, fn: string) => execFnId(execThreadId(threadId), fn);

  it("joins the threads that lock one mutex, from the first site in each thread", () => {
    // main locks m in m1 and m2; the worker locks m in w1. The first site in main is m1.
    const m = model({
      functions: [fn("m1", 1), fn("m2", 5), fn("w1", 10)],
      threads: [mainThread({ roots: ["m1", "m2"], reach: 2, reached: ["m1", "m2"] }), worker("spawn:1", ["w1"])],
      resources: [resource("lock", "m", [["m1", "acquire"], ["m2", "acquire"], ["w1", "acquire"]], ["main", "spawn:1"])],
    });
    const s = buildExecScene(m);
    expect(syncEdges(s)).toEqual([{ from: at("main", "m1"), to: at("spawn:1", "w1"), kind: "sync", count: 1, how: "lock" }]);
  });

  it("draws no sync edge for a lock that only one thread uses", () => {
    const m = model({
      functions: [fn("m1", 1), fn("w1", 10)],
      threads: [mainThread({ roots: ["m1"], reach: 1, reached: ["m1"] }), worker("spawn:1", ["w1"])],
      resources: [resource("lock", "solo", [["m1", "acquire"]], ["main"])],
    });
    expect(syncEdges(buildExecScene(m))).toEqual([]);
  });

  it("gives one edge per pair of threads in thread order, and counts the resources that join the same pair", () => {
    // Three threads lock m: main to t1, main to t2, t1 to t2. Lock n joins main and t1 too: that pair's count is 2.
    const m = model({
      functions: [fn("m1", 1), fn("a1", 5), fn("a2", 9)],
      threads: [
        mainThread({ roots: ["m1"], reach: 1, reached: ["m1"] }),
        worker("t1", ["a1"]),
        worker("t2", ["a2"]),
      ],
      resources: [
        resource("lock", "m", [["m1", "acquire"], ["a1", "acquire"], ["a2", "acquire"]], ["main", "t1", "t2"]),
        resource("lock", "n", [["m1", "acquire"], ["a1", "acquire"]], ["main", "t1"]),
      ],
    });
    const edges = syncEdges(buildExecScene(m));
    expect(edges.map((e) => [e.from, e.to, e.count, e.how])).toEqual([
      [at("main", "m1"), at("t1", "a1"), 2, "lock"],
      [at("main", "m1"), at("t2", "a2"), 1, "lock"],
      [at("t1", "a1"), at("t2", "a2"), 1, "lock"],
    ]);
  });

  it("points a channel from each thread that sends to each other thread that receives, and not back", () => {
    // main sends on jobs in m1. Workers t1 and t2 receive in r1 and r2; t2 also sends in s2 but nothing receives from it.
    const m = model({
      functions: [fn("m1", 1), fn("r1", 5), fn("r2", 9), fn("s2", 12)],
      threads: [mainThread({ roots: ["m1"], reach: 1, reached: ["m1"] }), worker("t1", ["r1"]), worker("t2", ["r2", "s2"])],
      resources: [resource("channel", "jobs", [["m1", "send"], ["r1", "recv"], ["r2", "recv"], ["s2", "send"]], ["main", "t1", "t2"])],
    });
    const edges = syncEdges(buildExecScene(m));
    expect(edges.map((e) => [e.from, e.to, e.how, e.count])).toEqual([
      [at("main", "m1"), at("t1", "r1"), "channel", 1],
      [at("main", "m1"), at("t2", "r2"), "channel", 1],
      [at("t2", "s2"), at("t1", "r1"), "channel", 1],
    ]);
    expect(edges.some((e) => e.from === at("t1", "r1"))).toBe(false);
  });

  it("gives no channel edge when the channel has senders and no receiver in another thread", () => {
    const m = model({
      functions: [fn("m1", 1), fn("s2", 5)],
      threads: [mainThread({ roots: ["m1"], reach: 1, reached: ["m1"] }), worker("t1", ["s2"])],
      resources: [resource("channel", "out", [["m1", "send"], ["s2", "send"]], ["main", "t1"])],
    });
    expect(syncEdges(buildExecScene(m))).toEqual([]);
  });

  it("keeps a lock edge and a channel edge on the same pair of placements as two edges", () => {
    const m = model({
      functions: [fn("m1", 1), fn("w1", 5)],
      threads: [mainThread({ roots: ["m1"], reach: 1, reached: ["m1"] }), worker("t1", ["w1"])],
      resources: [
        resource("channel", "jobs", [["m1", "send"], ["w1", "recv"]], ["main", "t1"]),
        resource("lock", "m", [["m1", "acquire"], ["w1", "acquire"]], ["main", "t1"]),
      ],
    });
    expect(syncEdges(buildExecScene(m)).map((e) => [e.how, e.count])).toEqual([
      ["channel", 1],
      ["lock", 1],
    ]);
  });

  it("links a site a thread runs only through a coroutine to its placement in that coroutine", () => {
    const coroutine = { target: "w2", how: "await" as const, dispatchedBy: ["w1"], callees: [] };
    const m = model({
      functions: [fn("m1", 1), fn("w1", 5), fn("w2", 9, { runtime: "coroutine" })],
      threads: [
        mainThread({ roots: ["m1"], reach: 1, reached: ["m1"] }),
        worker("t1", ["w1", "w2"], { coroutines: [coroutine], coroutineOnly: ["w2"] }),
      ],
      resources: [resource("lock", "m", [["m1", "acquire"], ["w2", "acquire"]], ["main", "t1"])],
    });
    const s = buildExecScene(m);
    expect(syncEdges(s)).toEqual([{ from: at("main", "m1"), to: execFnId(execCoroutineId("t1", "w2"), "w2"), kind: "sync", count: 1, how: "lock" }]);
    expect(s.nodes.has(execFnId(execCoroutineId("t1", "w2"), "w2"))).toBe(true);
  });

  it("caps the sync edges one resource adds at MAX_SYNC_EDGES_PER_RESOURCE, in the order the pairs are made", () => {
    // Twelve threads all lock m: 66 pairs. The first 50 made are kept: main's eleven, then t1's ten, and so on down to t5,
    // whose run is cut after t10.
    const threads = [mainThread({ roots: ["f0"], reach: 1, reached: ["f0"] })];
    const functions = [fn("f0", 1)];
    for (let i = 1; i < 12; i++) {
      functions.push(fn(`f${i}`, i + 1));
      threads.push(worker(`t${i}`, [`f${i}`]));
    }
    const m = model({
      functions,
      threads,
      resources: [resource("lock", "m", functions.map((f) => [f.id, "acquire"] as [string, "acquire"]), threads.map((t) => t.id))],
    });
    const edges = syncEdges(buildExecScene(m));
    expect(MAX_SYNC_EDGES_PER_RESOURCE).toBe(50);
    expect(edges).toHaveLength(50);
    expect(edges.reduce((n, e) => n + e.count, 0)).toBe(50);
    // Main's eleven pairs come first, then thread 1's ten, and the cut falls inside thread 3's run.
    const pairs = new Set(edges.map((e) => `${e.from}|${e.to}`));
    expect(pairs.has(`${at("main", "f0")}|${at("t11", "f11")}`)).toBe(true);
    expect(pairs.has(`${at("t5", "f5")}|${at("t10", "f10")}`)).toBe(true);
    expect(pairs.has(`${at("t5", "f5")}|${at("t11", "f11")}`)).toBe(false);
    expect(pairs.has(`${at("t6", "f6")}|${at("t7", "f7")}`)).toBe(false);
  });

  it("draws no sync edge when the model has no resources", () => {
    const m = model({
      functions: [fn("m1", 1), fn("w1", 5)],
      threads: [mainThread({ roots: ["m1"], reach: 1, reached: ["m1"] }), worker("t1", ["w1"])],
    });
    expect(syncEdges(buildExecScene(m))).toEqual([]);
  });
});
