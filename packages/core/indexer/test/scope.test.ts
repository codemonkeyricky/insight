import { describe, expect, it } from "vitest";
import type { IRDocument, IRNode } from "@insight/ir";
import * as fx from "@insight/sdk/testing";
import { InputError, inScope, isExternal, normalizeScope, scopeDoc, scopeFacets, scopeOfNode } from "../src/index.js";

const A = "src/a.ts";
const B = "src/b.ts";
const C = "src/sub/c.ts";
const D = "src2/d.ts";

function fileNode(path: string) {
  return fx.node(path, "structure", "structure.file", { attrs: { path }, span: fx.span(path, 0, 0, 0, 0) });
}

function fnNode(path: string, name: string, parent: string = path) {
  return fx.node(`${path}#${name}`, "structure", "structure.function", {
    attrs: { name },
    parent,
    span: fx.span(path, 2, 0, 4, 1),
  });
}

/**
 * Four files: src/a.ts, src/b.ts, src/sub/c.ts (all under src) and src2/d.ts (a sibling whose name
 * starts with "src" but is not under it). Edges cross the boundaries in every direction.
 */
function fixture(): IRDocument {
  const nodes: IRNode[] = [
    fileNode(A),
    fileNode(B),
    fileNode(C),
    fileNode(D),
    fnNode(A, "a"),
    fnNode(B, "b"),
    fnNode(C, "c"),
    fnNode(D, "d"),
    fx.node("src/a.ts@branch:3:2", "flow", "flow.branch", { parent: `${A}#a`, span: fx.span(A, 3, 2, 3, 10) }),
    fx.node(`${A}#inner`, "structure", "structure.function", { attrs: { name: "inner" }, parent: B, span: fx.span(A, 6, 0, 7, 1) }),
  ];
  const edges = [
    fx.edge(A, B, "packaging", "packaging.import", { span: fx.span(A, 1, 0, 1, 30) }),
    fx.edge(`${A}#a`, `${B}#b`, "calls", "calls.call"),
    fx.edge(`${D}#d`, `${A}#a`, "calls", "calls.call"),
    fx.edge(`${C}#c`, [`${A}#a`, `${D}#d`], "calls", "calls.call"),
    fx.edge(`${D}#d`, `${C}#c`, "calls", "calls.call"),
    fx.edge(`${A}#a`, `${A}#a`, "calls", "calls.call"),
    fx.edge(`${A}#a`, [`${A}#a`, `${B}#b`], "calls", "calls.call"),
  ];
  const findings = [
    fx.finding("in a", { severity: "warning", span: fx.span(A, 3, 0, 3, 5) }),
    fx.finding("in b", { span: fx.span(B, 3, 0, 3, 5) }),
    fx.finding("only d", { nodes: [`${D}#d`] }),
    fx.finding("on a node", { nodes: [`${A}#a`] }),
    fx.finding("nowhere"),
  ];
  return { nodes, edges, findings };
}

describe("normalizeScope and inScope", () => {
  it("canonicalises scope strings and refuses paths that leave the project", () => {
    expect(normalizeScope("")).toBe("");
    expect(normalizeScope(".")).toBe("");
    expect(normalizeScope("src/")).toBe("src");
    expect(normalizeScope("./src//sub")).toBe("src/sub");
    expect(normalizeScope("src\\sub")).toBe("src/sub");
    expect(() => normalizeScope("../outside")).toThrow(InputError);
    expect(() => normalizeScope("src/../../outside")).toThrow(InputError);
    expect(() => normalizeScope("/etc")).toThrow(InputError);
  });

  it("matches whole path segments only", () => {
    expect(inScope("src/a.ts", "")).toBe(true);
    expect(inScope("src/a.ts", "src")).toBe(true);
    expect(inScope("src/sub/c.ts", "src")).toBe(true);
    expect(inScope("src/a.ts", "src/a.ts")).toBe(true);
    expect(inScope("src2/d.ts", "src")).toBe(false);
    expect(inScope("srcx/a.ts", "src")).toBe(false);
    expect(inScope("src/ab.ts", "src/a.ts")).toBe(false);
  });
});

describe("scopeOfNode", () => {
  it("uses the span file, or the path of a structure.file node", () => {
    expect(scopeOfNode(fnNode(A, "a"))).toBe(A);
    expect(scopeOfNode(fileNode(B))).toBe(B);
    expect(scopeOfNode(fx.node("lib:x", "packaging", "packaging.build-target"))).toBeUndefined();
  });
});

