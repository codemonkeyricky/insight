import { describe, expect, it } from "vitest";
import type { IRDocument, IREdge, IRNode } from "@insight/ir";
import * as fx from "@insight/sdk/testing";
import { buildProjectModel, pipelineModel, type PipelineModel } from "../src/index.js";

const file = (path: string): IRNode => fx.node(path, "structure", "structure.file", { attrs: { path }, span: fx.span(path, 0, 0, 0, 0) });

function fn(path: string, name: string): IRNode {
  return fx.node(`${path}#${name}`, "structure", "structure.function", { attrs: { name }, parent: path, span: fx.span(path, 2, 0, 9, 1) });
}

function call(from: string, to: string, path: string, line: number): IREdge {
  return fx.edge(from, to, "calls", "calls.call", { span: fx.span(path, line, 2, line, 12) });
}

/** An interface-dispatch call site: one edge, several candidate targets, the way the TypeScript frontend emits it. */
function dispatch(from: string, candidates: string[], path: string, line: number, callee: string): IREdge {
  return fx.edge(from, candidates, "calls", "calls.call", { span: fx.span(path, line, 2, line, 20), attrs: { callee, how: "interface" } });
}

const RUN = "host/src/run.ts";
const LIB = "lib/src/lib.ts";
const A = "plugins/a/src/a.ts";
const B = "plugins/b/src/b.ts";
const X = "sinks/x/src/x.ts";
const Y = "sinks/y/src/y.ts";
const FAKE = "fixtures/fake/src/f.ts";

/**
 * The pipeline fixture. host/run calls the frontends through an interface (lines 10 and 11, candidates in a and b), a
 * single-target interface site (line 12, a only) and calls prep at `prepLine`. prep calls the sinks through an interface
 * (line 20, candidates in x and y). run also calls lib exactly. A fixture-folder candidate sits on the line-12 site.
 */
function pipelineDoc(prepLine = 15): IRDocument {
  const nodes: IRNode[] = [
    file("host/package.json"),
    file("plugins/a/package.json"),
    file("plugins/b/package.json"),
    file("sinks/x/package.json"),
    file("sinks/y/package.json"),
    file("lib/package.json"),
    file(RUN),
    file(LIB),
    file(A),
    file(B),
    file(X),
    file(Y),
    file(FAKE),
    fn(RUN, "run"),
    fn(RUN, "prep"),
    fn(LIB, "util"),
    fn(A, "detect"),
    fn(B, "detect"),
    fn(X, "render"),
    fn(Y, "render"),
    fn(FAKE, "detect"),
  ];
  const run = `${RUN}#run`;
  const prep = `${RUN}#prep`;
  const frontends = [`${A}#detect`, `${B}#detect`];
  const edges: IREdge[] = [
    dispatch(run, frontends, RUN, 10, "frontend.detect"),
    dispatch(run, frontends, RUN, 11, "frontend.extract"),
    dispatch(run, [`${A}#detect`, `${FAKE}#detect`], RUN, 12, "frontend.fake"),
    call(run, prep, RUN, prepLine),
    call(run, `${LIB}#util`, RUN, 16),
    dispatch(prep, [`${X}#render`, `${Y}#render`], RUN, 20, "lens.render"),
  ];
  return { nodes, edges, findings: [] };
}

function modelOf(doc: IRDocument) {
  return buildProjectModel(doc);
}

