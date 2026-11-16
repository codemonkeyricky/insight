import { describe, expect, it } from "vitest";
import type { IREdge, IRDocument, IRNode, NodeId } from "@insight/ir";
import * as fx from "@insight/sdk/testing";
import { buildProjectModel, callerGraph, refsOf, scopeView, type ProjectModel } from "../src/index.js";

const F = "src/x.ts";
const G = "lib/y.ts";
const W = "lib/w.ts";
const TOP = "top.ts";
const fid = (name: string): NodeId => `${F}#${name}`;

function fileNode(path: string): IRNode {
  return fx.node(path, "structure", "structure.file", { attrs: { path }, span: fx.span(path, 0, 0, 0, 0) });
}

function fnNode(path: string, name: string, line: number, extra: { parent?: string; anonymous?: boolean } = {}): IRNode {
  return fx.node(extra.anonymous ? `${path}#<lambda>` : `${path}#${name}`, "structure", "structure.function", {
    attrs: extra.anonymous ? { name: "<lambda>", anonymous: true } : { name },
    parent: extra.parent ?? path,
    span: fx.span(path, line, 0, line + 2, 1),
  });
}

/** A call from one node to another (or to a candidate list), with its call site in F. */
function call(from: NodeId, to: NodeId | NodeId[], line = 1): IREdge {
  return fx.edge(from, to, "calls", "calls.call", { span: fx.span(F, line, 0, line, 1) });
}

/** A model of functions named in F, plus the file nodes of F, G, W and TOP. */
function modelOf(names: string[], edges: IREdge[], extra: IRNode[] = []): ProjectModel {
  const nodes = [fileNode(F), fileNode(G), fileNode(W), fileNode(TOP), ...names.map((n, i) => fnNode(F, n, i * 3)), ...extra];
  return buildProjectModel({ nodes, edges, findings: [] });
}

describe("callerGraph: chains and diamonds", () => {
  it("returns an empty graph with zero stats for an id the model does not hold", () => {
    const m = modelOf(["T"], []);
    expect(callerGraph(scopeView(m, ""), "nope#missing")).toEqual({
      root: "nope#missing",
      nodes: [],
      edges: [],
      cycles: [],
      stats: { callers: 0, levels: 0, possible: 0, blind: 0, outsideScope: 0 },
    });
  });

  it("walks a chain A -> B -> T level by level, with the root at depth 0", () => {
    const m = modelOf(["A", "B", "T"], [call(fid("A"), fid("B")), call(fid("B"), fid("T"), 2)]);
    const g = callerGraph(scopeView(m, ""), fid("T"));
    expect(g.nodes.map((n) => [n.id, n.depth])).toEqual([
      [fid("T"), 0],
      [fid("B"), 1],
      [fid("A"), 2],
    ]);
    expect(g.edges.map((e) => [e.from, e.to, e.kind, e.candidate, e.count, e.back])).toEqual([
      [fid("B"), fid("T"), "call", false, 1, false],
      [fid("A"), fid("B"), "call", false, 1, false],
    ]);
    expect(g.nodes.find((n) => n.id === fid("A"))).toMatchObject({ certainty: "exact", stop: "none" });
    expect(g.stats).toEqual({ callers: 2, levels: 2, possible: 0, blind: 0, outsideScope: 0 });
    expect(g.truncated).toBeUndefined();
  });

  it("lists a diamond once: A at depth 2 with two outgoing edges, and no duplicate node", () => {
    const m = modelOf(["A", "B", "C", "T"], [call(fid("A"), fid("B")), call(fid("A"), fid("C")), call(fid("B"), fid("T")), call(fid("C"), fid("T"))]);
    const g = callerGraph(scopeView(m, ""), fid("T"));
    const ids = g.nodes.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(g.nodes.find((n) => n.id === fid("A"))?.depth).toBe(2);
    expect(g.edges.filter((e) => e.from === fid("A"))).toHaveLength(2);
    expect(g.edges).toHaveLength(4);
  });
});