describe("scopeDoc", () => {
  it("returns the whole document unchanged for the project scope", () => {
    const doc = fixture();
    const { doc: root, stats } = scopeDoc(doc, "");
    expect(root).toEqual(doc);
    expect(stats).toEqual({ nodes: doc.nodes.length, edges: doc.edges.length, findings: doc.findings.length, external: 0 });
    expect(scopeDoc(doc, ".").doc).toEqual(doc);
  });

  it("includes a folder's descendants and no sibling that only shares a name prefix", () => {
    const { doc, stats } = scopeDoc(fixture(), "src");
    const local = doc.nodes.filter((n) => !isExternal(n)).map((n) => n.id).sort();
    expect(local).toEqual([
      "src/a.ts",
      "src/a.ts#a",
      "src/a.ts#inner",
      "src/a.ts@branch:3:2",
      "src/b.ts",
      "src/b.ts#b",
      "src/sub/c.ts",
      "src/sub/c.ts#c",
    ]);
    expect(doc.nodes.some((n) => n.id.startsWith("src2/"))).toBe(true);
    expect(doc.nodes.filter((n) => n.id.startsWith("src2/")).every(isExternal)).toBe(true);
    expect(stats).toEqual({ nodes: 8, edges: 7, findings: 3, external: 1 });
  });

  it("keeps a file's edges and stubs the far end of each one that leaves the file", () => {
    const fixtureDoc = fixture();
    const { doc, stats } = scopeDoc(fixtureDoc, "src/a.ts");
    expect(stats).toEqual({ nodes: 4, edges: 6, findings: 2, external: 4 });
    const stubs = doc.nodes.filter(isExternal).map((n) => n.id).sort();
    expect(stubs).toEqual(["src/b.ts", "src/b.ts#b", "src/sub/c.ts#c", "src2/d.ts#d"]);
    expect(doc.edges.some((e) => e.kind === "calls.call" && e.from === `${C}#c`)).toBe(true);
    expect(doc.edges.some((e) => e.from === `${D}#d` && e.to === `${C}#c`)).toBe(false);
  });

  it("gives external stubs the facet, kind and attrs of the original, with no span or parent", () => {
    const { doc } = scopeDoc(fixture(), "src/a.ts");
    const stub = doc.nodes.find((n) => n.id === `${B}#b`);
    expect(stub).toBeDefined();
    expect(stub).toMatchObject({ id: `${B}#b`, facet: "structure", kind: "structure.function", attrs: { name: "b", external: true } });
    expect(stub?.span).toBeUndefined();
    expect(stub?.parent).toBeUndefined();
    const file = doc.nodes.find((n) => n.id === B);
    expect(file).toMatchObject({ kind: "structure.file", attrs: { path: B, external: true } });
    expect(file?.span).toBeUndefined();
  });

  it("drops parent links that point outside the scope and keeps those inside it", () => {
    const inFile = scopeDoc(fixture(), "src/a.ts").doc.nodes.find((n) => n.id === `${A}#inner`);
    expect(inFile?.parent).toBeUndefined();
    const inFolder = scopeDoc(fixture(), "src").doc.nodes.find((n) => n.id === `${A}#inner`);
    expect(inFolder?.parent).toBe(B);
    const flow = scopeDoc(fixture(), "src/a.ts").doc.nodes.find((n) => n.id === "src/a.ts@branch:3:2");
    expect(flow?.parent).toBe(`${A}#a`);
  });

  it("filters findings by the file of their span, or by their nodes when they have no span", () => {
    const messages = (scope: string) => scopeDoc(fixture(), scope).doc.findings.map((f) => f.message);
    expect(messages("")).toEqual(["in a", "in b", "only d", "on a node", "nowhere"]);
    expect(messages("src/a.ts")).toEqual(["in a", "on a node"]);
    expect(messages("src")).toEqual(["in a", "in b", "on a node"]);
    expect(scopeDoc(fixture(), "src/a.ts").stats.findings).toBe(2);
  });

  it("keeps ids stable and gives the same result for the same scope", () => {
    const doc = fixture();
    const ids = new Set(doc.nodes.map((n) => n.id));
    const once = scopeDoc(doc, "src");
    expect(once.doc.nodes.every((n) => ids.has(n.id))).toBe(true);
    expect(scopeDoc(doc, "src").doc).toEqual(once.doc);
    expect(scopeDoc(doc, "src/").doc).toEqual(once.doc);
    expect(scopeDoc(doc, "src/a.ts").doc.nodes.find((n) => n.id === `${A}#a`)).toEqual(doc.nodes.find((n) => n.id === `${A}#a`));
  });

  it("drops edges that leave the scope when external stubs are off", () => {
    const { doc, stats } = scopeDoc(fixture(), "src/a.ts", { externalStubs: false });
    expect(stats.external).toBe(0);
    expect(doc.nodes.some(isExternal)).toBe(false);
    expect(doc.edges.map((e) => `${e.from}->${typeof e.to === "string" ? e.to : JSON.stringify(e.to)}`)).toEqual([
      `${A}#a->${A}#a`,
      `${A}#a->{"candidates":["${A}#a"]}`,
    ]);
  });
});

describe("scopeFacets", () => {
  it("lists the facets a scope has facts in, sorted", () => {
    const { doc } = scopeDoc(fixture(), "src/a.ts");
    expect(scopeFacets(doc)).toEqual(["calls", "flow", "packaging", "structure"]);
  });

  it("does not count an external stub's facet as present in the scope", () => {
    const doc: IRDocument = {
      nodes: [fileNode("src/x.ts"), fnNode("src/x.ts", "f"), fx.node("lib/o.ts#g", "effects", "effects.unknown")],
      edges: [fx.edge("src/x.ts#f", "lib/o.ts#g", "calls", "calls.call")],
      findings: [],
    };
    const scoped = scopeDoc(doc, "src/x.ts").doc;
    expect(scoped.nodes.some((n) => n.facet === "effects" && isExternal(n))).toBe(true);
    expect(scopeFacets(scoped)).toEqual(["calls", "structure"]);
  });
});
