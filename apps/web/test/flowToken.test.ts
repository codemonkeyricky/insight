import { describe, expect, it } from "vitest";
import type { FlowEdge, FlowNode } from "@insight/flow";
import { LOOP_PASSES, TOKEN_MAX_LEGS, createTokenWalker } from "../src/zoom/flowToken.js";

const node = (id: string, shape: FlowNode["shape"], role: FlowNode["role"] = "step"): FlowNode =>
  ({ id, role, shape, label: id, x: 0, y: 0, w: 100, h: 30 }) as FlowNode;
const edge = (from: string, to: string, kind: FlowEdge["kind"]): FlowEdge => ({ from, to, kind, points: [] });

/** The routes of the first `runs` runs from one walker. */
const runsOf = (nodes: FlowNode[], edges: FlowEdge[], runs: number) => {
  const walk = createTokenWalker(nodes, edges);
  return Array.from({ length: runs }, () => walk());
};

describe("token walker: a for-of loop", () => {
  // start -> head (loop) -> body -> head (back-edge), and head -> done (exit).
  const nodes = [node("start", "terminator", "start"), node("head", "loop", "loop"), node("body", "step"), node("done", "terminator", "end")];
  const edges = [edge("start", "head", "next"), edge("head", "body", "each"), edge("body", "head", "back"), edge("head", "done", "exit")];

  it("goes round the loop LOOP_PASSES times on every run, then takes the exit", () => {
    expect(LOOP_PASSES).toBe(2);
    for (const r of runsOf(nodes, edges, 3)) {
      expect(r).toEqual({ nodes: ["start", "head", "body", "head", "body", "head", "done"], edges: [0, 1, 2, 1, 2, 3] });
    }
  });
});

describe("token walker: a branch", () => {
  // start -> decide; decide -false-> no and decide -true-> yes (listed no first); both go to end.
  const nodes = [node("start", "terminator", "start"), node("decide", "decision", "branch"), node("no", "step"), node("yes", "step"), node("end", "terminator", "end")];
  const edges = [edge("start", "decide", "next"), edge("decide", "no", "false"), edge("decide", "yes", "true"), edge("yes", "end", "next"), edge("no", "end", "next")];

  it("takes the yes path first, whatever order the edges are listed in", () => {
    expect(runsOf(nodes, edges, 1)[0]).toEqual({ nodes: ["start", "decide", "yes", "end"], edges: [0, 2, 3] });
  });

  it("alternates yes and no on successive runs, least-taken first", () => {
    const [a, b, c] = runsOf(nodes, edges, 3);
    expect(b).toEqual({ nodes: ["start", "decide", "no", "end"], edges: [0, 1, 4] });
    expect(c).toEqual({ nodes: ["start", "decide", "yes", "end"], edges: [0, 2, 3] });
    expect(a?.nodes[2]).toBe("yes");
  });
});

// start -> A; A -yes-> retA (return); A -no-> B; B -yes-> head (loop, body -back-> head, exit -> end); B -no-> endB; all branch
// edges are nested behind A, so a branch's choice must not be tied to another's.
const nested = () => {
  const nodes = [
    node("start", "terminator", "start"),
    node("A", "decision", "branch"),
    node("retA", "exit", "return"),
    node("B", "decision", "branch"),
    node("head", "loop", "loop"),
    node("body", "step"),
    node("end", "terminator", "end"),
    node("endB", "terminator", "end"),
  ];
  const edges = [
    edge("start", "A", "next"), // 0
    edge("A", "retA", "true"), // 1
    edge("A", "B", "false"), // 2
    edge("B", "head", "true"), // 3
    edge("B", "endB", "false"), // 4
    edge("head", "body", "each"), // 5
    edge("body", "head", "back"), // 6
    edge("head", "end", "exit"), // 7
  ];
  return { nodes, edges };
};

describe("token walker: coverage", () => {
  it("reaches the back-edge behind a nested branch within (branch edges + 1) runs", () => {
    const { nodes, edges } = nested();
    const branchEdges = edges.filter((e) => e.from === "A" || e.from === "B").length;
    const walk = createTokenWalker(nodes, edges);
    let run = 0;
    let seen = false;
    while (!seen && run < branchEdges + 1) {
      seen = walk().edges.includes(6);
      run++;
    }
    expect(seen).toBe(true);
    expect(run).toBeLessThanOrEqual(branchEdges + 1);
  });

  it("covers every edge of a nested chart within a bounded number of runs", () => {
    const { nodes, edges } = nested();
    const walk = createTokenWalker(nodes, edges);
    const covered = new Set<number>();
    let run = 0;
    while (covered.size < edges.length && run < 4 * edges.length) {
      for (const i of walk().edges) covered.add(i);
      run++;
    }
    expect([...covered].sort((a, b) => a - b)).toEqual(edges.map((_, i) => i));
    expect(run).toBeLessThanOrEqual(4 * edges.length);
  });
});

describe("token walker: termination", () => {
  it("stays on the start node of a chart with no edges", () => {
    expect(createTokenWalker([node("start", "terminator", "start")], [])()).toEqual({ nodes: ["start"], edges: [] });
  });

  it("returns an empty route for a chart with no nodes", () => {
    expect(createTokenWalker([], [])()).toEqual({ nodes: [], edges: [] });
  });

  it("stops at a node with no way on", () => {
    const nodes = [node("a", "terminator", "start"), node("b", "terminator", "end")];
    expect(createTokenWalker(nodes, [edge("a", "b", "next")])()).toEqual({ nodes: ["a", "b"], edges: [0] });
  });

  it("stops a cycle that has no loop head, at the leg cap", () => {
    const nodes = [node("a", "step"), node("b", "step")];
    const r = createTokenWalker(nodes, [edge("a", "b", "next"), edge("b", "a", "next")])();
    expect(r.edges.length).toBe(TOKEN_MAX_LEGS);
  });
});
