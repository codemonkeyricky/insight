import { describe, expect, it } from "vitest";
import type { IREdge, IRNode } from "@insight/ir";
import { MAX_EXEC_FUNCTIONS, execModel, insideScope, isNoisePath, type ExecModel } from "../src/index.js";
import { PROVENANCE, callEdge, fnNode } from "./synthetic.js";

/** The id a spawn node gets in these tests: its file and its 0-based line. */
const spawnId = (file: string, line: number) => `${file}@spawn:${line + 1}:2`;
const spanAt = (file: string, line: number) => ({ file, start: [line, 2] as [number, number], end: [line, 8] as [number, number] });

/** A spawn node on `line` of `file`, started by `owner`, a function id or a file id. */
function spawnNode(file: string, line: number, owner: string, kind = "concurrency.spawn-thread"): IRNode {
  return { id: spawnId(file, line), facet: "concurrency", kind, parent: owner, span: spanAt(file, line), attrs: {}, provenance: PROVENANCE };
}

/** The spawns edge of the spawn on `line` of `file`. The frontend emits it only when the target resolves. */
function spawnEdge(file: string, line: number, to: IREdge["to"], how = "thread"): IREdge {
  return { from: spawnId(file, line), to, facet: "concurrency", kind: "concurrency.spawns", attrs: { how }, span: spanAt(file, line), provenance: PROVENANCE };
}

/** A dispatch edge: `from` runs `to` by `how`, on `line` of `file`. */
function dispatchEdge(from: string, to: IREdge["to"], how: string, file: string, line: number): IREdge {
  return { from, to, facet: "concurrency", kind: "concurrency.dispatches", attrs: { how }, span: spanAt(file, line), provenance: PROVENANCE };
}

/** A build target, as the Bazel and CMake frontends emit it: `targetKind` is the rule or command. */
function targetNode(id: string, targetKind: string, name = id.split(":")[1] ?? id): IRNode {
  return { id, facet: "packaging", kind: "packaging.build-target", attrs: { name, label: id, targetKind, source: "static" }, provenance: PROVENANCE };
}
/** The target contains the file. The frontends emit one edge per source. */
function containsEdge(target: string, file: string): IREdge {
  return { from: target, to: file, facet: "packaging", kind: "packaging.target-contains", provenance: PROVENANCE };
}

const names = (m: ExecModel, ids: readonly string[]) => ids.map((id) => m.functions.find((f) => f.id === id)?.name ?? id);

/** The id of the anonymous function on `line` of `file`. Its name is `λ<line>:3`, as the frontends write it. */
const anonId = (file: string, line: number) => `${file}#λ${line + 1}:3`;
/** An anonymous function on `line` of `file`, written in `parent`: a function id, or the file for module-level code. */
function anonNode(file: string, line: number, parent: string): IRNode {
  const name = `λ${line + 1}:3`;
  return { ...fnNode(file, name, line), parent, attrs: { name, anonymous: true } };
}
/** A closure edge: `from` creates the anonymous function `to`, on `line` of `file`. */
function closureEdge(from: string, to: string, file: string, line: number): IREdge {
  return { from, to, facet: "calls", kind: "calls.reference", span: spanAt(file, line), attrs: { how: "closure" }, provenance: PROVENANCE };
}
/** Each listed function's runtime, by id. A function the model does not list runs on no thread. */
const runtimes = (m: ExecModel): Record<string, string> => Object.fromEntries(m.functions.map((f) => [f.id, f.runtime]));
const runtimeIn = (m: ExecModel, id: string): string => m.functions.find((f) => f.id === id)?.runtime ?? "none";

describe("execModel: threads", () => {
  it("lists the main thread with its two callees", () => {
    const nodes = [fnNode("src/m.ts", "main", 0), fnNode("src/m.ts", "a", 4), fnNode("src/m.ts", "b", 8)];
    const edges = [callEdge("src/m.ts#main", "src/m.ts#a", "src/m.ts", 1), callEdge("src/m.ts#main", "src/m.ts#b", "src/m.ts", 2)];
    const model = execModel(nodes, edges, "src");
    expect(model.threads).toHaveLength(1);
    expect(model.threads[0]).toMatchObject({ id: "main", kind: "main", roots: ["src/m.ts#main"], reach: 3 });
    expect(model.threads[0]?.reached).toEqual(["src/m.ts#a", "src/m.ts#b", "src/m.ts#main"]);
    expect(model.stats).toMatchObject({ threads: 1, spawns: 0, functionsInScope: 3, functionsThreaded: 3, functionsUnthreaded: 0 });
    expect(model.truncated).toBe(false);
  });

  it("starts a thread at a resolved function spawn, and keeps the spawned function out of the main roots", () => {
    const nodes = [
      fnNode("src/app.ts", "main", 0),
      spawnNode("src/app.ts", 3, "src/app.ts#main"),
      fnNode("src/w.ts", "work", 0),
      fnNode("src/w.ts", "helper", 4),
    ];
    const edges = [callEdge("src/w.ts#work", "src/w.ts#helper", "src/w.ts", 1), spawnEdge("src/app.ts", 3, "src/w.ts#work")];
    const model = execModel(nodes, edges, "src");
    expect(model.threads).toHaveLength(2);
    expect(model.threads[0]?.roots).toEqual(["src/app.ts#main"]);
    expect(model.threads[1]).toMatchObject({
      id: spawnId("src/app.ts", 3),
      kind: "thread",
      roots: ["src/w.ts#work"],
      reach: 2,
      reached: ["src/w.ts#helper", "src/w.ts#work"],
      spawn: { node: spawnId("src/app.ts", 3), owner: "src/app.ts#main", file: "src/app.ts", line: 4, how: "thread", status: "resolved", candidates: false },
    });
    expect(model.stats).toMatchObject({ threads: 2, spawns: 1, resolved: 1, outside: 0, unresolved: 0 });
  });

  it("starts a script's thread at the functions its top-level code calls", () => {
    const nodes = [
      fnNode("src/main.ts", "main", 0),
      spawnNode("src/main.ts", 2, "src/main.ts#main"),
      fnNode("src/worker.ts", "run", 0),
      fnNode("src/worker.ts", "step", 4),
    ];
    const edges = [
      // Module-level code of the worker calls `run`. The worker file is the caller.
      callEdge("src/worker.ts", "src/worker.ts#run", "src/worker.ts", 9),
      callEdge("src/worker.ts#run", "src/worker.ts#step", "src/worker.ts", 1),
      spawnEdge("src/main.ts", 2, "src/worker.ts"),
    ];
    const model = execModel(nodes, edges, "");
    const worker = model.threads[1];
    expect(worker?.spawn).toMatchObject({ script: "src/worker.ts", status: "resolved" });
    expect(worker?.roots).toEqual(["src/worker.ts#run"]);
    expect(worker?.reached).toEqual(["src/worker.ts#run", "src/worker.ts#step"]);
  });

  it("gives a spawn with several candidate targets one root per candidate", () => {
    const nodes = [fnNode("src/m.ts", "main", 0), spawnNode("src/m.ts", 2, "src/m.ts#main"), fnNode("src/a.ts", "a", 0), fnNode("src/b.ts", "b", 0)];
    const edges = [spawnEdge("src/m.ts", 2, { candidates: ["src/a.ts#a", "src/b.ts#b"] })];
    const model = execModel(nodes, edges, "");
    expect(model.threads[1]?.roots).toEqual(["src/a.ts#a", "src/b.ts#b"]);
    expect(model.threads[1]?.spawn).toMatchObject({ candidates: true, status: "resolved" });
    expect(model.stats.candidates).toBe(1);
  });

  it("keeps a spawn with no resolved target as a thread with no roots", () => {
    // No spawns edge: the frontend leaves an unresolved target as a string on the spawn node.
    const nodes = [fnNode("src/m.ts", "main", 0), spawnNode("src/m.ts", 2, "src/m.ts#main")];
    const model = execModel(nodes, [], "");
    expect(model.threads).toHaveLength(2);
    expect(model.threads[1]).toMatchObject({ roots: [], reach: 0, spawn: { status: "unresolved", candidates: false } });
    expect(model.stats).toMatchObject({ spawns: 1, unresolved: 1 });
  });

  it("lists a function once and in every thread that runs it", () => {
    const nodes = [
      fnNode("src/m.ts", "main", 0),
      spawnNode("src/m.ts", 2, "src/m.ts#main"),
      spawnNode("src/m.ts", 3, "src/m.ts#main"),
      fnNode("src/s.ts", "shared", 0),
    ];
    const edges = [spawnEdge("src/m.ts", 2, "src/s.ts#shared"), spawnEdge("src/m.ts", 3, "src/s.ts#shared", "process")];
    const model = execModel(nodes, edges, "");
    expect(model.threads).toHaveLength(3);
    expect(model.threads[1]?.reached).toContain("src/s.ts#shared");
    expect(model.threads[2]).toMatchObject({ kind: "process", reached: ["src/s.ts#shared"] });
    expect(model.functions.filter((f) => f.id === "src/s.ts#shared")).toHaveLength(1);
  });
});

