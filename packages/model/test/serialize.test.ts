import { describe, expect, it } from "vitest";
import type { IRDocument, IRNode } from "@insight/ir";
import { irFixtures as fx } from "@insight/sdk";
import { buildProjectModel, loadModel, MODEL_SCHEMA, scopeView, serializeModel } from "../src/index.js";

const A = "src/a.ts";
const B = "lib/b.ts";
const SUB = "src/sub/c.ts";

function fixture(): IRDocument {
  const file = (path: string): IRNode => fx.node(path, "structure", "structure.file", { attrs: { path }, span: fx.span(path, 0, 0, 0, 0) });
  const fn = (path: string, name: string): IRNode =>
    fx.node(`${path}#${name}`, "structure", "structure.function", { attrs: { name }, parent: path, span: fx.span(path, 2, 0, 4, 1) });
  return {
    nodes: [file(A), file(B), file(SUB), fn(A, "a"), fn(B, "b"), fn(SUB, "c")],
    edges: [
      fx.edge(`${A}#a`, `${B}#b`, "calls", "calls.call", { span: fx.span(A, 3, 0, 3, 10) }),
      fx.edge(`${SUB}#c`, [`${A}#a`, `${B}#b`], "calls", "calls.call"),
      fx.edge(`${B}#b`, `${A}#a`, "calls", "calls.reference", { attrs: { how: "closure" } }),
    ],
    findings: [fx.finding("in a", { span: fx.span(A, 3, 0, 3, 5) })],
  };
}

/** The model as it crosses the wire: JSON text out, parsed, then loaded. */
function roundTrip(doc: IRDocument) {
  const model = buildProjectModel(doc);
  const text = JSON.stringify(serializeModel(model, "snap-1"));
  return { model, text, loaded: loadModel(JSON.parse(text)) };
}

describe("serializeModel and loadModel", () => {
  it("writes the schema, the snapshot and the document", () => {
    const { model } = roundTrip(fixture());
    const json = serializeModel(model, "snap-1");
    expect(json.schema).toBe(MODEL_SCHEMA);
    expect(json.snapshot).toBe("snap-1");
    expect(json.doc.nodes).toEqual(fixture().nodes);
    expect(json.doc.edges).toEqual(fixture().edges);
    expect(json.doc.findings).toEqual(fixture().findings);
  });

  it("rebuilds the same indexes after a JSON round trip", () => {
    const { model, loaded } = roundTrip(fixture());
    expect(loaded.files).toEqual(model.files);
    expect(loaded.functions).toEqual(model.functions);
    expect(loaded.tree).toEqual(model.tree);
    expect(loaded.relations).toEqual(model.relations);
    expect([...loaded.out.keys()].sort()).toEqual([...model.out.keys()].sort());
    expect([...loaded.in.keys()].sort()).toEqual([...model.in.keys()].sort());
    for (const node of model.doc.nodes) expect(loaded.fileOf(node.id)).toBe(model.fileOf(node.id));
  });

  it("answers scope views the same way after a round trip", () => {
    const { model, loaded } = roundTrip(fixture());
    for (const scope of ["", "src", SUB, B]) {
      const want = scopeView(model, scope);
      const got = scopeView(loaded, scope);
      expect(got.kind).toBe(want.kind);
      expect(got.files()).toEqual(want.files());
      expect(got.toDoc()).toEqual(want.toDoc());
    }
    expect(scopeView(loaded, B).callers(`${B}#b`)).toEqual(scopeView(model, B).callers(`${B}#b`));
  });

  it("refuses another schema number", () => {
    const { model } = roundTrip(fixture());
    expect(() => loadModel({ ...serializeModel(model, "snap-1"), schema: MODEL_SCHEMA + 1 })).toThrow(/schema/);
    expect(() => loadModel({ snapshot: "snap-1", doc: fixture() })).toThrow(/schema/);
  });

  it("refuses a value without a document", () => {
    expect(() => loadModel(null)).toThrow();
    expect(() => loadModel({ schema: MODEL_SCHEMA, snapshot: "s", doc: { nodes: [] } })).toThrow(/nodes, edges and findings/);
  });
});
