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
    expect(model.threads).toEqual([{ id: "main", kind: "main", roots: [], reach: 0, reached: [], coroutines: [] }]);
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
    // With no edges, a named function nothing calls would be a root. The lambda is not, and no thread runs it.
    const model = execModel(nodes, [], "");
    expect(model.threads[0]).toMatchObject({ roots: [`${file}#main`], reach: 1 });
    expect(model.functions.find((f) => f.id === anonId(file, 6))).toBeUndefined();
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
    expect(runtimes(model)).toEqual({ [at("main")]: "thread", [at("y")]: "thread", [at("x")]: "coroutine", [at("r")]: "none" });
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
