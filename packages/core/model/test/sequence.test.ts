import { describe, expect, it } from "vitest";
import type { IRDocument, IREdge, IRNode } from "@insight/ir";
import * as fx from "@insight/sdk/testing";
import { buildProjectModel, pipelineModel } from "../src/index.js";

const file = (path: string): IRNode => fx.node(path, "structure", "structure.file", { attrs: { path }, span: fx.span(path, 0, 0, 0, 0) });

function fn(path: string, name: string, attrs: Record<string, unknown> = {}): IRNode {
  return fx.node(`${path}#${name}`, "structure", "structure.function", { attrs: { name, ...attrs }, parent: path, span: fx.span(path, 2, 0, 9, 1) });
}

/**
 * A call from `from` to `to`, on `line`. The span covers the callee name (columns c0 to c1), as the frontend emits it; callEnd is
 * the end of the whole call expression, when given.
 */
function call(from: string, to: string, path: string, line: number, c0 = 2, c1 = 12, callEnd?: [number, number]): IREdge {
  return fx.edge(from, to, "calls", "calls.call", {
    span: fx.span(path, line, c0, line, c1),
    ...(callEnd !== undefined ? { attrs: { callEnd } } : {}),
  });
}

const RUN = "app/src/run.ts";
const RUN_FN = `${RUN}#run`;
/** The stages: each lives in a file of its own package (b or c), and makes two calls to helpers in its own file. */
const STAGES: Record<string, string> = { s1: "b/src/b1.ts", s2: "b/src/b2.ts", s3: "c/src/c1.ts", s4: "c/src/c2.ts", s5: "c/src/c3.ts" };
const stageId = (name: string): string => `${STAGES[name] as string}#${name}`;

function stageNodes(): { nodes: IRNode[]; edges: IREdge[] } {
  const nodes: IRNode[] = [];
  const edges: IREdge[] = [];
  for (const [name, path] of Object.entries(STAGES)) {
    nodes.push(file(path), fn(path, name), fn(path, `${name}A`), fn(path, `${name}B`));
    edges.push(call(stageId(name), `${path}#${name}A`, path, 3), call(stageId(name), `${path}#${name}B`, path, 4));
  }
  return { nodes, edges };
}

/** run calls each named stage on its own line, in the order given: [name, line, nameStart?, nameEnd?, callEnd?]. */
function runCalls(order: Array<[string, number, number?, number?, [number, number]?]>): IREdge[] {
  return order.map(([name, line, c0, c1, callEnd]) => call(RUN_FN, stageId(name), RUN, line, c0, c1, callEnd));
}

/** The base project: the run orchestrator with five stages, in file order s1 to s5. */
function doc(extraNodes: IRNode[] = [], extraEdges: IREdge[] = [], runAttrs: Record<string, unknown> = {}, calls?: IREdge[]): IRDocument {
  const st = stageNodes();
  return {
    nodes: [
      file("app/package.json"),
      file("b/package.json"),
      file("c/package.json"),
      file(RUN),
      fn(RUN, "run", runAttrs),
      ...st.nodes,
      ...extraNodes,
    ],
    edges: [
      ...st.edges,
      ...(calls ?? runCalls([["s1", 10], ["s2", 11], ["s3", 12], ["s4", 13], ["s5", 14]])),
      ...extraEdges,
    ],
    findings: [],
  };
}

const sequencesOf = (d: IRDocument) => pipelineModel(buildProjectModel(d), "").sequences;