describe("callerGraph: cycles", () => {
  it("terminates on self-recursion, and marks the self-loop as a back edge", () => {
    const m = modelOf(["T"], [call(fid("T"), fid("T"))]);
    const g = callerGraph(scopeView(m, ""), fid("T"));
    expect(g.nodes).toHaveLength(1);
    expect(g.cycles).toEqual([[fid("T")]]);
    expect(g.edges).toEqual([expect.objectContaining({ from: fid("T"), to: fid("T"), back: true })]);
    expect(g.stats.callers).toBe(0);
  });

  it("terminates on the mutual recursion B -> C -> B -> T, with the closing edge marked back", () => {
    const m = modelOf(["B", "C", "T"], [call(fid("B"), fid("C")), call(fid("C"), fid("B")), call(fid("B"), fid("T"), 2)]);
    const g = callerGraph(scopeView(m, ""), fid("T"));
    expect(g.nodes.map((n) => n.id).sort()).toEqual([fid("B"), fid("C"), fid("T")].sort());
    expect(g.cycles).toEqual([[fid("B"), fid("C")]]);
    const closing = g.edges.find((e) => e.from === fid("B") && e.to === fid("C"));
    expect(closing?.back).toBe(true);
    expect(g.edges.find((e) => e.from === fid("B") && e.to === fid("T"))?.back).toBe(false);
  });
});

describe("callerGraph: possible relations", () => {
  // Q and T are the candidates of A's call. C calls A exactly.
  const m = modelOf(["T", "Q", "A", "C"], [fx.edge(fid("A"), [fid("T"), fid("Q")], "calls", "calls.call", { span: fx.span(F, 3, 0, 3, 1) }), call(fid("C"), fid("A"), 6)]);

  it("lists a candidate caller as possible and does not expand it by default", () => {
    const g = callerGraph(scopeView(m, ""), fid("T"));
    expect(g.nodes.find((n) => n.id === fid("A"))).toMatchObject({ depth: 1, certainty: "possible", stop: "possible-off" });
    expect(g.edges).toEqual([expect.objectContaining({ from: fid("A"), to: fid("T"), kind: "call", candidate: true })]);
    expect(g.nodes.some((n) => n.id === fid("C"))).toBe(false);
  });

  it("expands a possible caller when possible is on, and its callers stay possible", () => {
    const g = callerGraph(scopeView(m, ""), fid("T"), { possible: true });
    expect(g.nodes.find((n) => n.id === fid("A"))).toMatchObject({ certainty: "possible" });
    expect(g.nodes.find((n) => n.id === fid("A"))?.stop).toBeUndefined();
    expect(g.nodes.find((n) => n.id === fid("C"))).toMatchObject({ depth: 2, certainty: "possible" });
  });

  it("ends a node reached both possibly and exactly as exact, and still expands it", () => {
    // A reaches T only as a candidate, but A also calls B exactly, and B calls T exactly.
    const both = modelOf(["T", "Q", "A", "B"], [
      fx.edge(fid("A"), [fid("T"), fid("Q")], "calls", "calls.call", { span: fx.span(F, 3, 0, 3, 1) }),
      call(fid("B"), fid("T"), 6),
      call(fid("A"), fid("B"), 9),
    ]);
    const g = callerGraph(scopeView(both, ""), fid("T"));
    expect(g.nodes.find((n) => n.id === fid("A"))).toMatchObject({ certainty: "exact", stop: "none" });
    expect(g.edges.find((e) => e.from === fid("A") && e.to === fid("T"))?.candidate).toBe(true);
  });
});

describe("callerGraph: blind spots", () => {
  it("sets blind value on a function passed as a value", () => {
    const m = modelOf(["A", "T"], [fx.edge(fid("A"), fid("T"), "calls", "calls.reference", { attrs: { how: "value" }, span: fx.span(F, 4, 0, 4, 1) })]);
    const g = callerGraph(scopeView(m, ""), fid("T"));
    expect(g.nodes.find((n) => n.id === fid("T"))?.blind).toEqual(["value"]);
    expect(g.stats.blind).toBe(1);
  });

  it("sets blind truncated on the target of a truncated candidate set", () => {
    const m = modelOf(["A", "T", "Q"], [fx.edge(fid("A"), [fid("T"), fid("Q")], "calls", "calls.call", { attrs: { truncated: true }, span: fx.span(F, 3, 0, 3, 1) })]);
    const g = callerGraph(scopeView(m, ""), fid("T"));
    expect(g.nodes.find((n) => n.id === fid("T"))?.blind).toEqual(["truncated"]);
  });
});

