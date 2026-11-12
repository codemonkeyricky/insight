import { describe, expect, it } from "vitest";
import type { IRDocument, IRNode } from "@insight/ir";
import { irFixtures as fx } from "@insight/sdk";
import { buildProjectModel, normalizeScope, ScopeError, scopeView } from "../src/index.js";

const A = "src/a.ts";
const B = "lib/b.ts";
const SUB = "src/sub/c.ts";
const TOP = "top.ts";

function fileNode(path: string): IRNode {
  return fx.node(path, "structure", "structure.file", { attrs: { path }, span: fx.span(path, 0, 0, 0, 0) });
}

function fnNode(path: string, name: string, parent: string = path): IRNode {
  return fx.node(`${path}#${name}`, "structure", "structure.function", {
    attrs: { name },
    parent,
    span: fx.span(path, 2, 0, 4, 1),
  });
}

/**
 * Four files. src/a.ts defines a, which calls b in lib/b.ts. src/sub/c.ts defines c, which calls
 * either a or b through a candidate set. top.ts holds a module-level dispatch to b.
 */
function fixture(): IRDocument {
  const nodes: IRNode[] = [
    fileNode(A),
    fileNode(B),
    fileNode(SUB),
    fileNode(TOP),
    fnNode(A, "a"),
    fnNode(B, "b"),
    fnNode(SUB, "c"),
    fx.node(`${A}@branch:3:2`, "flow", "flow.branch", { parent: `${A}#a`, span: fx.span(A, 3, 2, 3, 10) }),
  ];
  const edges = [
    fx.edge(`${A}#a`, `${B}#b`, "calls", "calls.call", { span: fx.span(A, 3, 0, 3, 10) }),
    fx.edge(`${SUB}#c`, [`${A}#a`, `${B}#b`], "calls", "calls.call"),
    fx.edge(TOP, `${B}#b`, "concurrency", "concurrency.dispatches"),
    fx.edge(`${B}#b`, `${A}#a`, "calls", "calls.reference", { attrs: { how: "closure" } }),
    fx.edge(`${A}#a`, `${A}#a`, "calls", "calls.call"),
  ];
  return { nodes, edges, findings: [fx.finding("in a", { span: fx.span(A, 3, 0, 3, 5) })] };
}

describe("buildProjectModel: tree and functions", () => {
  const model = buildProjectModel(fixture());

  it("makes folder entities with the root at dir:", () => {
    expect(model.tree.root).toBe("dir:");
    expect(model.tree.dirs.get("")?.id).toBe("dir:");
    expect(model.tree.dirs.get("src")?.id).toBe("dir:src");
    expect(model.tree.dirs.get("src/sub")?.parent).toBe("dir:src");
    expect(model.tree.dirs.get("src")?.parent).toBe("dir:");
  });

  it("lists child folders and files sorted, and counts the subtree", () => {
    const root = model.tree.dirs.get("")!;
    expect(root.dirs).toEqual(["dir:lib", "dir:src"]);
    expect(root.files).toEqual(["top.ts"]);
    expect(root.subtreeFiles).toBe(4);
    expect(root.subtreeFunctions).toBe(3);

    const src = model.tree.dirs.get("src")!;
    expect(src.dirs).toEqual(["dir:src/sub"]);
    expect(src.files).toEqual([A]);
    expect(src.subtreeFiles).toBe(2);
    expect(src.subtreeFunctions).toBe(2);

    expect(model.tree.dirs.get("lib")?.subtreeFunctions).toBe(1);
    expect(model.tree.dirs.get("src/sub")?.subtreeFunctions).toBe(1);
  });

  it("resolves the file of a node through its parent chain", () => {
    expect(model.fileOf(`${A}@branch:3:2`)).toBe(A);
    expect(model.fileOf(`${A}#a`)).toBe(A);
    expect(model.fileOf(A)).toBe(A);
    expect(model.fileOf("missing")).toBeUndefined();
  });

  it("lists every function node once, with its file", () => {
    expect(model.functions.map((f) => f.id)).toEqual([`${B}#b`, `${A}#a`, `${SUB}#c`]);
    expect(model.functionById.get(`${B}#b`)?.file).toBe(B);
  });
});