describe("execModel: coroutines", () => {
  const nodes = [
    fnNode("src/c.ts", "main", 0),
    fnNode("src/c.ts", "co", 4),
    fnNode("src/c.ts", "mid", 8),
    fnNode("src/c.ts", "leaf", 12),
    fnNode("src/c.ts", "inner", 16),
    fnNode("src/c.ts", "innerLeaf", 20),
  ];

  it("nests an awaited coroutine's callees under the coroutine that awaits it", () => {
    const edges = [
      dispatchEdge("src/c.ts#main", "src/c.ts#co", "await", "src/c.ts", 1),
      callEdge("src/c.ts#co", "src/c.ts#mid", "src/c.ts", 5),
      callEdge("src/c.ts#mid", "src/c.ts#leaf", "src/c.ts", 13),
      dispatchEdge("src/c.ts#co", "src/c.ts#inner", "await", "src/c.ts", 6),
      callEdge("src/c.ts#inner", "src/c.ts#innerLeaf", "src/c.ts", 9),
    ];
    const model = execModel(nodes, edges, "");
    const main = model.threads[0];
    expect(main?.coroutines).toEqual([
      { target: "src/c.ts#co", how: "await", dispatchedBy: ["src/c.ts#main"], callees: ["src/c.ts#leaf", "src/c.ts#mid"] },
      { target: "src/c.ts#inner", how: "await", parent: "src/c.ts#co", dispatchedBy: ["src/c.ts#co"], callees: ["src/c.ts#innerLeaf"] },
    ]);
    // The thread runs the coroutines too, so the awaited functions are in its reach.
    expect(main?.reach).toBe(6);
    // Dispatches come in edge order, which sorts by source, so `co` precedes `main`.
    expect(model.dispatches.map((d) => [d.from, d.how, d.targets])).toEqual([
      ["src/c.ts#co", "await", ["src/c.ts#inner"]],
      ["src/c.ts#main", "await", ["src/c.ts#co"]],
    ]);
    expect(model.stats).toMatchObject({ coroutines: 2, dispatches: 2, functionsThreaded: 6, functionsCoroutineOnly: 5, functionsUnthreaded: 0 });
  });

  it("cuts a cycle of awaits, and lists each coroutine that dispatches into the cycle", () => {
    const cyc = [fnNode("src/cyc.ts", "d", 0), fnNode("src/cyc.ts", "a", 4), fnNode("src/cyc.ts", "b", 8)];
    const at = (name: string) => `src/cyc.ts#${name}`;
    const edges = [
      dispatchEdge(at("d"), at("a"), "await", "src/cyc.ts", 1),
      callEdge(at("a"), at("b"), "src/cyc.ts", 5),
      callEdge(at("b"), at("a"), "src/cyc.ts", 9),
      dispatchEdge(at("b"), at("a"), "await", "src/cyc.ts", 10),
    ];
    const model = execModel(cyc, edges, "");
    expect(model.threads[0]?.roots).toEqual([at("d")]);
    expect(model.threads[0]?.reach).toBe(3);
    expect(model.threads[0]?.coroutines).toEqual([{ target: at("a"), how: "await", dispatchedBy: [at("b"), at("d")], callees: [at("b")] }]);
  });
});

describe("execModel: scope rules", () => {
  const nodes = [fnNode("src/a.ts", "main", 0), fnNode("tests/t.test.ts", "it", 0), fnNode("tests/t.test.ts", "helper", 4), fnNode("samples/demo.ts", "demo", 0)];
  const edges = [callEdge("tests/t.test.ts#it", "tests/t.test.ts#helper", "tests/t.test.ts", 1)];

  it("leaves test and sample code out of the main roots of a project scope", () => {
    const model = execModel(nodes, edges, "");
    expect(model.threads[0]?.roots).toEqual(["src/a.ts#main"]);
    expect(model.stats.functionsInScope).toBe(4);
    // Test code is listed only where it is in scope and some thread runs it, so look at its own folder.
    const tests = execModel(nodes, edges, "tests");
    expect(tests.functions.find((f) => f.id === "tests/t.test.ts#it")).toMatchObject({ noise: true });
    expect(tests.functions.find((f) => f.id === "tests/t.test.ts#helper")).toMatchObject({ noise: true });
  });

  it("keeps a test or sample folder's own functions as roots when that folder is the scope", () => {
    expect(execModel(nodes, edges, "tests").threads[0]?.roots).toEqual(["tests/t.test.ts#it"]);
    expect(execModel(nodes, edges, "samples").threads[0]?.roots).toEqual(["samples/demo.ts#demo"]);
    expect(execModel(nodes, edges, "src").threads[0]?.roots).toEqual(["src/a.ts#main"]);
  });

  it("leaves a function called only from module-level code in no thread (the known gap)", () => {
    // `helper` is referenced by its file, so it is no main root, and nothing else starts it. A script's `main()` call
    // at the bottom of the file is this case. Listed here so a change to the rule shows up.
    const script = [fnNode("src/s.ts", "helper", 0)];
    const model = execModel(script, [callEdge("src/s.ts", "src/s.ts#helper", "src/s.ts", 10)], "");
    expect(model.threads[0]?.roots).toEqual([]);
    expect(model.stats).toMatchObject({ functionsInScope: 1, functionsThreaded: 0, functionsUnthreaded: 1 });
  });
});