describe("callerGraph: folding", () => {
  it("folds an anonymous caller into its owner, with the count", () => {
    const lambda = fnNode(F, "", 5, { anonymous: true, parent: fid("A") });
    const m = modelOf(["A", "T"], [call(lambda.id, fid("T"), 6), call(lambda.id, fid("T"), 7)], [lambda]);
    const g = callerGraph(scopeView(m, ""), fid("T"));
    expect(g.nodes.some((n) => n.id === lambda.id)).toBe(false);
    expect(g.edges).toEqual([expect.objectContaining({ from: fid("A"), to: fid("T"), count: 2, kind: "call" })]);
  });

  it("labels a spawn caller with what it spawns, and names the function that starts it", () => {
    const spawn = fx.node(`${F}@spawn:2:0`, "concurrency", "concurrency.spawn-thread", {
      parent: fid("main"),
      attrs: { api: "Worker" },
      span: fx.span(F, 2, 0, 2, 9),
    });
    const spawns = fx.edge(spawn.id, fid("T"), "concurrency", "concurrency.spawns", { attrs: { how: "thread" }, span: fx.span(F, 2, 0, 2, 9) });
    const m = modelOf(["main", "T"], [spawns], [spawn]);
    const g = callerGraph(scopeView(m, ""), fid("T"));
    expect(g.nodes.find((n) => n.id === fid("main"))?.name).toBe("main");
    expect(g.edges).toEqual([expect.objectContaining({ from: fid("main"), to: fid("T"), kind: "spawn", label: "spawns Worker" })]);
  });

  it("makes a module top-level caller a leaf with stop module", () => {
    const m = modelOf(["T"], [fx.edge(TOP, fid("T"), "calls", "calls.call", { span: fx.span(TOP, 0, 0, 0, 3) })]);
    const g = callerGraph(scopeView(m, ""), fid("T"));
    expect(g.nodes.find((n) => n.id === TOP)).toMatchObject({ depth: 1, isFunction: false, stop: "module" });
  });
});

describe("callerGraph: scope and caps", () => {
  // T and inner are in src/x.ts. outer is in lib/y.ts, outside the scope "src".
  const m = modelOf(["T", "inner"], [call(`${G}#outer`, fid("T")), call(fid("inner"), `${G}#outer`, 9)], [fnNode(G, "outer", 0)]);

  it("lists a caller outside the scope and does not expand it with stayInScope", () => {
    const g = callerGraph(scopeView(m, "src"), fid("T"), { stayInScope: true });
    expect(g.nodes.find((n) => n.id === `${G}#outer`)).toMatchObject({ inScope: false, stop: "outside-scope" });
    expect(g.nodes.some((n) => n.id === fid("inner"))).toBe(false);
    expect(g.stats.outsideScope).toBe(1);
  });

  it("expands the outside caller when stayInScope is off", () => {
    const g = callerGraph(scopeView(m, "src"), fid("T"));
    expect(g.nodes.find((n) => n.id === fid("inner"))?.depth).toBe(2);
  });

  it("stops at maxDepth 1 with the hidden count and a depth truncation", () => {
    const chain = modelOf(["A", "B", "T"], [call(fid("A"), fid("B")), call(fid("B"), fid("T"), 2)]);
    const g = callerGraph(scopeView(chain, ""), fid("T"), { maxDepth: 1 });
    expect(g.nodes.map((n) => n.id)).toEqual([fid("T"), fid("B")]);
    expect(g.nodes[1]).toMatchObject({ stop: "depth", hidden: 1 });
    expect(g.truncated).toEqual({ reason: "depth", at: 1 });
  });

  it("gives a node at maxDepth with no callers stop none, and no truncation", () => {
    const chain = modelOf(["A", "B", "T"], [call(fid("A"), fid("B")), call(fid("B"), fid("T"), 2)]);
    const g = callerGraph(scopeView(chain, ""), fid("T"), { maxDepth: 2 });
    expect(g.nodes.find((n) => n.id === fid("A"))).toMatchObject({ depth: 2, stop: "none" });
    expect(g.nodes.find((n) => n.id === fid("A"))?.hidden).toBeUndefined();
    expect(g.truncated).toBeUndefined();
  });

  it("stops at maxNodes 3 with a node truncation and a hidden count, and stays stable", () => {
    const callers = ["C1", "C2", "C3", "C4"];
    const fan = modelOf(["T", ...callers], callers.map((c) => call(fid(c), fid("T"))));
    const view = scopeView(fan, "");
    const first = callerGraph(view, fid("T"), { maxNodes: 3 });
    expect(first.nodes).toHaveLength(3);
    expect(first.truncated).toEqual({ reason: "nodes", at: 1 });
    expect(first.nodes[0]?.hidden).toBeGreaterThan(0);
    expect(callerGraph(view, fid("T"), { maxNodes: 3 })).toEqual(first);
  });
});

