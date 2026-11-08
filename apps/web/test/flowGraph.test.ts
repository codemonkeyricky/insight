import { describe, expect, it } from "vitest";
import type { FlowNode, FunctionFlow, ScopeFlow } from "@insight/flow";
import {
  NODE_CELL,
  callGraph,
  callLinks,
  callPath,
  callRoots,
  graphGrid,
  gridLayout,
  layerDepths,
  nearestScopeContaining,
  outsideCall,
  outsideSteps,
  outsideText,
  resolutionPercent,
} from "../src/flowGraph.js";

describe("nearestScopeContaining", () => {
  it("finds the smallest folder above a file that holds the callee", () => {
    expect(nearestScopeContaining("apps/server/src/app.ts", "apps/server/src/reader.ts")).toBe("apps/server/src");
    expect(nearestScopeContaining("apps/server/src/app.ts", "apps/server/lib/x.ts")).toBe("apps/server");
    expect(nearestScopeContaining("apps/server/src/app.ts", "docs/readme.ts")).toBe("");
  });

  it("counts a folder scope itself when it holds the file", () => {
    expect(nearestScopeContaining("apps/server/src", "apps/server/src/x.ts")).toBe("apps/server/src");
  });

  it("answers the project for a file at the top level", () => {
    expect(nearestScopeContaining("src/a.ts", "lib/c.ts")).toBe("");
    expect(nearestScopeContaining("", "lib/c.ts")).toBe("");
  });
});

describe("outsideCall", () => {
  it("names the callee's file and the scope that resolves it", () => {
    expect(outsideCall("apps/server/lib/x.ts#fetch", "apps/server/src/app.ts")).toEqual({ file: "apps/server/lib/x.ts", scope: "apps/server" });
  });

  it("explains an unresolved call in one sentence", () => {
    expect(outsideText("lib/c.ts#c")).toBe("calls c in lib/c.ts — outside this scope. Select a parent folder to resolve it.");
  });
});

describe("resolutionPercent", () => {
  it("is undefined when the scope starts no calls", () => {
    expect(resolutionPercent({ calls: 0, resolved: 0 })).toBeUndefined();
  });

  it("rounds the share of calls that resolve", () => {
    expect(resolutionPercent({ calls: 3, resolved: 2 })).toBe(67);
    expect(resolutionPercent({ calls: 3, resolved: 3 })).toBe(100);
    expect(resolutionPercent({ calls: 4, resolved: 0 })).toBe(0);
  });
});

describe("callRoots", () => {
  const keys = ["a", "b", "c", "d", "e"];

  it("starts from the entries and does not make the nodes they reach roots", () => {
    const links = [
      { from: "a", to: "b" },
      { from: "b", to: "c" },
    ];
    expect(callRoots(keys, links, ["a"])).toEqual(["a", "d", "e"]);
  });

  it("gives a cycle with no entry one root", () => {
    const links = [
      { from: "b", to: "c" },
      { from: "c", to: "b" },
    ];
    expect(callRoots(["b", "c"], links, [])).toEqual(["b"]);
  });

  it("skips an entry the graph does not hold", () => {
    expect(callRoots(["a"], [], ["zzz"])).toEqual(["a"]);
  });
});

describe("callPath", () => {
  const links = [
    { from: "a", to: "b" },
    { from: "b", to: "c" },
    { from: "a", to: "d" },
    { from: "d", to: "c" },
  ];

  it("returns a shortest chain from a root, root first", () => {
    expect(callPath(["a"], links, "c")).toEqual(["a", "b", "c"]);
  });

  it("is the root itself when the target is a root", () => {
    expect(callPath(["a"], links, "a")).toEqual(["a"]);
  });

  it("is the target alone when no root reaches it", () => {
    expect(callPath(["a"], links, "x")).toEqual(["x"]);
  });
});

function step(id: string, target?: string): FlowNode {
  return { id, role: "call", shape: "step", label: id, x: 0, y: 0, w: 40, h: 20, ...(target !== undefined ? { target } : {}) };
}

function fn(nodes: FlowNode[]): FunctionFlow {
  return {
    id: "src/a.ts#a",
    name: "a",
    async: false,
    stats: { steps: nodes.length, decisions: 0, loops: 0, tries: 0, exits: 0, depth: 0 },
    width: 100,
    height: 100,
    nodes,
    edges: [],
  };
}

