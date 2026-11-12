import { describe, expect, it } from "vitest";
import type { IREdge, IRNode } from "@insight/ir";
import { execModel, summarizeScope } from "../src/index.js";
import { PROVENANCE, callEdge, fnNode } from "./synthetic.js";

/** An anonymous function named `λLINE:3`, written in `parent` (a function id, or the file for module-level code). */
function anonNode(file: string, line: number, parent: string): IRNode {
  const name = `λ${line + 1}:3`;
  return { ...fnNode(file, name, line), parent, attrs: { name, anonymous: true } };
}

/** `from` creates the anonymous function `to` with a closure reference. */
function closureEdge(from: string, to: string, file: string, line: number): IREdge {
  return {
    from,
    to,
    facet: "calls",
    kind: "calls.reference",
    span: { file, start: [line, 2], end: [line, 8] },
    attrs: { how: "closure" },
    provenance: PROVENANCE,
  };
}

const APP = "app/src/index.ts";
const LIB = "lib/util.ts";
const MAIN = `${APP}#main`;
const LAM = `${APP}#λ5:3`;
const HELP = `${LIB}#help`;

/** main creates a lambda that calls help in another file. */
const NODES: IRNode[] = [fnNode(APP, "main", 0), anonNode(APP, 4, MAIN), fnNode(LIB, "help", 0)];
const EDGES: IREdge[] = [closureEdge(MAIN, LAM, APP, 4), callEdge(LAM, HELP, APP, 5)];

describe("summarizeScope folds lambdas into their owner", () => {
  it("re-keys a cross-file call from a lambda to its owner, and lists no lambda", () => {
    const flow = summarizeScope(NODES, EDGES, [APP, LIB]);
    expect(flow.functions.map((f) => f.id)).toEqual([MAIN, HELP]);
    expect(flow.calls).toEqual([expect.objectContaining({ from: MAIN, to: HELP, count: 1, external: false })]);
  });

  it("sends a module-level lambda's call to the file", () => {
    const top = `${APP}#λ2:3`;
    const nodes = [fnNode(APP, "main", 0), anonNode(APP, 1, APP), fnNode(LIB, "help", 0)];
    const flow = summarizeScope(nodes, [callEdge(top, HELP, APP, 2)], [APP, LIB]);
    expect(flow.calls).toEqual([expect.objectContaining({ from: APP, to: HELP, count: 1 })]);
  });

  it("drops the self-edge a folded closure creates, and merges counts of repeated calls", () => {
    const flow = summarizeScope(NODES, [...EDGES, callEdge(MAIN, HELP, APP, 9), callEdge(LAM, HELP, APP, 6)], [APP, LIB]);
    expect(flow.calls).toEqual([expect.objectContaining({ from: MAIN, to: HELP, count: 3 })]);
    expect(flow.calls.some((c) => c.from === c.to)).toBe(false);
  });

  it("restores the lambda rows with lambdas: true", () => {
    const flow = summarizeScope(NODES, EDGES, [APP, LIB], { lambdas: true });
    expect(flow.functions.map((f) => f.id)).toEqual([MAIN, LAM, HELP]);
    expect(flow.calls).toEqual([expect.objectContaining({ from: LAM, to: HELP, count: 1 })]);
  });
});

describe("execModel folds lambdas into their owner", () => {
  it("gives the owner the lambda's callees and lists no lambda", () => {
    const model = execModel(NODES, EDGES, "");
    expect(model.functions.map((f) => f.id)).toEqual(expect.arrayContaining([MAIN, HELP]));
    expect(model.functions.some((f) => f.anonymous)).toBe(false);
    expect(model.threads[0]).toMatchObject({ roots: [MAIN] });
    expect(model.threads[0]?.reached).toEqual([HELP, MAIN].sort());
  });

  it("restores the lambda as a function with lambdas: true", () => {
    const model = execModel(NODES, EDGES, "", { lambdas: true });
    expect(model.functions.map((f) => f.id)).toContain(LAM);
  });
});
