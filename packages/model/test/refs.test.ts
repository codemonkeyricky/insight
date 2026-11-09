import { describe, expect, it } from "vitest";
import type { IRDocument, IRNode } from "@insight/ir";
import { irFixtures as fx } from "@insight/sdk";
import { buildProjectModel, refsOf, scopeView } from "../src/index.js";

const A = "src/a.ts";
const B = "lib/b.ts";
const SUB = "src/sub/c.ts";
const TOP = "top.ts";
const LAMBDA = `${A}#<lambda>`;

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

/**
 * a (src/a.ts, line 3) calls b (lib/b.ts) at line 4, and a lambda in a calls b at line 6. a creates the lambda as a
 * closure. c (src/sub/c.ts) calls a or b through a candidate set. top.ts holds module-level code that calls a and
 * dispatches b.
 */
function fixture(): IRDocument {
  const nodes: IRNode[] = [
    fileNode(A),
    fileNode(B),
    fileNode(SUB),
    fileNode(TOP),
    fnNode(A, "a", 2),
    fnNode(B, "b", 2),
    fnNode(SUB, "c", 2),
    fnNode(A, "", 5, { anonymous: true, parent: `${A}#a` }),
  ];
  const edges = [
    fx.edge(`${A}#a`, `${B}#b`, "calls", "calls.call", { span: fx.span(A, 3, 0, 3, 10) }),
    fx.edge(LAMBDA, `${B}#b`, "calls", "calls.call", { span: fx.span(A, 5, 2, 5, 12) }),
    fx.edge(`${A}#a`, LAMBDA, "calls", "calls.reference", { attrs: { how: "closure" } }),
    fx.edge(`${SUB}#c`, [`${A}#a`, `${B}#b`], "calls", "calls.call", { span: fx.span(SUB, 3, 0, 3, 4) }),
    fx.edge(TOP, `${A}#a`, "calls", "calls.call", { span: fx.span(TOP, 0, 0, 0, 3) }),
    fx.edge(TOP, `${B}#b`, "concurrency", "concurrency.dispatches", { span: fx.span(TOP, 1, 0, 1, 9) }),
  ];
  return { nodes, edges, findings: [] };
}

const model = buildProjectModel(fixture());

describe("refsOf: called by", () => {
  it("lists the callers across the project, with the scope deciding inScope", () => {
    const refs = refsOf(scopeView(model, "src/sub"), `${A}#a`);
    const callers = refs.calledBy.map((r) => [r.file, r.name, r.kind, r.inScope]);
    // c is in the scope, so it sorts first. top.ts is outside the scope and comes after it.
    expect(callers).toEqual([
      [SUB, "c", "call", true],
      [TOP, "top.ts", "call", false],
    ]);
  });

  it("names a file caller by its basename, and keeps its kind", () => {
    const refs = refsOf(scopeView(model, ""), `${A}#a`);
    const top = refs.calledBy.find((r) => r.id === TOP);
    expect(top).toMatchObject({ name: "top.ts", file: TOP, kind: "call", line: 1, isFunction: false, inScope: true });
  });

  it("attributes an anonymous caller to its nearest named parent, and collapses the duplicates into a count", () => {
    const refs = refsOf(scopeView(model, ""), `${B}#b`);
    const a = refs.calledBy.find((r) => r.id === `${A}#a` && r.kind === "call");
    expect(a).toMatchObject({ name: "a", file: A, line: 3, isFunction: true, count: 2, candidate: false });
    expect(refs.calledBy.some((r) => r.id === LAMBDA)).toBe(false);
  });

  it("marks candidate callers, and carries the kind of a dispatch", () => {
    const refs = refsOf(scopeView(model, ""), `${B}#b`);
    expect(refs.calledBy.find((r) => r.id === `${SUB}#c`)).toMatchObject({ kind: "call", candidate: true, count: 1 });
    expect(refs.calledBy.find((r) => r.id === TOP)).toMatchObject({ kind: "dispatch", name: "top.ts" });
  });
});

describe("refsOf: calls", () => {
  it("lists what the function calls, with the calls its anonymous functions make counted as its own", () => {
    const refs = refsOf(scopeView(model, ""), `${A}#a`);
    const b = refs.calls.find((r) => r.id === `${B}#b`);
    expect(b).toMatchObject({ name: "b", file: B, line: 3, kind: "call", count: 2, inScope: true });
  });

  it("carries the how of an edge, and lists a closure the function creates as a reference", () => {
    const refs = refsOf(scopeView(model, ""), `${A}#a`);
    expect(refs.calls.find((r) => r.id === LAMBDA)).toMatchObject({ kind: "reference", how: "closure", count: 1 });
  });

  it("marks calls that leave the scope", () => {
    const refs = refsOf(scopeView(model, "src"), `${A}#a`);
    expect(refs.calls.find((r) => r.id === `${B}#b`)?.inScope).toBe(false);
  });
});

describe("refsOf: order and unknown ids", () => {
  it("sorts the rows in scope first, then by file and line", () => {
    const refs = refsOf(scopeView(model, "src"), `${B}#b`);
    const flags = refs.calledBy.map((r) => r.inScope);
    expect(flags).toEqual([...flags].sort((x, y) => Number(y) - Number(x)));
    const inScope = refs.calledBy.filter((r) => r.inScope);
    expect(inScope.map((r) => r.file)).toEqual([...inScope.map((r) => r.file)].sort());
  });

  it("gives empty lists for an id the model does not hold", () => {
    expect(refsOf(scopeView(model, ""), "nope#missing")).toEqual({ calledBy: [], calls: [] });
  });
});
