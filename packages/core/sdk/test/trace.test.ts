import { describe, expect, it } from "vitest";
import { irFixtures as fx, trace, findCycles, enclosing, ownerOf } from "../src/index.js";

/** a -> b -> c, a -> x (x is unresolved), c -> a (cycle), b -> {d|e} (candidates), d -> stop. */
function graph() {
  const fnNodes = ["a", "b", "c", "d", "e", "stop", "after"].map((id) => fx.node(id, "structure", "structure.function"));
  const edges = [
    fx.edge("a", "b", "calls", "calls.call"),
    fx.edge("b", "c", "calls", "calls.call"),
    fx.edge("c", "a", "calls", "calls.call"),
    fx.edge("a", { unresolved: { scheme: "ts.import", text: "lodash" } }, "calls", "calls.call"),
    fx.edge("b", ["d", "e"], "calls", "calls.call"),
    fx.edge("d", "stop", "calls", "calls.call"),
    fx.edge("stop", "after", "calls", "calls.call"),
  ];
  return fx.view({ nodes: fnNodes, edges });
}

describe("trace", () => {
  it("follows out-edges breadth first and records depth and shortest path", () => {
    const reach = trace(graph(), ["a"], { follow: ["calls.call"] });
    expect(reach.nodes.get("a")).toBe(0);
    expect(reach.nodes.get("b")).toBe(1);
    expect(reach.nodes.get("c")).toBe(2);
    expect(reach.pathsTo("c")).toEqual(["a", "b", "c"]);
    expect(reach.pathsTo("nope")).toBeUndefined();
  });

  it("reports cycles and dead ends instead of dropping them", () => {
    const reach = trace(graph(), ["a"], { follow: ["calls.call"] });
    expect(reach.cycles).toEqual([["a", "b", "c"]]);
    expect(reach.deadEnds).toHaveLength(1);
    expect(reach.deadEnds[0]).toMatchObject({ from: "a", unresolved: { scheme: "ts.import", text: "lodash" } });
  });

  it("follows candidate sets only when uncertain is may", () => {
    const may = trace(graph(), ["b"], { follow: ["calls.call"], uncertain: "may" });
    expect(may.nodes.has("d")).toBe(true);
    expect(may.nodes.has("e")).toBe(true);
    const exact = trace(graph(), ["b"], { follow: ["calls.call"], uncertain: "exact" });
    expect(exact.nodes.has("d")).toBe(false);
    expect(exact.nodes.has("c")).toBe(true);
  });

  it("stops expanding at nodes that match stopAt, but still reaches them", () => {
    const reach = trace(graph(), ["d"], {
      follow: ["calls.call"],
      stopAt: (n) => n.id === "stop",
    });
    expect(reach.nodes.has("stop")).toBe(true);
    expect(reach.nodes.has("after")).toBe(false);
  });

  it("does not stop start nodes even when they match stopAt", () => {
    const reach = trace(graph(), ["stop"], { follow: ["calls.call"], stopAt: (n) => n.id === "stop" });
    expect(reach.nodes.has("after")).toBe(true);
  });

  it("respects maxDepth", () => {
    const reach = trace(graph(), ["a"], { follow: ["calls.call"], maxDepth: 1 });
    expect(reach.nodes.has("b")).toBe(true);
    expect(reach.nodes.has("c")).toBe(false);
  });

  it("walks inward with direction in and reports who points at the start", () => {
    const reach = trace(graph(), ["c"], { follow: ["calls.call"], direction: "in" });
    expect(reach.nodes.get("b")).toBe(1);
    expect(reach.nodes.get("a")).toBe(2);
    expect(reach.pathsTo("a")).toEqual(["c", "b", "a"]);
  });

  it("follows subkinds of a followed kind", () => {
    const edges = [fx.edge("p", "q", "concurrency", "concurrency.spawns")];
    const view = fx.view({ nodes: [fx.node("p", "concurrency", "concurrency.spawn-thread"), fx.node("q", "structure", "structure.function")], edges });
    const reach = trace(view, ["p"], { follow: ["concurrency.spawns"] });
    expect(reach.nodes.has("q")).toBe(true);
  });
});

describe("findCycles", () => {
  it("returns strongly connected groups of two or more and self loops, sorted", () => {
    const adj = new Map<string, string[]>([
      ["a", ["b"]],
      ["b", ["a"]],
      ["c", ["c"]],
      ["d", ["a"]],
    ]);
    expect(findCycles(["a", "b", "c", "d"], adj)).toEqual([["a", "b"], ["c"]]);
  });
});

describe("enclosing and ownerOf", () => {
  it("finds the nearest ancestor of a kind, counting the node itself", () => {
    const view = fx.view({
      nodes: [
        fx.node("file", "structure", "structure.file"),
        fx.node("file#f", "structure", "structure.function", { parent: "file" }),
        fx.node("file@eff", "effects", "effects.fs.read", { parent: "file#f" }),
      ],
    });
    expect(enclosing(view, "file@eff", "structure.function")?.id).toBe("file#f");
    expect(enclosing(view, "file#f", "structure.function")?.id).toBe("file#f");
    expect(ownerOf(view, "file@eff")?.id).toBe("file#f");
  });

  it("falls back to the file for module-level nodes", () => {
    const view = fx.view({
      nodes: [fx.node("file", "structure", "structure.file"), fx.node("file@eff", "effects", "effects.env.read", { parent: "file" })],
    });
    expect(ownerOf(view, "file@eff")?.id).toBe("file");
  });
});