describe("sequence pipelines", () => {
  it("orders stages by the end of their call span, not by the line they sit on", () => {
    const seqs = sequencesOf(doc([], [], {}, runCalls([["s3", 10], ["s1", 11], ["s5", 12], ["s2", 13], ["s4", 14]])));
    expect(seqs).toHaveLength(1);
    expect(seqs[0]?.id).toBe(RUN_FN);
    expect(seqs[0]?.stages.map((s) => s.name)).toEqual(["s3", "s1", "s5", "s2", "s4"]);
    expect(seqs[0]?.stages.map((s) => s.order)).toEqual([0, 1, 2, 3, 4]);
  });

  it("puts a nested call's stage before the stage that wraps it, from callEnd", () => {
    // `s2(s1(x))` at column 2: the names are at [2,4) and [5,7). s1's call ends at column 10, s2's at column 11. The name spans
    // alone would put s2 first, since its name ends earlier.
    const seqs = sequencesOf(doc([], [], {}, runCalls([["s2", 10, 2, 4, [10, 11]], ["s1", 10, 5, 7, [10, 10]], ["s3", 11], ["s4", 12], ["s5", 13]])));
    expect(seqs[0]?.stages.map((s) => s.name)).toEqual(["s1", "s2", "s3", "s4", "s5"]);
  });

  it("leaves out a utility with more than 25 callers", () => {
    const lib = "lib/src/util.ts";
    const many = "many/src/many.ts";
    const callers = Array.from({ length: 29 }, (_, i) => fn(many, `k${i}`));
    const lib2 = [fn(lib, "u"), fn(lib, "uA"), fn(lib, "uB")];
    const extraNodes = [file("lib/package.json"), file("many/package.json"), file(lib), file(many), ...lib2, ...callers];
    const extraEdges = [
      call(`${lib}#u`, `${lib}#uA`, lib, 3),
      call(`${lib}#u`, `${lib}#uB`, lib, 4),
      ...callers.map((c, i) => call(c.id, `${lib}#u`, many, 10 + i)),
      call(RUN_FN, `${lib}#u`, RUN, 20),
    ];
    const seqs = sequencesOf(doc(extraNodes, extraEdges));
    const names = seqs.flatMap((s) => s.stages.map((st) => st.name));
    expect(names).not.toContain("u");
    expect(seqs[0]?.stages).toHaveLength(5);
  });

  it("excludes a React component (a .tsx function named with a capital)", () => {
    const app = "web/src/App.tsx";
    const extraNodes = [file("web/package.json"), file(app), fn(app, "App")];
    const extraEdges = [1, 2, 3, 4].map((i) => call(`${app}#App`, stageId(`s${i}`), app, 10 + i));
    const seqs = sequencesOf(doc(extraNodes, extraEdges));
    expect(seqs.map((s) => s.id)).toEqual([RUN_FN]);
  });

  it("excludes a module entry", () => {
    const mod = "app/src/mod.ts";
    const extraNodes = [file(mod), fn(mod, "top", { module: true })];
    const extraEdges = [1, 2, 3, 4].map((i) => call(`${mod}#top`, stageId(`s${i}`), mod, 10 + i));
    const seqs = sequencesOf(doc(extraNodes, extraEdges));
    expect(seqs.map((s) => s.id)).not.toContain(`${mod}#top`);
    expect(seqs.map((s) => s.id)).toContain(RUN_FN);
  });

  it("finds no sequence with only three stages", () => {
    expect(sequencesOf(doc([], [], {}, runCalls([["s1", 10], ["s2", 11], ["s3", 12]])))).toEqual([]);
  });

  it("keeps the three best sequences, ties by id", () => {
    const o = "app/src/o.ts";
    const orchestrators = [1, 2, 3, 4].map((i) => fn(o, `o${i}`));
    const extraNodes = [file(o), ...orchestrators];
    const extraEdges = orchestrators.flatMap((f) => [1, 2, 3, 4].map((i) => call(f.id, stageId(`s${i}`), o, 10 + i)));
    const seqs = sequencesOf(doc(extraNodes, extraEdges));
    expect(seqs.map((s) => s.id)).toEqual([RUN_FN, `${o}#o1`, `${o}#o2`]);
  });

  it("has no reason when the scope has sequences but no extension points", () => {
    const m = pipelineModel(buildProjectModel(doc()), "");
    expect(m.points).toEqual([]);
    expect(m.sequences.length).toBeGreaterThan(0);
    expect(m.reason).toBeUndefined();
  });
});
