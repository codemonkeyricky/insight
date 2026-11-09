import { describe, expect, it, vi } from "vitest";
import type { ExecFunctionRef, ExecModel, ExecModelStats, ExecThread, LayoutGraph, SolvedGraph } from "@insight/flow";
import { ExecStore } from "../src/zoom/execStore.js";
import { execFocus } from "../src/zoom/execMap.js";

// The API and the solver are replaced: the store reads a model, and lays it out in the solver.
const fixture = vi.hoisted(() => ({ model: undefined as unknown }));
vi.mock("../src/api", () => ({
  api: {
    getScopeExec: async () => fixture.model,
    scopeExecLayout: async () => undefined,
    getScopeCallers: async () => undefined,
  },
}));
vi.mock("../src/zoom/elk", () => ({
  solve: async (g: LayoutGraph): Promise<{ result: SolvedGraph; ms: number }> => {
    // Stacks each container's children in a column, so every node has a place.
    let y = 0;
    const children = g.children.map((c) => {
      const out = { id: c.id, x: 0, y };
      y += c.height + 10;
      return out;
    });
    return { result: { children }, ms: 0 };
  },
}));

const fn = (id: string, line: number, runtime: ExecFunctionRef["runtime"] = "thread"): ExecFunctionRef => ({
  id,
  name: id,
  file: "src/app.py",
  line,
  inScope: true,
  runtime,
});

const stats: ExecModelStats = {
  threads: 1,
  programs: 0,
  locks: 0,
  channels: 0,
  spawns: 0,
  resolved: 0,
  outside: 0,
  unresolved: 0,
  candidates: 0,
  coroutines: 0,
  dispatches: 0,
  functionsInScope: 3,
  functionsThreaded: 3,
  functionsCoroutineOnly: 0,
  functionsUnthreaded: 0,
  functionsListed: 3,
};

// main calls helper, helper calls leaf. Only main is a root: the thread starts in it.
const model = (): ExecModel => {
  const main: ExecThread = {
    id: "main",
    kind: "main",
    grounded: true,
    roots: ["main"],
    reach: 3,
    reached: ["helper", "leaf", "main"],
    coroutines: [],
    coroutineOnly: [],
  };
  return {
    scope: "",
    truncated: false,
    functions: [fn("main", 1), fn("helper", 5), fn("leaf", 9)],
    threads: [main],
    dispatches: [],
    programs: [],
    resources: [],
    calls: [
      [0, 1],
      [1, 2],
    ],
    unthreaded: [],
    stats,
  };
};

describe("ExecStore", () => {
  it("resolves a URL to a focus that carries its scope, and builds the node it names", async () => {
    fixture.model = model();
    const store = new ExecStore("p1");
    const focus = await store.resolve("", "main");
    expect(focus).toBe(execFocus("", "thread:main>main"));
    const build = await store.build(focus);
    expect(build.focus).toBe(focus);
    expect(build.nodeId).toBe("thread:main>main");
    expect(build.selected).toMatchObject({ ref: "main", runtime: "thread", thread: "Main thread", placements: [] });
    expect(store.url(build, focus)).toEqual({ scope: "", fn: "main" });
  });

  it("turns a node id the map clicked into the focus of the build's scope", async () => {
    fixture.model = model();
    const store = new ExecStore("p1");
    const build = await store.build(await store.resolve("", "main"));
    const focus = store.focusOf(build, "thread:main>helper");
    expect(focus).toBe(execFocus("", "thread:main>helper"));
    await expect(store.ensureFocus(focus)).resolves.toBeUndefined();
    expect(store.url(build, focus)).toEqual({ scope: "", fn: "helper" });
  });

  it("exposes the loaded view of a build's scope, with the index the panels read", async () => {
    fixture.model = model();
    const store = new ExecStore("p1");
    const build = await store.build(await store.resolve("", "helper"));
    const view = store.viewOf(build);
    expect(view?.index.callees.get("helper")).toEqual(["leaf"]);
    expect(view?.index.callers.get("helper")).toEqual(["main"]);
    expect(view?.index.placements.get("leaf")?.map((p) => p.nodeId)).toEqual(["thread:main>leaf"]);
  });

  it("rejects a focus whose node is not in the scene", async () => {
    fixture.model = model();
    const store = new ExecStore("p1");
    await expect(store.build(execFocus("", "thread:main>nope"))).rejects.toThrow("Nothing in the execution map");
  });

  it("cuts the scene to the roots when it is roots-only, and says so in its URLs", async () => {
    fixture.model = model();
    const store = new ExecStore("p1", true);
    // helper is not a root, so the roots-only scene has no node for it: a URL that names it resolves to the root.
    expect(await store.resolve("", "helper")).toBe(execFocus("", "project"));
    const build = await store.build(await store.resolve("", "main"));
    expect(store.url(build, build.focus)).toEqual({ scope: "", fn: "main", roots: true });
    await expect(store.ensureFocus(execFocus("", "thread:main>helper"))).rejects.toThrow("Nothing in the execution map");
    expect([...build.placed.rects.keys()].sort()).toEqual(["prog:main", "project", "thread:main", "thread:main>main"]);
  });
});
