import { describe, expect, it } from "vitest";
import { createCoreRegistry, type IREdge, type IRNode } from "@insight/ir";
import { IRView, edgeTargets } from "../src/index.js";

const prov = { frontend: "fixture", confidence: "exact" as const };
const node = (id: string, facet: string, kind: string, attrs: Record<string, unknown> = {}, parent?: string): IRNode =>
  ({ id, facet, kind, attrs, provenance: prov, ...(parent ? { parent } : {}) }) as IRNode;
const edge = (from: string, to: IREdge["to"], facet: string, kind: string): IREdge =>
  ({ from, to, facet, kind, provenance: prov }) as IREdge;

function build() {
  const registry = createCoreRegistry().clone();
  registry.add(
    [
      {
        kind: "x-test.rwlock-timed",
        facet: "sync",
        on: "node",
        extends: "sync.rwlock-acquire",
        attrs: { type: "object", properties: { timeoutMs: { type: "integer" } } },
      },
    ],
    "fixture-plugin",
  );
  const nodes = [
    node("a.ts", "structure", "structure.file", { path: "a.ts" }),
    node("a.ts#f", "structure", "structure.function", { name: "f" }, "a.ts"),
    node("a.ts#f/lock/1", "sync", "sync.lock-acquire", { lock: "L", mode: "exclusive" }, "a.ts#f"),
    node("a.ts#f/lock/2", "sync", "sync.rwlock-acquire", { mode: "shared" }, "a.ts#f"),
    node("a.ts#f/lock/3", "sync", "x-test.rwlock-timed", { mode: "shared", timeoutMs: 50 }, "a.ts#f"),
    node("a.ts#f/fs/1", "effects", "effects.fs.read", { api: "readFile" }, "a.ts#f"),
  ];
  const edges = [
    edge("a.ts#f", "a.ts#g", "calls", "calls.call"),
    edge("a.ts#f", { candidates: ["a.ts#g", "b.ts#h"] }, "calls", "calls.call"),
    edge("a.ts", { unresolved: { scheme: "ts.import", text: "./b" } }, "packaging", "packaging.import"),
  ];
  return { registry, view: new IRView({ nodes, edges, registry }) };
}

describe("IRView", () => {
  it("returns subkinds when a parent kind is queried", () => {
    const { view } = build();
    const ids = view.nodes({ kind: "sync.lock-acquire" }).map((n) => n.id);
    expect(ids).toEqual(["a.ts#f/lock/1", "a.ts#f/lock/2", "a.ts#f/lock/3"]);
  });

  it("returns only the exact kind when a leaf kind is queried", () => {
    const { view } = build();
    expect(view.nodes({ kind: "sync.rwlock-acquire" }).map((n) => n.id)).toEqual(["a.ts#f/lock/2", "a.ts#f/lock/3"]);
    expect(view.nodes({ kind: "x-test.rwlock-timed" }).map((n) => n.id)).toEqual(["a.ts#f/lock/3"]);
  });

  it("filters by facet and returns everything when no query is given", () => {
    const { view } = build();
    expect(view.nodes({ facet: "effects" }).map((n) => n.kind)).toEqual(["effects.fs.read"]);
    expect(view.nodes()).toHaveLength(6);
  });

  it("answers edge queries by kind, direction and facet", () => {
    const { view } = build();
    expect(view.out("a.ts#f", { kind: "calls.call" })).toHaveLength(2);
    expect(view.in("a.ts#g")).toHaveLength(2);
    expect(view.in("b.ts#h")).toHaveLength(1);
    expect(view.edges({ facet: "packaging" })).toHaveLength(1);
  });

  it("reports facets present, opaque kinds and children", () => {
    const { view } = build();
    expect([...view.facets()].sort()).toEqual(["calls", "effects", "packaging", "structure", "sync"]);
    expect(view.hasFacet("flow")).toBe(false);
    expect(view.opaqueKinds()).toEqual([]);
    expect(view.children("a.ts").map((n) => n.id)).toEqual(["a.ts#f"]);
  });

  it("splits edge targets into nodes, candidates and unresolved references", () => {
    const { view } = build();
    const [direct, candidate] = view.out("a.ts#f", { kind: "calls.call" });
    expect(edgeTargets(direct!)).toEqual({ nodes: ["a.ts#g"], candidates: [] });
    expect(edgeTargets(candidate!)).toEqual({ nodes: [], candidates: ["a.ts#g", "b.ts#h"] });
    const unresolved = view.edges({ kind: "packaging.import" })[0]!;
    expect(edgeTargets(unresolved).unresolved).toEqual({ scheme: "ts.import", text: "./b" });
  });
});