describe("execModel: limits and ordering", () => {
  const chain = Array.from({ length: 6 }, (_, i) => fnNode("src/chain.ts", `f${i}`, i * 4));
  const chainEdges = Array.from({ length: 5 }, (_, i) => callEdge(`src/chain.ts#f${i}`, `src/chain.ts#f${i + 1}`, "src/chain.ts", i * 4 + 1));

  it("cuts the function lists at the cap, sets truncated, and keeps the exact reach", () => {
    const model = execModel(chain, chainEdges, "", { maxFunctions: 3 });
    expect(model.truncated).toBe(true);
    expect(model.functions).toHaveLength(3);
    expect(model.threads[0]).toMatchObject({ roots: ["src/chain.ts#f0"], reach: 6 });
    expect(model.threads[0]?.reached).toHaveLength(3);
    expect(model.stats).toMatchObject({ functionsListed: 3, functionsThreaded: 6 });
  });

  it("is not truncated under the default cap", () => {
    const model = execModel(chain, chainEdges, "");
    expect(MAX_EXEC_FUNCTIONS).toBeGreaterThan(6);
    expect(model.truncated).toBe(false);
    expect(model.threads[0]?.reached).toHaveLength(6);
  });

  it("has only the main thread, with nothing in it, for an empty project", () => {
    const model = execModel([], [], "");
    expect(model).toMatchObject({ truncated: false, functions: [], dispatches: [] });
    expect(model.threads).toEqual([{ id: "main", kind: "main", roots: [], reach: 0, reached: [], coroutines: [], coroutineOnly: [] }]);
    expect(model).toMatchObject({ calls: [], unthreaded: [] });
    expect(model.stats).toMatchObject({ threads: 1, spawns: 0, functionsInScope: 0, functionsThreaded: 0 });
  });

  it("gives the same model whatever order the nodes and edges arrive in", () => {
    const threadNodes = [fnNode("src/m.ts", "main", 0), spawnNode("src/m.ts", 2, "src/m.ts#main"), fnNode("src/w.ts", "work", 0), fnNode("src/w.ts", "helper", 4)];
    const threadEdges = [
      callEdge("src/w.ts#work", "src/w.ts#helper", "src/w.ts", 1),
      spawnEdge("src/m.ts", 2, "src/w.ts#work"),
      dispatchEdge("src/m.ts#main", "src/w.ts#helper", "timer", "src/m.ts", 1),
    ];
    expect(execModel([...threadNodes].reverse(), [...threadEdges].reverse(), "")).toEqual(execModel(threadNodes, threadEdges, ""));
  });
});

