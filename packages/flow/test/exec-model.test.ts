import { describe, expect, it } from "vitest";
import type { IREdge, IRNode } from "@insight/ir";
import { MAX_EXEC_FUNCTIONS, execModel, insideScope, type ExecModel } from "../src/index.js";
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
    expect(model.stats).toMatchObject({ coroutines: 2, dispatches: 2, functionsThreaded: 6, functionsUnthreaded: 0 });
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
});
