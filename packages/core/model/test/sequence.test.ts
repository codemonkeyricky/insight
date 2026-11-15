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

  it("puts a stage called inside a callback after the stage the callback is passed to", () => {
    // `s1(input, () => s2())` on line 10: s1's name at [2,4), its call ends at column 30; the callback spans [12,28) and calls
    // s2 at [18,20), ending at column 24. s2's call ends before s1's, yet s1 runs first.
    const anon = fx.node(`${RUN}#λ10:12`, "structure", "structure.function", { attrs: { name: "λ10:12", anonymous: true }, parent: RUN_FN, span: fx.span(RUN, 10, 12, 10, 28) });
    const calls = [
      call(RUN_FN, stageId("s1"), RUN, 10, 2, 4, [10, 30]),
      call(anon.id, stageId("s2"), RUN, 10, 18, 20, [10, 24]),
      ...runCalls([["s3", 11], ["s4", 12], ["s5", 13]]),
    ];
    const seqs = sequencesOf(doc([anon], [], {}, calls));
    expect(seqs[0]?.stages.map((s) => s.name)).toEqual(["s1", "s2", "s3", "s4", "s5"]);
  });

  it("orders calls on one very long line by column, past a million columns", () => {
    const seqs = sequencesOf(doc([], [], {}, runCalls([["s1", 10, 2, 4, [10, 1500010]], ["s2", 11, 2, 4, [11, 5]], ["s3", 12], ["s4", 13], ["s5", 14]])));
    expect(seqs[0]?.stages.map((s) => s.name)).toEqual(["s1", "s2", "s3", "s4", "s5"]);
  });

  it("uses the name span end when an older index has no callEnd, so a wrapping call sorts first", () => {
    // `s2(s1(x))` without callEnd: s2's name ends at column 4, s1's at 7. This is the documented fallback.
    const seqs = sequencesOf(doc([], [], {}, runCalls([["s2", 10, 2, 4], ["s1", 10, 5, 7], ["s3", 11], ["s4", 12], ["s5", 13]])));
    expect(seqs[0]?.stages.map((s) => s.name)).toEqual(["s2", "s1", "s3", "s4", "s5"]);
  });

  it("does not count registry or interface candidates as stages", () => {
    // run makes three exact stage calls and one registry call with candidates s4 and s5: three stages only, no sequence.
    const registry = fx.edge(RUN_FN, [stageId("s4"), stageId("s5")], "calls", "calls.call", { span: fx.span(RUN, 13, 2, 13, 12), attrs: { callee: "STAGES[k]", how: "registry" } });
    expect(sequencesOf(doc([], [registry], {}, runCalls([["s1", 10], ["s2", 11], ["s3", 12]])))).toEqual([]);
  });

  it("finds no sequence when every stage is in one file", () => {
    const one = "b/src/one.ts";
    const names = ["t1", "t2", "t3", "t4"];
    const extraNodes = [file(one), ...names.flatMap((n) => [fn(one, n), fn(one, `${n}A`), fn(one, `${n}B`)])];
    const extraEdges = names.flatMap((n) => [call(`${one}#${n}`, `${one}#${n}A`, one, 3), call(`${one}#${n}`, `${one}#${n}B`, one, 4)]);
    const calls = names.map((n, i) => call(RUN_FN, `${one}#${n}`, RUN, 10 + i));
    expect(sequencesOf(doc(extraNodes, extraEdges, {}, calls))).toEqual([]);
  });

  it("does not count a leaf helper (fewer than two calls of its own) as a stage", () => {
    const leaf = "c/src/leaf.ts";
    const extraNodes = [file(leaf), fn(leaf, "leaf"), fn(leaf, "leafA")];
    const extraEdges = [call(`${leaf}#leaf`, `${leaf}#leafA`, leaf, 3), call(RUN_FN, `${leaf}#leaf`, RUN, 9)];
    const seqs = sequencesOf(doc(extraNodes, extraEdges));
    expect(seqs[0]?.stages.map((s) => s.name)).toEqual(["s1", "s2", "s3", "s4", "s5"]);
  });

  it("keeps 16 stages and counts the rest in more", () => {
    const extra = Array.from({ length: 15 }, (_, i) => `x${i}`);
    const nodes: IRNode[] = [];
    const edges: IREdge[] = [];
    for (const [i, n] of extra.entries()) {
      const path = `c/src/x${i}.ts`;
      nodes.push(file(path), fn(path, n), fn(path, `${n}A`), fn(path, `${n}B`));
      edges.push(call(`${path}#${n}`, `${path}#${n}A`, path, 3), call(`${path}#${n}`, `${path}#${n}B`, path, 4), call(RUN_FN, `${path}#${n}`, RUN, 20 + i));
    }
    const seqs = sequencesOf(doc(nodes, edges));
    expect(seqs[0]?.stages).toHaveLength(16);
    expect(seqs[0]?.more).toBe(4);
    expect(seqs[0]?.stages.at(-1)?.order).toBe(15);
  });

  it("leaves out stages in test folders unless tests are on", () => {
    const t = "c/test/t.test.ts";
    const extraNodes = [file(t), fn(t, "tt"), fn(t, "ttA"), fn(t, "ttB")];
    const extraEdges = [call(`${t}#tt`, `${t}#ttA`, t, 3), call(`${t}#tt`, `${t}#ttB`, t, 4), call(RUN_FN, `${t}#tt`, RUN, 20)];
    const off = pipelineModel(buildProjectModel(doc(extraNodes, extraEdges)), "").sequences;
    expect(off[0]?.stages.map((s) => s.name)).not.toContain("tt");
    const on = pipelineModel(buildProjectModel(doc(extraNodes, extraEdges)), "", { tests: true }).sequences;
    expect(on[0]?.stages.map((s) => s.name)).toContain("tt");
  });

  it("has no reason when the scope has sequences but no extension points", () => {
    const m = pipelineModel(buildProjectModel(doc()), "");
    expect(m.points).toEqual([]);
    expect(m.sequences.length).toBeGreaterThan(0);
    expect(m.reason).toBeUndefined();
  });
});