describe("execModel across nested scopes", () => {
  const NODES: IRNode[] = [
    fnNode("app/src/index.ts", "main", 0),
    fnNode("app/src/index.ts", "parse", 4),
    fnNode("app/src/index.ts", "helper", 8),
    fnNode("app/src/lex.ts", "lex", 0),
    fnNode("lib/format.ts", "format", 0),
    fnNode("lib/format.ts", "pad", 4),
    fnNode("lib/work.ts", "work", 0),
    fnNode("lib/work.ts", "step", 4),
    fnNode("lib/strings.ts", "trim", 0),
    fnNode("tests/index.test.ts", "it", 0),
    fnNode("src/boot.ts", "start", 0),
    fnNode("src/boot.ts", "stop", 4),
    spawnNode("app/src/index.ts", 12, "app/src/index.ts#main"),
    spawnNode("lib/work.ts", 9, "lib/work.ts#work", "concurrency.spawn-process"),
    spawnNode("tests/index.test.ts", 3, "tests/index.test.ts#it"),
    spawnNode("src/boot.ts", 14, "src/boot.ts"),
    anonNode("app/src/index.ts", 3, "app/src/index.ts#main"),
    anonNode("lib/format.ts", 6, "lib/format.ts#format"),
    spawnNode("lib/format.ts", 6, "lib/format.ts#format"),
  ];
  const EDGES: IREdge[] = [
    callEdge("app/src/index.ts#main", "app/src/index.ts#parse", "app/src/index.ts", 1),
    callEdge("app/src/index.ts#main", "lib/format.ts#format", "app/src/index.ts", 2),
    callEdge("app/src/index.ts#parse", "app/src/lex.ts#lex", "app/src/index.ts", 5),
    callEdge("lib/format.ts#format", "lib/format.ts#pad", "lib/format.ts", 1),
    callEdge("lib/work.ts#work", "lib/work.ts#step", "lib/work.ts", 5),
    callEdge("lib/strings.ts", "lib/strings.ts#trim", "lib/strings.ts", 1),
    callEdge("tests/index.test.ts#it", "app/src/index.ts#main", "tests/index.test.ts", 1),
    callEdge("src/boot.ts", "src/boot.ts#start", "src/boot.ts", 10),
    dispatchEdge("app/src/index.ts#main", "lib/format.ts#format", "await", "app/src/index.ts", 2),
    dispatchEdge("src/boot.ts", "src/boot.ts#stop", "timer", "src/boot.ts", 11),
    spawnEdge("app/src/index.ts", 12, "lib/work.ts#work"),
    spawnEdge("lib/work.ts", 9, "app/src/index.ts#parse", "process"),
    spawnEdge("tests/index.test.ts", 3, "lib/format.ts#pad"),
    spawnEdge("src/boot.ts", 14, "lib/strings.ts"),
    // A lambda main creates and passes to a call, and one a format spawns on its own thread.
    closureEdge("app/src/index.ts#main", anonId("app/src/index.ts", 3), "app/src/index.ts", 3),
    callEdge(anonId("app/src/index.ts", 3), "app/src/lex.ts#lex", "app/src/index.ts", 3),
    closureEdge("lib/format.ts#format", anonId("lib/format.ts", 6), "lib/format.ts", 6),
    spawnEdge("lib/format.ts", 6, anonId("lib/format.ts", 6)),
    callEdge(anonId("lib/format.ts", 6), "lib/work.ts#step", "lib/format.ts", 7),
  ];
  const SCOPES = [
    "app/src/lex.ts",
    "app/src/index.ts",
    "app/src",
    "app",
    "lib/format.ts",
    "lib/work.ts",
    "lib/strings.ts",
    "lib",
    "tests/index.test.ts",
    "tests",
    "src/boot.ts",
    "src",
    "",
  ];
  /** Every pair where the narrow scope lies inside the wide one. */
  const nested = SCOPES.flatMap((narrow) => SCOPES.filter((wide) => wide !== narrow && insideScope(narrow, wide)).map((wide) => [narrow, wide] as const));
  const fileOf = (m: ExecModel) => new Map(m.functions.map((f) => [f.id, f.file] as const));

  it("keeps a main root of a wide scope a main root of every narrower scope that holds it", () => {
    expect(nested.length).toBeGreaterThan(0);
    for (const [narrow, wide] of nested) {
      const inner = execModel(NODES, EDGES, narrow);
      const outer = execModel(NODES, EDGES, wide);
      const innerRoots = new Set(inner.threads[0]?.roots);
      const files = fileOf(outer);
      for (const id of outer.threads[0]?.roots ?? []) {
        if (!insideScope(files.get(id) ?? "", narrow)) continue;
        expect(innerRoots.has(id), `${id} is a main root of ${wide || "the project"} but not of ${narrow}`).toBe(true);
      }
    }
  });

  it("shows a spawn thread with the same roots, reach and coroutines in every scope that holds its spawn", () => {
    for (const [narrow, wide] of nested) {
      const inner = execModel(NODES, EDGES, narrow);
      const outer = execModel(NODES, EDGES, wide);
      for (const t of inner.threads.filter((x) => x.spawn !== undefined)) {
        const same = outer.threads.find((x) => x.id === t.id);
        expect(same, `thread ${t.id} of ${narrow} is missing from ${wide || "the project"}`).toBeDefined();
        expect(same).toMatchObject({ roots: t.roots, reach: t.reach, reached: t.reached, coroutines: t.coroutines });
      }
    }
  });

  it("never lists fewer spawns, functions or dispatches as the scope widens", () => {
    for (const [narrow, wide] of nested) {
      const inner = execModel(NODES, EDGES, narrow);
      const outer = execModel(NODES, EDGES, wide);
      expect(inner.stats.spawns, `${narrow} vs ${wide}`).toBeLessThanOrEqual(outer.stats.spawns);
      expect(inner.stats.functionsInScope, `${narrow} vs ${wide}`).toBeLessThanOrEqual(outer.stats.functionsInScope);
      expect(outer.dispatches).toEqual(expect.arrayContaining(inner.dispatches));
    }
  });

  const inScopeIds = (scope: string) => NODES.filter((n) => n.kind === "structure.function" && insideScope(n.span?.file ?? "", scope)).map((n) => n.id);
  /** Whether a scope applies the test-folder rules, as execModel reads them. */
  const noiseScope = (s: string) => isNoisePath(s) || isNoisePath(`${s}/`);

  it("keeps a function a narrower scope runs on a thread on a thread or as a coroutine in every wider scope", () => {
    let checked = 0;
    for (const [narrow, wide] of nested) {
      const inner = execModel(NODES, EDGES, narrow);
      const outer = execModel(NODES, EDGES, wide);
      for (const f of inner.functions) {
        if (f.runtime !== "thread") continue;
        // Test code is a root only where its folder is the scope, so a project does not root its tests' callees.
        // See "roots a function only a test calls in a project".
        if (f.noise && !noiseScope(wide)) continue;
        checked++;
        expect(["thread", "coroutine"], `${f.id} runs on a thread in ${narrow} but not in ${wide || "the project"}`).toContain(runtimeIn(outer, f.id));
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("gives a function no thread of a narrower scope runs a thread in a wider one only through a thread or root the wider one adds", () => {
    // The trim case: src/boot.ts's spawn runs lib/strings.ts, a script whose call is trim. That spawn lies in "" and
    // "src" but not in "lib", so trim is on no thread in "lib" and on the spawn's thread in "". The spawn is the thread added.
    for (const [narrow, wide] of nested) {
      const inner = execModel(NODES, EDGES, narrow);
      const outer = execModel(NODES, EDGES, wide);
      const innerIds = new Set(inner.threads.map((t) => t.id));
      const innerMain = inner.threads[0]?.reached ?? [];
      const outerMain = outer.threads[0]?.reached ?? [];
      const gained = new Set([
        ...outer.threads.filter((t) => !innerIds.has(t.id)).flatMap((t) => t.reached),
        ...outerMain.filter((id) => !innerMain.includes(id)),
      ]);
      for (const id of inScopeIds(narrow)) {
        if (runtimeIn(inner, id) !== "none" || runtimeIn(outer, id) !== "thread") continue;
        expect(gained.has(id), `${id} runs on no thread in ${narrow} and on one in ${wide || "the project"}, with no thread or root added there`).toBe(true);
      }
    }
  });
});

describe("execModel: anonymous functions and runtime", () => {
  it("runs a spawned lambda on its own thread, and its creator does not reach the lambda", () => {
    const file = "src/app.ts";
    const main = `${file}#main`;
    const lam = anonId(file, 2);
    const nodes = [fnNode(file, "main", 0), anonNode(file, 2, main), spawnNode(file, 2, main), fnNode("src/w.ts", "work", 0), fnNode("src/w.ts", "helper", 4)];
    const edges = [closureEdge(main, lam, file, 2), spawnEdge(file, 2, lam), callEdge(lam, "src/w.ts#work", file, 3), callEdge("src/w.ts#work", "src/w.ts#helper", "src/w.ts", 1)];
    const model = execModel(nodes, edges, "");
    expect(model.threads).toHaveLength(2);
    // The closure is the spawn's target, so the main thread stops at its creator.
    expect(model.threads[0]).toMatchObject({ roots: [main], reach: 1, reached: [main] });
    expect(model.threads[1]).toMatchObject({
      roots: [lam],
      reach: 3,
      reached: [lam, "src/w.ts#helper", "src/w.ts#work"],
      spawn: { status: "resolved", how: "thread" },
    });
    expect(model.functions.find((f) => f.id === lam)).toEqual({ id: lam, name: "λ3:3", file, line: 3, inScope: true, anonymous: true, parent: main, runtime: "thread" });
    expect(model.stats).toMatchObject({ functionsInScope: 4, functionsThreaded: 4, functionsCoroutineOnly: 0, functionsUnthreaded: 0 });
  });

  it("runs an awaited lambda as a coroutine, not on the thread", () => {
    const file = "src/a.ts";
    const main = `${file}#main`;
    const lam = anonId(file, 2);
    const helper = `${file}#helper`;
    const nodes = [fnNode(file, "main", 0), anonNode(file, 2, main), fnNode(file, "helper", 4)];
    const edges = [closureEdge(main, lam, file, 2), dispatchEdge(main, lam, "await", file, 2), callEdge(lam, helper, file, 3)];
    const model = execModel(nodes, edges, "");
    expect(model.threads[0]).toMatchObject({ roots: [main], reach: 3 });
    expect(model.threads[0]?.coroutines).toEqual([{ target: lam, how: "await", dispatchedBy: [main], callees: [helper] }]);
    expect(runtimes(model)).toEqual({ [main]: "thread", [lam]: "coroutine", [helper]: "coroutine" });
    expect(model.stats).toMatchObject({ functionsThreaded: 3, functionsCoroutineOnly: 2, functionsUnthreaded: 0 });
  });

  // The TypeScript frontend emits .then as a callback, and setTimeout as a timer, so both run on the dispatching thread.
  it.each(["callback", "timer", "microtask"] as const)("runs the lambda of a %s dispatch on the dispatching thread", (how) => {
    const file = "src/a.ts";
    const main = `${file}#main`;
    const lam = anonId(file, 2);
    const after = `${file}#after`;
    const nodes = [fnNode(file, "main", 0), anonNode(file, 2, main), fnNode(file, "after", 4)];
    const edges = [closureEdge(main, lam, file, 2), dispatchEdge(main, lam, how, file, 2), callEdge(lam, after, file, 3)];
    const model = execModel(nodes, edges, "");
    expect(model.threads[0]).toMatchObject({ roots: [main], reach: 3, coroutines: [] });
    expect(runtimes(model)).toEqual({ [main]: "thread", [lam]: "thread", [after]: "thread" });
  });

  it("runs a lambda passed to a call, such as arr.map, on its creator's thread", () => {
    const file = "src/a.ts";
    const main = `${file}#main`;
    const lam = anonId(file, 2);
    const helper = `${file}#helper`;
    const nodes = [fnNode(file, "main", 0), anonNode(file, 2, main), fnNode(file, "helper", 4)];
    const edges = [closureEdge(main, lam, file, 2), callEdge(lam, helper, file, 3)];
    const model = execModel(nodes, edges, "");
    expect(model.threads[0]).toMatchObject({ roots: [main], reach: 3, coroutines: [] });
    expect(runtimes(model)).toEqual({ [main]: "thread", [lam]: "thread", [helper]: "thread" });
  });

  it("never makes an anonymous function a main root, even one nothing creates", () => {
    const file = "src/m.ts";
    const nodes = [fnNode(file, "main", 0), anonNode(file, 6, file)];
    // With no edges, a named function nothing calls would be a root. The lambda is not, and no thread runs it,
    // so it is listed as unthreaded.
    const model = execModel(nodes, [], "");
    expect(model.threads[0]).toMatchObject({ roots: [`${file}#main`], reach: 1 });
    expect(model.functions.find((f) => f.id === anonId(file, 6))).toMatchObject({ anonymous: true, runtime: "none" });
    expect(model.unthreaded).toEqual([anonId(file, 6)]);
    // Module-level code that hands it to a timer lists it, and it runs on no thread.
    const timed = execModel(nodes, [dispatchEdge(file, anonId(file, 6), "timer", file, 7)], "");
    expect(timed.threads[0]?.roots).toEqual([`${file}#main`]);
    expect(timed.functions.find((f) => f.id === anonId(file, 6))).toMatchObject({ anonymous: true, parent: file, runtime: "none" });
    expect(timed.stats).toMatchObject({ functionsInScope: 2, functionsThreaded: 1, functionsUnthreaded: 1 });
  });

  it("runs a lambda created inside a spawned lambda on that spawn's thread", () => {
    const file = "src/m.ts";
    const main = `${file}#main`;
    const outer = anonId(file, 2);
    const inner = anonId(file, 4);
    const helper = "src/h.ts#helper";
    const nodes = [fnNode(file, "main", 0), anonNode(file, 2, main), anonNode(file, 4, outer), spawnNode(file, 2, main), fnNode("src/h.ts", "helper", 0)];
    const edges = [closureEdge(main, outer, file, 2), spawnEdge(file, 2, outer), closureEdge(outer, inner, file, 4), callEdge(inner, helper, file, 5)];
    const model = execModel(nodes, edges, "");
    expect(model.threads[0]).toMatchObject({ roots: [main], reach: 1 });
    expect(model.threads[1]).toMatchObject({ roots: [outer], reach: 3, reached: [helper, outer, inner] });
    expect(model.functions.find((f) => f.id === inner)).toMatchObject({ anonymous: true, parent: outer, runtime: "thread" });
    expect(runtimes(model)).toEqual({ [main]: "thread", [outer]: "thread", [inner]: "thread", [helper]: "thread" });
  });

  it("gives each function a runtime: thread, coroutine or none", () => {
    const file = "src/r.ts";
    const at = (name: string) => `${file}#${name}`;
    const nodes = ["main", "y", "x", "p", "q", "r"].map((n, i) => fnNode(file, n, i * 4));
    const edges = [
      callEdge(at("main"), at("y"), file, 1),
      dispatchEdge(at("main"), at("x"), "await", file, 2),
      // p and q call each other and nothing else calls them, so no thread reaches them. p starts r on a timer.
      callEdge(at("p"), at("q"), file, 13),
      callEdge(at("q"), at("p"), file, 17),
      dispatchEdge(at("p"), at("r"), "timer", file, 14),
    ];
    const model = execModel(nodes, edges, "");
    expect(runtimes(model)).toEqual({
      [at("main")]: "thread",
      [at("y")]: "thread",
      [at("x")]: "coroutine",
      [at("p")]: "none",
      [at("q")]: "none",
      [at("r")]: "none",
    });
    expect(model.unthreaded).toEqual([at("p"), at("q"), at("r")]);
    expect(model.stats).toMatchObject({ functionsInScope: 6, functionsThreaded: 3, functionsCoroutineOnly: 1, functionsUnthreaded: 3 });
  });

  it("roots a function only a test calls in a project, and a test folder's test in its own folder", () => {
    const nodes = [fnNode("src/a.ts", "main", 0), fnNode("src/a.ts", "run", 4), fnNode("tests/a.test.ts", "it", 0)];
    const edges = [callEdge("src/a.ts#main", "src/a.ts#run", "src/a.ts", 1), callEdge("tests/a.test.ts#it", "src/a.ts#main", "tests/a.test.ts", 1)];
    // `main` is called only by a test, which is not the program's code, so the project's thread starts at it.
    const project = execModel(nodes, edges, "");
    expect(project.threads[0]).toMatchObject({ roots: ["src/a.ts#main"], reach: 2 });
    expect(runtimes(project)).toEqual({ "src/a.ts#main": "thread", "src/a.ts#run": "thread" });
    // In the test folder the test is the root, and what it calls is reached from it.
    expect(execModel(nodes, edges, "tests").threads[0]).toMatchObject({ roots: ["tests/a.test.ts#it"], reach: 3 });
  });

  it("pins the known gap: a function only a wider scope's module-level code calls runs on no thread there", () => {
    // In its own file's scope `f` is a main root, since its only caller lies outside the scope. The wider scope holds
    // the script whose top-level code calls it. Module-level code starts no thread, so `f` runs on none there. This
    // breaks the thread-stability property on purpose, so a change to the rule shows here.
    const nodes = [fnNode("src/a.ts", "f", 0)];
    const edges = [callEdge("src/s.ts", "src/a.ts#f", "src/s.ts", 9)];
    expect(execModel(nodes, edges, "src/a.ts").threads[0]?.roots).toEqual(["src/a.ts#f"]);
    const wide = execModel(nodes, edges, "src");
    expect(wide.threads[0]?.roots).toEqual([]);
    expect(wide.stats).toMatchObject({ functionsInScope: 1, functionsThreaded: 0, functionsUnthreaded: 1 });
  });

  it("pins the known gap: a function whose only wider-scope caller sits in an unrooted cycle runs on no thread there", () => {
    // `f` and `g` call each other, and nothing outside the cycle calls either. In "src/a.ts", where `g` lies outside,
    // `f` is a root and runs on a thread. In "src", each is referenced by the other, so neither is a root.
    const nodes = [fnNode("src/a.ts", "f", 0), fnNode("src/b.ts", "g", 0)];
    const edges = [callEdge("src/a.ts#f", "src/b.ts#g", "src/a.ts", 1), callEdge("src/b.ts#g", "src/a.ts#f", "src/b.ts", 1)];
    expect(execModel(nodes, edges, "src/a.ts").threads[0]?.roots).toEqual(["src/a.ts#f"]);
    const wide = execModel(nodes, edges, "src");
    expect(wide.threads[0]?.roots).toEqual([]);
    expect(wide.stats).toMatchObject({ functionsInScope: 2, functionsThreaded: 0, functionsUnthreaded: 2 });
  });
});

describe("execModel: canvas fields", () => {
  /** The model's call pairs, mapped back to function ids. */
  const callIds = (m: ExecModel): [string, string][] =>
    m.calls.map(([a, b]) => [m.functions[a]?.id ?? `?${a}`, m.functions[b]?.id ?? `?${b}`]);

  it("lists the functions a thread reaches only through its coroutines, sorted by id", () => {
    const file = "src/m.ts";
    const at = (name: string) => `${file}#${name}`;
    const nodes = ["main", "a", "co", "h"].map((n, i) => fnNode(file, n, i * 4));
    const edges = [callEdge(at("main"), at("a"), file, 1), dispatchEdge(at("main"), at("co"), "await", file, 2), callEdge(at("co"), at("h"), file, 9)];
    const model = execModel(nodes, edges, "src");
    expect(model.threads[0]?.reached).toEqual([at("a"), at("co"), at("h"), at("main")]);
    expect(model.threads[0]?.coroutineOnly).toEqual([at("co"), at("h")]);
  });

  it("does not count a function as coroutine-only when the thread also calls it directly", () => {
    const file = "src/m.ts";
    const at = (name: string) => `${file}#${name}`;
    const nodes = ["main", "both", "co"].map((n, i) => fnNode(file, n, i * 4));
    const edges = [
      callEdge(at("main"), at("both"), file, 1),
      dispatchEdge(at("main"), at("both"), "await", file, 2),
      dispatchEdge(at("main"), at("co"), "await", file, 3),
    ];
    const model = execModel(nodes, edges, "src");
    expect(model.threads[0]?.coroutines.map((c) => c.target)).toEqual([at("both"), at("co")]);
    expect(model.threads[0]?.coroutineOnly).toEqual([at("co")]);
    expect(runtimeIn(model, at("both"))).toBe("thread");
  });

  it("lists a function called only from module-level code as unthreaded, with runtime none", () => {
    const nodes = [fnNode("src/m.ts", "main", 0), fnNode("src/m.ts", "f", 4)];
    const model = execModel(nodes, [callEdge("src/m.ts", "src/m.ts#f", "src/m.ts", 10)], "src");
    expect(model.threads[0]?.roots).toEqual(["src/m.ts#main"]);
    expect(model.unthreaded).toEqual(["src/m.ts#f"]);
    expect(model.functions.find((f) => f.id === "src/m.ts#f")).toMatchObject({ inScope: true, runtime: "none" });
    expect(model.stats).toMatchObject({ functionsUnthreaded: 1 });
  });

  it("leaves unthreaded test functions out unless the scope is the test file or folder", () => {
    const nodes = [fnNode("src/m.ts", "f", 0), fnNode("src/x.test.ts", "t", 0), fnNode("tests/y.ts", "u", 0)];
    const edges = [
      callEdge("src/m.ts", "src/m.ts#f", "src/m.ts", 10),
      callEdge("src/x.test.ts", "src/x.test.ts#t", "src/x.test.ts", 10),
      callEdge("tests/y.ts", "tests/y.ts#u", "tests/y.ts", 10),
    ];
    expect(isNoisePath("src")).toBe(false);
    expect(isNoisePath("src/x.test.ts")).toBe(true);
    const wide = execModel(nodes, edges, "src");
    expect(wide.unthreaded).toEqual(["src/m.ts#f"]);
    expect(wide.functions.map((f) => f.id)).toEqual(["src/m.ts#f"]);
    expect(execModel(nodes, edges, "").unthreaded).toEqual(["src/m.ts#f"]);
    expect(execModel(nodes, edges, "src/x.test.ts").unthreaded).toEqual(["src/x.test.ts#t"]);
    expect(execModel(nodes, edges, "tests").unthreaded).toEqual(["tests/y.ts#u"]);
  });

  it("lists calls between listed functions as sorted index pairs, once each, with no self-calls", () => {
    const file = "src/m.ts";
    const at = (name: string) => `${file}#${name}`;
    const main = at("main");
    const lam = anonId(file, 2);
    const spawned = anonId(file, 3);
    const nodes = [fnNode(file, "main", 0), fnNode(file, "b", 8), fnNode(file, "a", 12), anonNode(file, 2, main), anonNode(file, 3, main), spawnNode(file, 3, main)];
    const edges = [
      callEdge(main, at("a"), file, 1),
      callEdge(main, at("a"), file, 5),
      callEdge(at("a"), at("b"), file, 13),
      callEdge(at("b"), at("b"), file, 9),
      callEdge(at("b"), at("a"), file, 10),
      // Module-level code is no function, so its call makes no pair.
      callEdge(file, at("b"), file, 20),
      closureEdge(main, lam, file, 2),
      closureEdge(main, spawned, file, 3),
      spawnEdge(file, 3, spawned),
    ];
    const model = execModel(nodes, edges, "src");
    expect(model.functions.map((f) => f.id)).toEqual(expect.arrayContaining([main, at("a"), at("b"), lam, spawned]));
    const idx = (id: string) => model.functions.findIndex((f) => f.id === id);
    const expected: [string, string][] = [
      [main, at("a")],
      [main, lam],
      [at("a"), at("b")],
      [at("b"), at("a")],
    ];
    // Each pair once, no self-call of b, and nothing for the spawned closure or the module-level call.
    expect(model.calls).toEqual(expected.map(([x, y]): [number, number] => [idx(x), idx(y)]).sort(([x0, x1], [y0, y1]) => x0 - y0 || x1 - y1));
    expect(callIds(model)).toHaveLength(4);
    expect(callIds(model)).toEqual(expect.arrayContaining(expected));
  });

  it("cuts unthreaded functions before thread functions, and keeps call indexes inside the table", () => {
    const file = "src/m.ts";
    const at = (name: string) => `${file}#${name}`;
    const nodes = ["main", "a", "u1", "u2"].map((n, i) => fnNode(file, n, i * 4));
    const edges = [
      callEdge(at("main"), at("a"), file, 1),
      callEdge(file, at("u1"), file, 20),
      callEdge(file, at("u2"), file, 21),
      callEdge(at("u1"), at("u2"), file, 9),
    ];
    const full = execModel(nodes, edges, "src");
    expect(full.unthreaded).toEqual([at("u1"), at("u2")]);
    expect(callIds(full)).toEqual(expect.arrayContaining([[at("u1"), at("u2")]]));
    const cut = execModel(nodes, edges, "src", { maxFunctions: 3 });
    expect(cut.truncated).toBe(true);
    expect(cut.threads[0]?.reached).toEqual([at("a"), at("main")]);
    expect(cut.unthreaded).toEqual([at("u1")]);
    expect(cut.functions.map((f) => f.id)).toEqual([at("main"), at("a"), at("u1")]);
    const tight = execModel(nodes, edges, "src", { maxFunctions: 2 });
    expect(tight.unthreaded).toEqual([]);
    expect(tight.threads[0]?.reached).toEqual([at("a"), at("main")]);
    for (const m of [full, cut, tight]) {
      for (const [a, b] of m.calls) {
        expect(a).toBeLessThan(m.functions.length);
        expect(b).toBeLessThan(m.functions.length);
      }
    }
    expect(callIds(tight)).toEqual([[at("main"), at("a")]]);
  });
});

describe("execModel: programs", () => {
  const SERVER_MAIN = "src/server/main.cc#main";
  const CLIENT_MAIN = "src/client/main.cc#main";
  const SHARED = "src/core/core.cc#shared";
  const POLL_SPAWN = spawnId("src/server/main.cc", 2);
  const BG_SPAWN = spawnId("src/core/core.cc", 3);

  /**
   * Two cc_binary programs, a cc_library and a cc_test. Each binary's main calls `shared`, which is in the library, and
   * the server spawns `pollLoop`. `shared` spawns `background`, so both programs reach that spawn. `serve` is called by
   * nothing, and the test's own `main` is not a program's main.
   */
  function programIr(): { nodes: IRNode[]; edges: IREdge[] } {
    const nodes: IRNode[] = [
      targetNode("app:server", "cc_binary"),
      targetNode("app:client", "cc_binary"),
      targetNode("lib:core", "cc_library"),
      targetNode("app:core_test", "cc_test"),
      fnNode("src/server/main.cc", "main", 0),
      fnNode("src/server/main.cc", "serve", 8),
      spawnNode("src/server/main.cc", 2, SERVER_MAIN),
      fnNode("src/server/util.cc", "pollLoop", 0),
      fnNode("src/server/util.cc", "helper", 4),
      fnNode("src/client/main.cc", "main", 0),
      fnNode("src/client/net.cc", "connect", 0),
      fnNode("src/core/core.cc", "shared", 0),
      spawnNode("src/core/core.cc", 3, SHARED),
      fnNode("src/core/core.cc", "background", 8),
      fnNode("src/core/core_test.cc", "main", 0),
    ];
    const edges: IREdge[] = [
      containsEdge("app:server", "src/server/main.cc"),
      containsEdge("app:server", "src/server/util.cc"),
      containsEdge("app:client", "src/client/main.cc"),
      containsEdge("app:client", "src/client/net.cc"),
      containsEdge("lib:core", "src/core/core.cc"),
      containsEdge("app:core_test", "src/core/core_test.cc"),
      callEdge(SERVER_MAIN, SHARED, "src/server/main.cc", 6),
      spawnEdge("src/server/main.cc", 2, "src/server/util.cc#pollLoop"),
      callEdge("src/server/util.cc#pollLoop", "src/server/util.cc#helper", "src/server/util.cc", 1),
      callEdge(CLIENT_MAIN, "src/client/net.cc#connect", "src/client/main.cc", 1),
      callEdge(CLIENT_MAIN, SHARED, "src/client/main.cc", 2),
      spawnEdge("src/core/core.cc", 3, "src/core/core.cc#background"),
    ];
    return { nodes, edges };
  }

  it("lists each cc_binary as a program, with its files and main, and not the library or the test", () => {
    const { nodes, edges } = programIr();
    const model = execModel(nodes, edges, "");
    expect(model.programs).toEqual([
      {
        id: "app:client",
        name: "client",
        targetKind: "cc_binary",
        files: ["src/client/main.cc", "src/client/net.cc"],
        main: CLIENT_MAIN,
        threads: ["main:app:client", BG_SPAWN],
      },
      {
        id: "app:server",
        name: "server",
        targetKind: "cc_binary",
        files: ["src/server/main.cc", "src/server/util.cc"],
        main: SERVER_MAIN,
        threads: ["main:app:server", BG_SPAWN, POLL_SPAWN],
      },
    ]);
    expect(model.stats.programs).toBe(2);
  });

  it("gives each program with a main its own main thread, and takes the mains out of the general main roots", () => {
    const { nodes, edges } = programIr();
    const model = execModel(nodes, edges, "");
    // The general main first, then the program mains by program id, then the spawns by spawn id.
    expect(model.threads.map((t) => t.id)).toEqual(["main", "main:app:client", "main:app:server", BG_SPAWN, POLL_SPAWN]);
    // The test's main is a general root: a cc_test is not a program, so its main is not one either.
    expect(model.threads[0]).toMatchObject({ kind: "main", roots: ["src/core/core_test.cc#main", "src/server/main.cc#serve"] });
    expect(model.threads[1]).toMatchObject({ id: "main:app:client", kind: "main", roots: [CLIENT_MAIN], reach: 3 });
    expect(model.threads[1]?.reached).toEqual([CLIENT_MAIN, "src/client/net.cc#connect", SHARED]);
    expect(model.threads[2]).toMatchObject({ id: "main:app:server", kind: "main", roots: [SERVER_MAIN], reach: 2 });
    expect(model.threads[2]?.reached).toEqual([SHARED, SERVER_MAIN]);
    expect(runtimeIn(model, SERVER_MAIN)).toBe("thread");
    expect(runtimeIn(model, "src/server/main.cc#serve")).toBe("thread");
  });

  it("keeps a spawn thread's roots and reach, and lists it under each program that reaches it", () => {
    const { nodes, edges } = programIr();
    const model = execModel(nodes, edges, "");
    expect(model.threads.find((t) => t.id === POLL_SPAWN)).toMatchObject({
      kind: "thread",
      roots: ["src/server/util.cc#pollLoop"],
      reached: ["src/server/util.cc#helper", "src/server/util.cc#pollLoop"],
    });
    expect(model.threads.find((t) => t.id === BG_SPAWN)?.roots).toEqual(["src/core/core.cc#background"]);
    expect(model.programs.map((p) => p.threads.includes(BG_SPAWN))).toEqual([true, true]);
  });

  it("lists only the programs with a file in the scope, and the threads that start in the scope", () => {
    const { nodes, edges } = programIr();
    expect(execModel(nodes, edges, "src/server").programs.map((p) => p.id)).toEqual(["app:server"]);
    expect(execModel(nodes, edges, "src/client").programs.map((p) => p.id)).toEqual(["app:client"]);
    expect(execModel(nodes, edges, "src/core").programs).toEqual([]);
    // BG_SPAWN starts in core.cc, which is outside this scope, so no thread for it is listed here.
    expect(execModel(nodes, edges, "src/server").programs[0]?.threads).toEqual(["main:app:server", POLL_SPAWN]);
  });

  it("gives the same programs whatever order the nodes and edges arrive in", () => {
    const { nodes, edges } = programIr();
    const a = execModel(nodes, edges, "");
    const b = execModel([...nodes].reverse(), [...edges].reverse(), "");
    expect(b.programs).toEqual(a.programs);
    expect(b.threads.map((t) => t.id)).toEqual(a.threads.map((t) => t.id));
  });

  it("lists a program with no main, with only the spawns that start in its files", () => {
    const tick = spawnId("src/tiny/run.py", 2);
    const nodes = [
      targetNode("app:tiny", "py_binary"),
      fnNode("src/tiny/run.py", "run", 0),
      spawnNode("src/tiny/run.py", 2, "src/tiny/run.py#run"),
      fnNode("src/tiny/tick.py", "tick", 0),
    ];
    const edges = [containsEdge("app:tiny", "src/tiny/run.py"), spawnEdge("src/tiny/run.py", 2, "src/tiny/tick.py#tick")];
    const model = execModel(nodes, edges, "");
    expect(model.programs).toEqual([{ id: "app:tiny", name: "tiny", targetKind: "py_binary", files: ["src/tiny/run.py"], threads: [tick] }]);
    expect(model.threads.map((t) => t.id)).toEqual(["main", tick]);
  });

  it("treats a CMake add_executable target as a program, and not an add_library target", () => {
    const nodes = [
      targetNode("CMakeLists.txt:tool", "add_executable"),
      targetNode("CMakeLists.txt:util", "add_library"),
      fnNode("tools/tool.c", "main", 0),
      fnNode("tools/util.c", "util", 0),
    ];
    const edges = [containsEdge("CMakeLists.txt:tool", "tools/tool.c"), containsEdge("CMakeLists.txt:util", "tools/util.c")];
    const model = execModel(nodes, edges, "");
    expect(model.programs).toEqual([
      {
        id: "CMakeLists.txt:tool",
        name: "tool",
        targetKind: "add_executable",
        files: ["tools/tool.c"],
        main: "tools/tool.c#main",
        threads: ["main:CMakeLists.txt:tool"],
      },
    ]);
    expect(model.threads.map((t) => t.id)).toEqual(["main", "main:CMakeLists.txt:tool"]);
    expect(model.threads[0]?.roots).toEqual(["tools/util.c#util"]);
  });

  it("leaves out a program built only from test or sample files, unless the scope is one of them", () => {
    const nodes = [
      fnNode("samples/demo/main.cc", "main", 0),
      { id: "//samples/demo:demo", facet: "packaging", kind: "packaging.build-target", attrs: { name: "demo", targetKind: "cc_binary" }, provenance: PROVENANCE } as IRNode,
    ];
    const edges = [{ from: "//samples/demo:demo", to: "samples/demo/main.cc", facet: "packaging", kind: "packaging.target-contains", provenance: PROVENANCE } as IREdge];
    expect(execModel(nodes, edges, "").programs).toEqual([]);
    expect(execModel(nodes, edges, "samples").programs.map((p) => p.id)).toEqual(["//samples/demo:demo"]);
  });

  it("has no programs, and the same main thread, when the IR has no build targets", () => {
    const nodes = [fnNode("src/m.ts", "main", 0), fnNode("src/m.ts", "a", 4)];
    const edges = [callEdge("src/m.ts#main", "src/m.ts#a", "src/m.ts", 1)];
    const model = execModel(nodes, edges, "src");
    expect(model.programs).toEqual([]);
    expect(model.stats.programs).toBe(0);
    expect(model.threads.map((t) => t.id)).toEqual(["main"]);
    expect(model.threads[0]?.roots).toEqual(["src/m.ts#main"]);
  });
});

/** A lock acquire on `line` of `file`, in `parent`: the node the C++ frontend emits for `.lock()`. */
function lockNode(file: string, line: number, parent: string, lock: string, kind = "sync.lock-acquire", mode = "exclusive"): IRNode {
  return { id: `${file}@lock:${line + 1}:2:${kind}`, facet: "sync", kind, parent, span: spanAt(file, line), attrs: { lock, mode }, provenance: PROVENANCE };
}
/** A channel send or receive on `line` of `file`, in `parent`. The channel is named by `attrs.channel`. */
function channelNode(file: string, line: number, parent: string, channel: string, op: "send" | "recv"): IRNode {
  const kind = op === "send" ? "concurrency.channel-send" : "concurrency.channel-recv";
  return { id: `${file}@${op}:${line + 1}:2`, facet: "concurrency", kind, parent, span: spanAt(file, line), attrs: { channel }, provenance: PROVENANCE };
}

describe("execModel: locks and channels", () => {
  it("lists one lock resource for two threads that both lock the same mutex, with each site", () => {
    const nodes = [
      fnNode("src/m.ts", "main", 0),
      lockNode("src/m.ts", 1, "src/m.ts#main", "m"),
      spawnNode("src/m.ts", 3, "src/m.ts#main"),
      fnNode("src/w.ts", "work", 0),
      lockNode("src/w.ts", 2, "src/w.ts#work", "m"),
    ];
    const edges = [spawnEdge("src/m.ts", 3, "src/w.ts#work")];
    const model = execModel(nodes, edges, "src");
    expect(model.resources).toEqual([
      {
        id: "lock:m",
        kind: "lock",
        name: "m",
        threads: ["main", spawnId("src/m.ts", 3)],
        sites: [
          { fn: "src/m.ts#main", op: "acquire", file: "src/m.ts", line: 2 },
          { fn: "src/w.ts#work", op: "acquire", file: "src/w.ts", line: 3 },
        ],
      },
    ]);
    expect(model.stats).toMatchObject({ locks: 1, channels: 0 });
  });

  it("lists a lock that one thread uses, with that one thread", () => {
    const nodes = [fnNode("src/m.ts", "main", 0), lockNode("src/m.ts", 1, "src/m.ts#main", "solo")];
    const model = execModel(nodes, [], "src");
    expect(model.resources).toMatchObject([{ id: "lock:solo", kind: "lock", name: "solo", threads: ["main"], sites: [{ fn: "src/m.ts#main", op: "acquire" }] }]);
    expect(model.stats).toMatchObject({ locks: 1 });
  });

  it("counts a read-write lock acquire as a lock site, and joins it with a plain lock of the same name", () => {
    const nodes = [
      fnNode("src/m.ts", "main", 0),
      lockNode("src/m.ts", 1, "src/m.ts#main", "rw", "sync.rwlock-acquire", "shared"),
      spawnNode("src/m.ts", 3, "src/m.ts#main"),
      fnNode("src/w.ts", "work", 0),
      lockNode("src/w.ts", 2, "src/w.ts#work", "rw"),
    ];
    const model = execModel(nodes, [spawnEdge("src/m.ts", 3, "src/w.ts#work")], "src");
    expect(model.resources).toHaveLength(1);
    expect(model.resources[0]).toMatchObject({ id: "lock:rw", threads: ["main", spawnId("src/m.ts", 3)] });
    expect(model.resources[0]?.sites.map((s) => s.op)).toEqual(["acquire", "acquire"]);
  });

  it("counts a C++ RAII guard (x-cpp.scoped-lock) as a lock site, joined with .lock() on the same mutex", () => {
    const nodes = [
      fnNode("src/m.cc", "main", 0),
      lockNode("src/m.cc", 1, "src/m.cc#main", "Store::mu", "x-cpp.scoped-lock"),
      spawnNode("src/m.cc", 3, "src/m.cc#main"),
      fnNode("src/w.cc", "work", 0),
      lockNode("src/w.cc", 2, "src/w.cc#work", "Store::mu"),
    ];
    const model = execModel(nodes, [spawnEdge("src/m.cc", 3, "src/w.cc#work")], "src");
    expect(model.resources).toHaveLength(1);
    expect(model.resources[0]).toMatchObject({ id: "lock:Store::mu", threads: ["main", spawnId("src/m.cc", 3)] });
  });

  it("lists a channel with its send in one thread and its receive in another, sorted by id before the locks", () => {
    const nodes = [
      fnNode("src/m.ts", "main", 0),
      channelNode("src/m.ts", 1, "src/m.ts#main", "jobs", "send"),
      lockNode("src/m.ts", 2, "src/m.ts#main", "m"),
      spawnNode("src/m.ts", 4, "src/m.ts#main"),
      fnNode("src/w.ts", "work", 0),
      channelNode("src/w.ts", 2, "src/w.ts#work", "jobs", "recv"),
    ];
    const model = execModel(nodes, [spawnEdge("src/m.ts", 4, "src/w.ts#work")], "src");
    expect(model.resources.map((r) => r.id)).toEqual(["channel:jobs", "lock:m"]);
    expect(model.resources[0]).toEqual({
      id: "channel:jobs",
      kind: "channel",
      name: "jobs",
      threads: ["main", spawnId("src/m.ts", 4)],
      sites: [
        { fn: "src/m.ts#main", op: "send", file: "src/m.ts", line: 2 },
        { fn: "src/w.ts#work", op: "recv", file: "src/w.ts", line: 3 },
      ],
    });
    expect(model.stats).toMatchObject({ locks: 1, channels: 1 });
  });

  it("gives the same lock resource whatever order the nodes arrive in, with sites sorted by function then line", () => {
    const nodes = [
      fnNode("src/m.ts", "main", 0),
      fnNode("src/a.ts", "alpha", 0),
      lockNode("src/m.ts", 3, "src/m.ts#main", "m"),
      lockNode("src/m.ts", 1, "src/m.ts#main", "m"),
      lockNode("src/a.ts", 2, "src/a.ts#alpha", "m"),
    ];
    const forward = execModel(nodes, [callEdge("src/m.ts#main", "src/a.ts#alpha", "src/m.ts", 5)], "src");
    const backward = execModel([...nodes].reverse(), [callEdge("src/m.ts#main", "src/a.ts#alpha", "src/m.ts", 5)], "src");
    expect(forward.resources).toEqual(backward.resources);
    expect(forward.resources[0]?.sites.map((s) => [s.fn, s.line])).toEqual([
      ["src/a.ts#alpha", 3],
      ["src/m.ts#main", 2],
      ["src/m.ts#main", 4],
    ]);
  });

  it("lists a lock used only by a function no thread runs, with no threads", () => {
    // helper is called only from module-level code of the file, so no thread runs it.
    const nodes = [fnNode("src/m.ts", "main", 0), fnNode("src/m.ts", "helper", 6), lockNode("src/m.ts", 7, "src/m.ts#helper", "m")];
    const model = execModel(nodes, [callEdge("src/m.ts", "src/m.ts#helper", "src/m.ts", 9)], "src");
    expect(model.unthreaded).toEqual(["src/m.ts#helper"]);
    expect(model.resources).toMatchObject([{ id: "lock:m", threads: [], sites: [{ fn: "src/m.ts#helper" }] }]);
  });

  it("skips a lock at module level, a lock with no identity, and a channel with no name", () => {
    const nodes = [
      fnNode("src/m.ts", "main", 0),
      lockNode("src/m.ts", 9, "src/m.ts", "top"),
      { ...lockNode("src/m.ts", 2, "src/m.ts#main", ""), id: "src/m.ts@anon" },
      { ...channelNode("src/m.ts", 3, "src/m.ts#main", "", "send"), id: "src/m.ts@nameless" },
    ];
    const model = execModel(nodes, [], "src");
    expect(model.resources).toEqual([]);
    expect(model.stats).toMatchObject({ locks: 0, channels: 0 });
  });

  it("has no resources, and zero counts, when the IR has no lock or channel nodes", () => {
    const nodes = [fnNode("src/m.ts", "main", 0), fnNode("src/m.ts", "a", 4)];
    const model = execModel(nodes, [callEdge("src/m.ts#main", "src/m.ts#a", "src/m.ts", 1)], "src");
    expect(model.resources).toEqual([]);
    expect(model.stats).toMatchObject({ locks: 0, channels: 0 });
  });
});
