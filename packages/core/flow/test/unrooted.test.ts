import { describe, expect, it } from "vitest";
import type { ExecCoroutine, ExecFunctionRef, ExecModel, ExecModelStats, ExecThread } from "../src/exec-model.js";
import { buildExecScene } from "../src/exec-scene.js";
import { MORE_KEEP, MORE_SUFFIX, unrootedFunctions, unrootedScene } from "../src/unrooted.js";

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

const thread = (id: string, roots: string[], reached: string[] = roots, coroutines: ExecCoroutine[] = []): ExecThread => ({
  id,
  kind: id === "main" ? "main" : "thread",
  grounded: true,
  roots,
  reach: reached.length,
  reached: [...reached].sort(),
  coroutines,
  coroutineOnly: [],
});

/** A model from functions, threads and calls given by function id. */
function model(parts: { functions: ExecFunctionRef[]; threads?: ExecThread[]; calls?: [string, string][]; unthreaded?: string[] }): ExecModel {
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
    threads: parts.threads ?? [],
    dispatches: [],
    programs: [],
    calls: (parts.calls ?? []).map(([a, b]) => [at(a), at(b)] as [number, number]),
    unthreaded: parts.unthreaded ?? [],
    stats: ZERO_STATS,
  };
}

const allIds = (m: ExecModel): Set<string> => new Set(m.functions.map((f) => f.id));
const refsOf = (scene: ReturnType<typeof unrootedScene>): string[] => [...scene.nodes.values()].filter((n) => n.kind === "function").map((n) => n.ref ?? "");

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