describe("buildProjectModel: relations", () => {
  const model = buildProjectModel(fixture());

  it("normalizes call, reference, dispatch and spawn edges", () => {
    const kinds = model.relations.map((r) => r.kind);
    expect(kinds).toContain("call");
    expect(kinds).toContain("reference");
    expect(kinds).toContain("dispatch");
    const ref = model.out.get(`${B}#b`)?.find((r) => r.kind === "reference");
    expect(ref?.how).toBe("closure");
  });

  it("expands a candidate set into one relation per candidate", () => {
    const fromC = model.out.get(`${SUB}#c`) ?? [];
    expect(fromC.map((r) => r.to)).toEqual([`${A}#a`, `${B}#b`]);
    expect(fromC.every((r) => r.candidate)).toBe(true);
    expect(model.out.get(`${A}#a`)?.[0]?.candidate).toBe(false);
  });

  it("indexes relations by both ends", () => {
    expect(model.in.get(`${B}#b`)?.map((r) => r.from).sort()).toEqual([`${A}#a`, `${SUB}#c`, TOP].sort());
    expect(model.out.get(`${A}#a`)?.map((r) => r.to)).toContain(`${B}#b`);
  });
});

describe("scopeView: callers and callees", () => {
  const model = buildProjectModel(fixture());

  it("view src: callees of a include b, which is outside", () => {
    const view = scopeView(model, "src");
    expect(view.kind).toBe("folder");
    const callees = view.callees(`${A}#a`).filter((r) => r.kind === "call" && r.to === `${B}#b`);
    expect(callees).toHaveLength(1);
    expect(callees[0]?.inScope).toBe(false);
  });

  it("view lib: callers of b include a, which is outside", () => {
    const view = scopeView(model, "lib");
    const callers = view.callers(`${B}#b`).filter((r) => r.from === `${A}#a`);
    expect(callers).toHaveLength(1);
    expect(callers[0]?.inScope).toBe(false);
    expect(view.functions().map((f) => f.id)).toEqual([`${B}#b`]);
  });

  it("the root view tags both ends in scope", () => {
    const view = scopeView(model, "");
    expect(view.kind).toBe("project");
    expect(view.callees(`${A}#a`).every((r) => r.inScope)).toBe(true);
    expect(view.callers(`${B}#b`).every((r) => r.inScope)).toBe(true);
  });

  it("a file view holds the file's nodes and only that file", () => {
    const view = scopeView(model, A);
    expect(view.kind).toBe("file");
    expect(view.files()).toEqual([A]);
    expect(view.has(`${A}#a`)).toBe(true);
    expect(view.has(`${B}#b`)).toBe(false);
  });

  it("scope paths are checked", () => {
    expect(normalizeScope("src/")).toBe("src");
    expect(() => normalizeScope("../x")).toThrow(ScopeError);
  });
});

describe("scopeView: toDoc", () => {
  const model = buildProjectModel(fixture());

  it("the root returns the whole document", () => {
    const { doc, stats } = scopeView(model, "").toDoc();
    expect(doc.nodes).toHaveLength(model.doc.nodes.length);
    expect(doc.edges).toHaveLength(model.doc.edges.length);
    expect(stats.external).toBe(0);
  });

  it("a folder keeps its own nodes and stubs the far end of crossing edges", () => {
    const { doc, stats } = scopeView(model, "src").toDoc();
    const ids = doc.nodes.map((n) => n.id);
    expect(ids).toContain(`${A}#a`);
    const stub = doc.nodes.find((n) => n.id === `${B}#b`);
    expect(stub?.attrs.external).toBe(true);
    expect(stub?.span).toBeUndefined();
    expect(stats.external).toBeGreaterThan(0);
  });

  it("with externalStubs false, crossing edges are dropped and candidates keep only local members", () => {
    const { doc } = scopeView(model, "src").toDoc({ externalStubs: false });
    expect(doc.nodes.some((n) => n.attrs.external === true)).toBe(false);
    const fromC = doc.edges.filter((e) => e.from === `${SUB}#c`);
    expect(fromC.map((e) => e.to)).toEqual([{ candidates: [`${A}#a`] }]);
  });

  it("keeps a finding when its span lies in the scope", () => {
    expect(scopeView(model, "src").toDoc().doc.findings.map((f) => f.message)).toEqual(["in a"]);
    expect(scopeView(model, "lib").toDoc().doc.findings).toEqual([]);
  });
});