describe("outsideSteps", () => {
  it("lists the call steps whose callee lies outside the scope, with the scope that resolves each", () => {
    const out = outsideSteps(fn([step("1", "src/a.ts#a"), step("2", "lib/c.ts#c"), step("3")]), "src/a.ts");
    expect(out.map((s) => s.target)).toEqual(["lib/c.ts#c"]);
    expect(out[0]).toMatchObject({ name: "c", file: "lib/c.ts", scope: "" });
  });

  it("lists nothing when the scope holds every callee", () => {
    expect(outsideSteps(fn([step("1", "src/a.ts#a")]), "")).toEqual([]);
  });
});

/**
 * A small scope: a and d in src/a.ts and src/b.ts, b in src/b.ts, and an external c in lib. Module code of
 * src/a.ts calls a, so a has a caller and is not an entry. d has no caller and is.
 */
function sample(): ScopeFlow {
  const row = { async: false, line: 1, steps: 1, decisions: 0, loops: 0, tries: 0, awaits: 0, spawns: 0, effects: 0, exits: 0 };
  return {
    granularity: "functions",
    functions: [
      { ...row, id: "src/a.ts#a", name: "a", file: "src/a.ts" },
      { ...row, id: "src/b.ts#b", name: "b", file: "src/b.ts", calledFromOutside: true },
      { ...row, id: "src/b.ts#d", name: "d", file: "src/b.ts", line: 9 },
    ],
    calls: [
      { from: "src/a.ts#a", to: "src/b.ts#b", count: 2, external: false },
      { from: "src/a.ts#a", to: "lib/c.ts#c", count: 1, external: true },
      { from: "src/a.ts", to: "src/a.ts#a", count: 1, external: false },
    ],
    externals: [{ id: "lib/c.ts#c", name: "c", file: "lib/c.ts" }],
    entries: ["src/b.ts#d"],
    files: [
      { file: "src/a.ts", functions: 1, decisions: 0, loops: 0, tries: 0 },
      { file: "src/b.ts", functions: 2, decisions: 0, loops: 0, tries: 0, calledFromOutside: true },
    ],
    stats: { functions: 3, files: 2, calls: 4, resolved: 3, external: 1, unresolved: 0, inbound: 0, entries: 1 },
  };
}

describe("callGraph", () => {
  it("records each node's file, keeps module code as its own caller, and marks externals", () => {
    const g = callGraph("p", sample(), "src");
    expect(g.byKey.get("fn:src/a.ts#a")).toMatchObject({ kind: "function", name: "a", file: "src/a.ts", entry: false, calledFromOutside: false });
    expect(g.byKey.get("fn:src/b.ts#b")).toMatchObject({ file: "src/b.ts", entry: false, calledFromOutside: true });
    expect(g.byKey.get("fn:src/b.ts#d")).toMatchObject({ entry: true });
    expect(g.byKey.get("mod:src/a.ts")).toMatchObject({ kind: "module", file: "src/a.ts" });
    expect(g.byKey.get("ext:lib/c.ts#c")).toMatchObject({ kind: "external", label: "c ↗ outside scope", resolvedIn: "" });
  });

  it("lays out from the entries and from module code, the two things nothing in the scope calls", () => {
    const g = callGraph("p", sample(), "src");
    expect(g.roots).toEqual(["fn:src/b.ts#d", "mod:src/a.ts"]);
  });

  it("carries each call's count, and marks the external ones", () => {
    const g = callGraph("p", sample(), "src");
    expect(g.edges.find((e) => e.key === "c0")).toMatchObject({ from: "fn:src/a.ts#a", to: "fn:src/b.ts#b", count: 2, external: false });
    expect(g.edges.find((e) => e.key === "c1")).toMatchObject({ to: "ext:lib/c.ts#c", external: true });
  });

  it("lists what a function calls and who calls it, with module code among the callers", () => {
    const g = callGraph("p", sample(), "src");
    const a = callLinks(g, "fn:src/a.ts#a");
    expect(a.calls.map((c) => c.node.name)).toEqual(["b", "c"]);
    expect(a.calledBy.map((c) => c.node.kind)).toEqual(["module"]);
    const b = callLinks(g, "fn:src/b.ts#b");
    expect(b.calledBy.map((c) => [c.node.name, c.count])).toEqual([["a", 2]]);
  });

  it("draws a files-granularity scope with one node per file", () => {
    const flow: ScopeFlow = {
      granularity: "files",
      functions: [],
      calls: [
        { from: "src/a.ts", to: "src/b.ts", count: 3, external: false },
        { from: "src/b.ts", to: "lib/c.ts", count: 1, external: true },
      ],
      externals: [{ id: "lib/c.ts", name: "lib/c.ts", file: "lib/c.ts" }],
      entries: ["src/a.ts"],
      files: [
        { file: "src/a.ts", functions: 1, decisions: 0, loops: 0, tries: 0 },
        { file: "src/b.ts", functions: 1, decisions: 0, loops: 0, tries: 0 },
      ],
      stats: { functions: 2, files: 2, calls: 2, resolved: 1, external: 1, unresolved: 0, inbound: 0, entries: 1 },
    };
    const g = callGraph("p", flow, "src");
    expect(g.byKey.get("file:src/a.ts")).toMatchObject({ kind: "file", entry: true });
    expect(g.byKey.get("ext:lib/c.ts")).toMatchObject({ kind: "external", label: "lib/c.ts ↗ outside scope" });
    expect(g.edges.find((e) => e.key === "c0")).toMatchObject({ from: "file:src/a.ts", to: "file:src/b.ts", count: 3 });
    expect(g.roots).toEqual(["file:src/a.ts"]);
  });
});

