import { afterEach, describe, expect, it } from "vitest";
import type { FlowEdge, FlowNode } from "@insight/flow";
import { MARCH_BUDGET, backEdgeFlags, claimMarch, connectorClass, edgeMotions, releaseMarch } from "../src/zoom/flowMotion.js";

// Hand-built charts shaped like the layout's output: a for-of loop (a loop head, its body, and an exit) and a while loop.
const node = (id: string, shape: FlowNode["shape"], y: number): FlowNode =>
  ({ id, role: "step", shape, label: id, x: 0, y, w: 100, h: 30 }) as FlowNode;
const edge = (from: string, to: string, kind: FlowEdge["kind"]): FlowEdge => ({ from, to, kind, points: [] });

describe("back-edge detection", () => {
  it("finds the return of a for-of loop, marked by the layout", () => {
    const nodes = [node("start", "terminator", 0), node("head", "loop", 60), node("body", "process", 120), node("done", "terminator", 180)];
    const edges = [edge("start", "head", "next"), edge("head", "body", "each"), edge("body", "head", "back"), edge("head", "done", "exit")];
    expect(backEdgeFlags(nodes, edges)).toEqual([false, false, true, false]);
  });

  it("finds the return of a while loop when the layout did not mark it (from below the head)", () => {
    const nodes = [node("head", "loop", 60), node("body", "process", 120), node("after", "terminator", 180)];
    const edges = [edge("head", "body", "true"), edge("body", "head", "next"), edge("head", "after", "false")];
    expect(backEdgeFlags(nodes, edges)).toEqual([false, true, false]);
  });
});

describe("edge motion", () => {
  const back = [false, false, true];

  it("animates nothing when off or under reduced motion", () => {
    const none = { march: false, pulse: false };
    expect(edgeMotions(back, { on: false, reduced: false, budget: 300 })).toEqual([none, none, none]);
    expect(edgeMotions(back, { on: true, reduced: true, budget: 300 })).toEqual([none, none, none]);
  });

  it("marches every edge and pulses only the back-edge when the budget covers the chart", () => {
    expect(edgeMotions(back, { on: true, reduced: false, budget: 300 })).toEqual([
      { march: true, pulse: false },
      { march: true, pulse: false },
      { march: true, pulse: true },
    ]);
  });

  it("past the budget, only the back-edges march", () => {
    expect(edgeMotions(back, { on: true, reduced: false, budget: 2 })).toEqual([
      { march: false, pulse: false },
      { march: false, pulse: false },
      { march: true, pulse: true },
    ]);
  });
});

describe("connector class", () => {
  it("draws in on open and retracts on close; reduced motion only fades", () => {
    expect(connectorClass(false, false)).toContain("is-opening");
    expect(connectorClass(true, false)).toContain("is-closing");
    expect(connectorClass(false, true)).toBe("zm-connector-group is-fade");
    expect(connectorClass(true, true)).not.toContain("is-closing");
  });
});

describe("the shared march budget", () => {
  afterEach(() => {
    for (const k of ["a", "b", "c"]) releaseMarch(k);
  });

  it("gives each chart what the earlier open charts leave", () => {
    expect(claimMarch("a", 200)).toBe(MARCH_BUDGET);
    expect(claimMarch("b", 200)).toBe(MARCH_BUDGET - 200);
    expect(claimMarch("c", 200)).toBe(0);
  });

  it("frees a chart's claim when it leaves", () => {
    claimMarch("a", 200);
    releaseMarch("a");
    expect(claimMarch("b", 50)).toBe(MARCH_BUDGET);
  });
});