describe("callerGraph: a forced node cut by maxNodes", () => {
  // f0 reaches f3 exactly only through f6, and f6 is forced into the walk in an earlier pass. With maxNodes 5 the final walk
  // no longer admits f6, so f0 has no exact path. It must not be expanded as a possible caller.
  const pairs: Array<[number, number | number[]]> = [
    [2, [1, 0]], [5, [0, 6]], [6, [5, 0]], [0, [4, 3]], [1, [1, 5]], [4, [0, 6]], [0, 1], [3, [1, 3]], [4, 3], [6, 4],
    [5, [2, 6]], [5, [0, 2]], [2, [5, 5]], [0, 6], [1, 2],
  ];
  const f = (n: number): NodeId => `${F}#f${n}`;
  const nodes = [fileNode(F), ...[0, 1, 2, 3, 4, 5, 6].map((n) => fnNode(F, `f${n}`, n * 3))];
  const edges = pairs.map(([from, to], i) => fx.edge(f(from), Array.isArray(to) ? to.map(f) : f(to), "calls", "calls.call", { span: fx.span(F, i + 1, 0, i + 1, 1) }));
  const m = buildProjectModel({ nodes, edges, findings: [] });

  it("never expands a node whose certainty is possible when possible is off", () => {
    const g = callerGraph(scopeView(m, ""), f(3), { maxNodes: 5, maxDepth: 3 });
    const expandedPossible = g.nodes.filter((n, i) => i > 0 && n.certainty === "possible" && n.stop === undefined);
    expect(expandedPossible.map((n) => n.id)).toEqual([]);
    expect(g.nodes.find((n) => n.id === f(0))).toMatchObject({ certainty: "possible", stop: "possible-off" });
  });

  it("never labels an exact node possible-off, for any maxNodes from 1 to 15", () => {
    for (let maxNodes = 1; maxNodes <= 15; maxNodes++) {
      const g = callerGraph(scopeView(m, ""), f(3), { maxNodes, maxDepth: 3 });
      expect(
        g.nodes.filter((n) => n.certainty === "exact" && n.stop === "possible-off").map((n) => n.id),
        `maxNodes ${maxNodes}`,
      ).toEqual([]);
    }
  });
});

