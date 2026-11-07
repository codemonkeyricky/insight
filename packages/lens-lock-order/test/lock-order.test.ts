import { describe, expect, it } from "vitest";
import { irFixtures as fx, type GraphView, type LensFinding } from "@insight/sdk";
import { lensLockOrder, lockOrderEdges } from "../src/index.js";

const ctx = () => ({ root: { path: "/unused", name: "fixture", allowBuildTools: false }, resultOf: () => undefined });

const at = (file: string, line: number) => fx.span(file, line, 4, line, 20);

/** Acquire a then b, released in reverse. */
const lock = (id: string, parent: string, lockName: string, file: string, line: number) =>
  fx.node(id, "sync", "sync.lock-acquire", { parent, attrs: { lock: lockName }, span: at(file, line) });
const unlock = (id: string, parent: string, lockName: string, file: string, line: number) =>
  fx.node(id, "sync", "sync.lock-release", { parent, attrs: { lock: lockName }, span: at(file, line) });

/**
 * f takes A then B. g takes B then A (opposite order: a deadlock risk).
 * h takes A, then calls k, which takes C: an inferred A -> C edge.
 * m takes X, then calls n, which takes X again: a self edge.
 * p and q take D and E in the same order: no cycle.
 */
function fixture() {
  const file = "src/locks.cpp";
  const fn = (name: string, line: number) => fx.node(`${file}#${name}`, "structure", "structure.function", { parent: file, attrs: { name }, span: fx.span(file, line, 0, line + 5, 1) });
  return fx.view({
    nodes: [
      fx.node(file, "structure", "structure.file"),
      fn("f", 0), fn("g", 10), fn("h", 20), fn("k", 30), fn("m", 40), fn("n", 50), fn("p", 60), fn("q", 70),
      lock("f@a", `${file}#f`, "A", file, 1), lock("f@b", `${file}#f`, "B", file, 2),
      unlock("f@ub", `${file}#f`, "B", file, 3), unlock("f@ua", `${file}#f`, "A", file, 4),
      lock("g@b", `${file}#g`, "B", file, 11), lock("g@a", `${file}#g`, "A", file, 12),
      unlock("g@ua", `${file}#g`, "A", file, 13), unlock("g@ub", `${file}#g`, "B", file, 14),
      lock("h@a", `${file}#h`, "A", file, 21),
      lock("k@c", `${file}#k`, "C", file, 31),
      lock("m@x", `${file}#m`, "X", file, 41),
      lock("n@x", `${file}#n`, "X", file, 51),
      lock("p@d", `${file}#p`, "D", file, 61), lock("p@e", `${file}#p`, "E", file, 62),
      lock("q@d", `${file}#q`, "D", file, 71), lock("q@e", `${file}#q`, "E", file, 72),
    ],
    edges: [
      fx.edge(`${file}#h`, `${file}#k`, "calls", "calls.call", { span: at(file, 22) }),
      fx.edge(`${file}#m`, `${file}#n`, "calls", "calls.call", { span: at(file, 42) }),
    ],
  });
}

describe("lockOrderEdges", () => {
  it("records held-before pairs within a function and through a call", () => {
    const { edges, locks } = lockOrderEdges(fixture());
    const pairs = edges.map((e) => `${e.from}>${e.to}`);
    expect(locks).toEqual(["A", "B", "C", "D", "E", "X"]);
    expect(pairs).toContain("A>B");
    expect(pairs).toContain("B>A");
    expect(pairs).toContain("A>C");
    expect(pairs).toContain("X>X");
    expect(pairs).toContain("D>E");
  });

  it("marks cross-call edges as inferred and in-function edges as exact", () => {
    const { edges } = lockOrderEdges(fixture());
    expect(edges.find((e) => e.from === "A" && e.to === "C")?.sites[0]?.confidence).toBe("inferred");
    expect(edges.find((e) => e.from === "A" && e.to === "B")?.sites[0]?.confidence).toBe("exact");
  });

  it("does not order a lock after it has been released", () => {
    const view = fx.view({
      nodes: [
        fx.node("s.cpp#r", "structure", "structure.function", { parent: "s.cpp", attrs: { name: "r" } }),
        lock("r@a", "s.cpp#r", "A", "s.cpp", 1),
        unlock("r@ua", "s.cpp#r", "A", "s.cpp", 2),
        lock("r@b", "s.cpp#r", "B", "s.cpp", 3),
      ],
    });
    expect(lockOrderEdges(view).edges).toHaveLength(0);
  });
});

describe("lensLockOrder", () => {
  it("reports an opposite-order pair as an error with both observing functions", async () => {
    const result = await lensLockOrder.run(fixture(), ctx());
    const cycle = result.findings.find((f) => f.id === "cycle:A|B") as LensFinding;
    expect(cycle).toMatchObject({ severity: "error", lens: "lens-lock-order" });
    expect(cycle.message).toBe("Lock order cycle: A -> B -> A");
    expect(cycle.nodes).toEqual(["src/locks.cpp#f", "src/locks.cpp#g"]);
  });

  it("reports a lock taken again through a call as a warning", async () => {
    const result = await lensLockOrder.run(fixture(), ctx());
    expect(result.findings.find((f) => f.id === "cycle:X")).toMatchObject({ severity: "warning" });
  });

  it("reports nothing for consistent ordering", async () => {
    const result = await lensLockOrder.run(fixture(), ctx());
    expect(result.findings.some((f) => f.id === "cycle:D|E")).toBe(false);
    expect(result.metrics).toMatchObject({ locks: 6, cycles: 2 });
  });

  it("draws the order graph with spans on its edges", async () => {
    const result = await lensLockOrder.run(fixture(), ctx());
    const graph = result.views.find((v): v is GraphView => v.type === "graph");
    expect(graph?.edges.find((e) => e.from === "A" && e.to === "B")?.span).toBeDefined();
  });
});