describe("layerDepths", () => {
  it("counts the calls on the shortest route from a root", () => {
    const links = [
      { from: "a", to: "b" },
      { from: "a", to: "c" },
      { from: "c", to: "b" },
    ];
    const depth = layerDepths(["a", "b", "c"], ["a"], links);
    expect([...depth]).toEqual([
      ["a", 0],
      ["b", 1],
      ["c", 1],
    ]);
  });

  it("puts a key no root reaches in layer 0", () => {
    const depth = layerDepths(["a", "x"], ["a"], [{ from: "a", to: "a" }]);
    expect(depth.get("x")).toBe(0);
  });
});

describe("gridLayout", () => {
  const size = { w: 10, h: 10, gapX: 2, gapY: 2, layerGap: 5 };

  it("wraps a layer into rows of cols, in the order of the sort text", () => {
    const cells = [
      { key: "e", layer: 0, sort: "5" },
      { key: "a", layer: 0, sort: "1" },
      { key: "b", layer: 0, sort: "2" },
      { key: "c", layer: 0, sort: "3" },
      { key: "d", layer: 0, sort: "4" },
    ];
    const grid = gridLayout(cells, 2, size);
    expect(grid.at.get("a")).toEqual({ x: 0, y: 0 });
    expect(grid.at.get("b")).toEqual({ x: 12, y: 0 });
    expect(grid.at.get("c")).toEqual({ x: 0, y: 12 });
    expect(grid.at.get("d")).toEqual({ x: 12, y: 12 });
    expect(grid.at.get("e")).toEqual({ x: 0, y: 24 });
    expect(grid.width).toBe(22);
  });

  it("stacks each layer under the one above, after its rows and a gap", () => {
    const cells = [
      { key: "a", layer: 0, sort: "" },
      { key: "b", layer: 0, sort: "" },
      { key: "c", layer: 0, sort: "" },
      { key: "d", layer: 0, sort: "" },
      { key: "e", layer: 0, sort: "" },
      { key: "f", layer: 1, sort: "" },
    ];
    const grid = gridLayout(cells, 2, size);
    // Layer 0 takes three rows of 12 and a 5 gap, so layer 1 starts at 41.
    expect(grid.at.get("f")).toEqual({ x: 0, y: 41 });
    expect(grid.height).toBe(53);
  });
});

describe("graphGrid", () => {
  const step = NODE_CELL.w + NODE_CELL.gapX;
  const row = NODE_CELL.h + NODE_CELL.gapY;
  const layer = row + NODE_CELL.layerGap;

  it("puts the roots in layer 0 and each call one layer lower, with externals last", () => {
    const grid = graphGrid(callGraph("p", sample(), "src"));
    // Layer 0: module code (sorts first by file) and d. a is one call below module code, b two below.
    expect(grid.at.get("mod:src/a.ts")).toEqual({ x: 0, y: 0 });
    expect(grid.at.get("fn:src/b.ts#d")).toEqual({ x: step, y: 0 });
    expect(grid.at.get("fn:src/a.ts#a")).toEqual({ x: 0, y: layer });
    expect(grid.at.get("fn:src/b.ts#b")).toEqual({ x: 0, y: 2 * layer });
    expect(grid.at.get("ext:lib/c.ts#c")).toEqual({ x: 0, y: 3 * layer });
    expect(grid.width).toBe(2 * step - NODE_CELL.gapX);
  });

  it("places every node of the graph", () => {
    const g = callGraph("p", sample(), "src");
    const grid = graphGrid(g);
    expect([...grid.at.keys()].sort()).toEqual(g.nodes.map((n) => n.key).sort());
  });
});