describe("callerGraph: stop order before the depth cap", () => {
  it("gives a possible-only caller at maxDepth stop possible-off, with no hidden count and no truncation", () => {
    // B calls T exactly. P is a candidate caller of B (possible only), and X calls P exactly, so P has a caller of its own.
    const m = modelOf(["T", "B", "P", "Q", "X"], [call(fid("B"), fid("T"), 2), fx.edge(fid("P"), [fid("B"), fid("Q")], "calls", "calls.call", { span: fx.span(F, 3, 0, 3, 1) }), call(fid("X"), fid("P"), 4)]);
    const g = callerGraph(scopeView(m, ""), fid("T"), { maxDepth: 2 });
    expect(g.nodes.find((n) => n.id === fid("P"))).toMatchObject({ depth: 2, certainty: "possible", stop: "possible-off" });
    expect(g.nodes.find((n) => n.id === fid("P"))?.hidden).toBeUndefined();
    expect(g.nodes.some((n) => n.id === fid("X"))).toBe(false);
    expect(g.truncated).toBeUndefined();
  });

  it("gives an exact caller at maxDepth with callers of its own stop depth, a hidden count and a depth truncation", () => {
    const chain = modelOf(["A", "B", "T", "Z"], [call(fid("A"), fid("B")), call(fid("B"), fid("T"), 2), call(fid("Z"), fid("A"), 4)]);
    const g = callerGraph(scopeView(chain, ""), fid("T"), { maxDepth: 2 });
    expect(g.nodes.find((n) => n.id === fid("A"))).toMatchObject({ depth: 2, certainty: "exact", stop: "depth", hidden: 1 });
    expect(g.truncated).toEqual({ reason: "depth", at: 2 });
  });

  it("gives an outside-scope caller at maxDepth stop outside-scope, not depth, with stayInScope on", () => {
    const m = modelOf(
      ["T", "B", "inner"],
      [call(fid("B"), fid("T"), 2), call(`${G}#outer`, fid("B"), 4), call(fid("inner"), `${G}#outer`, 9)],
      [fnNode(G, "outer", 0)],
    );
    const g = callerGraph(scopeView(m, "src"), fid("T"), { maxDepth: 2, stayInScope: true });
    expect(g.nodes.find((n) => n.id === `${G}#outer`)).toMatchObject({ depth: 2, inScope: false, stop: "outside-scope" });
    expect(g.nodes.find((n) => n.id === `${G}#outer`)?.hidden).toBeUndefined();
    expect(g.truncated).toBeUndefined();
  });
});

/**
 * A fixture with every relation kind: a direct call, an anonymous caller, a closure, a candidate set, module-level
 * code (a call and a dispatch), a `new` reference, a value reference, and a spawn of a module worker.
 */
function richDoc(): IRDocument {
  const worker = `${W}#(module)`;
  const lambda = `${F}#<lambda>`;
  const spawn = `${F}@spawn:2:0`;
  const nodes: IRNode[] = [
    fileNode(F),
    fileNode(G),
    fileNode(W),
    fileNode(TOP),
    fnNode(F, "a", 1),
    fnNode(G, "b", 1),
    fnNode(F, "c", 4),
    fnNode(F, "main", 7),
    fnNode(F, "", 5, { anonymous: true, parent: fid("a") }),
    fx.node(worker, "structure", "structure.function", { attrs: { name: "(module)", module: true }, parent: W, span: fx.span(W, 0, 0, 2, 1) }),
    fx.node(spawn, "concurrency", "concurrency.spawn-thread", { parent: fid("main"), attrs: { api: "Worker" }, span: fx.span(F, 8, 0, 8, 9) }),
  ];
  const edges: IREdge[] = [
    call(fid("a"), `${G}#b`, 3),
    call(lambda, `${G}#b`, 5),
    fx.edge(fid("a"), lambda, "calls", "calls.reference", { attrs: { how: "closure" } }),
    fx.edge(fid("c"), [fid("a"), `${G}#b`], "calls", "calls.call", { span: fx.span(F, 4, 0, 4, 4) }),
    fx.edge(TOP, fid("a"), "calls", "calls.call", { span: fx.span(TOP, 0, 0, 0, 3) }),
    fx.edge(TOP, `${G}#b`, "concurrency", "concurrency.dispatches", { span: fx.span(TOP, 1, 0, 1, 9) }),
    fx.edge(TOP, fid("c"), "calls", "calls.reference", { attrs: { how: "new" }, span: fx.span(TOP, 2, 0, 2, 5) }),
    fx.edge(fid("main"), fid("a"), "calls", "calls.reference", { attrs: { how: "value" }, span: fx.span(F, 9, 0, 9, 1) }),
    fx.edge(spawn, worker, "concurrency", "concurrency.spawns", { attrs: { how: "thread" }, span: fx.span(F, 8, 0, 8, 9) }),
  ];
  return { nodes, edges, findings: [] };
}