describe("pipelineModel on the pipeline fixture", () => {
  const m: PipelineModel = pipelineModel(modelOf(pipelineDoc()), "");

  it("picks the host and the driver function that reaches every site", () => {
    expect(m.host).toBe("host");
    expect(m.driver).toEqual({ id: `${RUN}#run`, name: "run" });
    expect(m.dropped).toBe(0);
  });

  it("makes the source point from the frontends and the sink point from the lenses, in driver order", () => {
    expect(m.points.map((p) => [p.label, p.role, p.order, p.components, p.members, p.receiver, p.count])).toEqual([
      ["Frontends", "source", 0, ["plugins/a", "plugins/b"], ["detect", "extract"], "frontend", 2],
      ["Lenses", "sink", 1, ["sinks/x", "sinks/y"], ["render"], "lens", 1],
    ]);
  });

  it("lays out the columns: frontends, host with its exact calls, lenses", () => {
    expect(m.columns).toEqual([
      ["plugins/a", "plugins/b"],
      ["host", "lib"],
      ["sinks/x", "sinks/y"],
    ]);
    expect(m.omitted).toBe(0);
    expect(m.components.map((c) => c.id).sort()).toEqual(["host", "lib", "plugins/a", "plugins/b", "sinks/x", "sinks/y"]);
  });

  it("draws produces, feeds and calls edges with the members as labels", () => {
    const edges = m.edges.map((e) => [e.id, e.verb, e.label, e.confidence]);
    expect(edges).toEqual([
      ["host>calls>lib", "calls", "calls", "exact"],
      ["host>feeds>sinks/x", "feeds", "render", "inferred"],
      ["host>feeds>sinks/y", "feeds", "render", "inferred"],
      ["plugins/a>produces>host", "produces", "detect, extract", "inferred"],
      ["plugins/b>produces>host", "produces", "detect, extract", "inferred"],
    ]);
    const produced = m.edges.find((e) => e.id === "plugins/a>produces>host");
    expect(produced?.sites.map((s) => s.line)).toEqual([11, 12]);
    expect(produced?.sites[0]?.fn).toBe(`${RUN}#run`);
  });

  it("ignores a single-target interface site", () => {
    expect(m.points.every((p) => p.components.length >= 2)).toBe(true);
    expect(m.points.reduce((n, p) => n + p.count, 0)).toBe(3);
  });

  it("is deterministic", () => {
    expect(pipelineModel(modelOf(pipelineDoc()), "")).toEqual(m);
  });
});

describe("pipelineModel order and rules", () => {
  it("flips the order when the helper's call moves above the frontend sites", () => {
    const m = pipelineModel(modelOf(pipelineDoc(5)), "");
    expect(m.points.map((p) => [p.label, p.role])).toEqual([
      ["Lenses", "source"],
      ["Frontends", "sink"],
    ]);
    expect(m.columns).toEqual([
      ["sinks/x", "sinks/y"],
      ["host", "lib"],
      ["plugins/a", "plugins/b"],
    ]);
    expect(m.edges.map((e) => e.id)).toContain("sinks/x>produces>host");
    expect(m.edges.map((e) => e.id)).toContain("host>feeds>plugins/a");
  });

  it("hides fixture folders unless tests are asked for", () => {
    const hidden = pipelineModel(modelOf(pipelineDoc()), "");
    expect(hidden.components.map((c) => c.id)).not.toContain("fixtures");
    const shown = pipelineModel(modelOf(pipelineDoc()), "", { tests: true });
    expect(shown.components.map((c) => c.id)).toContain("fixtures");
    expect(shown.points.length).toBe(3);
  });

  it("gives an empty model the reason and no columns", () => {
    const m = pipelineModel(modelOf({ nodes: [], edges: [], findings: [] }), "");
    expect(m).toMatchObject({ scope: "", points: [], columns: [], components: [], edges: [], omitted: 0, dropped: 0, reason: "no extension points in this scope" });
    expect(m.host).toBeUndefined();
  });

  it("gives the reason when a scope has only single-target sites", () => {
    const doc: IRDocument = {
      nodes: [file("host/package.json"), file("plugins/a/package.json"), file(RUN), file(A), fn(RUN, "run"), fn(A, "detect")],
      edges: [dispatch(`${RUN}#run`, [`${A}#detect`], RUN, 10, "frontend.detect")],
      findings: [],
    };
    const m = pipelineModel(modelOf(doc), "");
    expect(m.points).toEqual([]);
    expect(m.columns).toEqual([]);
    expect(m.reason).toBe("no extension points in this scope");
  });
});