describe("callerGraph: invariant against refsOf", () => {
  it("has depth-1 nodes and edges equal to refsOf().calledBy for every function", () => {
    const m = buildProjectModel(richDoc());
    const view = scopeView(m, "src");
    const key = (r: { id: NodeId; kind: string; count: number; candidate: boolean; inScope: boolean }) => JSON.stringify([r.id, r.kind, r.count, r.candidate, r.inScope]);
    for (const f of m.functions) {
      const expected = refsOf(view, f.id).calledBy.map(key).sort();
      const g = callerGraph(view, f.id);
      const inScopeOf = new Map(g.nodes.map((n) => [n.id, n.inScope]));
      const actual = g.edges
        .filter((e) => e.to === f.id)
        .map((e) => key({ id: e.from, kind: e.kind, count: e.count, candidate: e.candidate, inScope: inScopeOf.get(e.from) ?? false }))
        .sort();
      expect(actual, f.id).toEqual(expected);
    }
  });
});

describe("callerGraph: determinism", () => {
  it("gives deep-equal output when doc.edges is reversed or rotated", () => {
    const doc = richDoc();
    const forward = buildProjectModel(doc);
    const reversed = buildProjectModel({ ...doc, edges: [...doc.edges].reverse() });
    const rotated = buildProjectModel({ ...doc, edges: [...doc.edges.slice(3), ...doc.edges.slice(0, 3)] });
    for (const f of forward.functions) {
      const base: CallerGraphOut = callerGraph(scopeView(forward, "src"), f.id, { possible: true });
      expect(callerGraph(scopeView(reversed, "src"), f.id, { possible: true }), f.id).toEqual(base);
      expect(callerGraph(scopeView(rotated, "src"), f.id, { possible: true }), f.id).toEqual(base);
    }
  });
});

describe("callerGraph: a nested function called directly", () => {
  // outer calls its nested declaration visit directly, and visit calls itself. The frontend makes no closure edge
  // for a nested declaration, so visit is not passed as a value anywhere.
  const m = modelOf(["outer", "visit"], [call(fid("outer"), fid("visit"), 1), call(fid("visit"), fid("visit"), 5)]);

  it("does not report a nested function that is only called as passed as a value", () => {
    const g = callerGraph(scopeView(m, ""), fid("visit"));
    expect(g.nodes.find((n) => n.id === fid("visit"))?.blind ?? []).not.toContain("value");
    expect(g.stats.blind).toBe(0);
  });

  it("lists the nested function once in its creator's calls", () => {
    const refs = refsOf(scopeView(m, ""), fid("outer"));
    expect(refs.calls.filter((r) => r.id === fid("visit"))).toHaveLength(1);
  });
});
describe("callerGraph: one how per caller, shared with the reference rows", () => {
  const ref = (how: string, line: number) => fx.edge(fid("K"), fid("T"), "calls", "calls.reference", { attrs: { how }, span: fx.span(F, line, 0, line, 5) });
  const howOf = (m: ProjectModel, how: "edge" | "row") =>
    how === "edge" ? callerGraph(scopeView(m, ""), fid("T")).edges.find((e) => e.from === fid("K") && e.to === fid("T"))?.how : refsOf(scopeView(m, ""), fid("T")).calledBy[0]?.how;

  it("an invoking how wins over an alphabetically smaller non-invoking one, in the chain and the box alike", () => {
    // K both creates a closure of T and renders it: the box must not say closure while the row says jsx.
    const m = modelOf(["K", "T"], [ref("closure", 1), ref("jsx", 2)]);
    expect(howOf(m, "edge")).toBe("jsx");
    expect(howOf(m, "row")).toBe("jsx");
    expect(howOf(m, "edge")).toBe(howOf(m, "row"));
  });

  it("keeps the alphabetically smallest when both hows are non-invoking, in either order", () => {
    for (const hows of [["value", "closure"], ["closure", "value"]]) {
      const m = modelOf(["K", "T"], hows.map((h, i) => ref(h, i + 1)));
      expect(howOf(m, "edge")).toBe("closure");
      expect(howOf(m, "row")).toBe("closure");
    }
  });
});

type CallerGraphOut = ReturnType<typeof callerGraph>;
