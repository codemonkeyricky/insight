import { describe, expect, it } from "vitest";
import type { LensView } from "../src/api.js";
import { resultHasContent, viewHasContent } from "../src/scopeLenses.js";

describe("viewHasContent", () => {
  it("is false for an empty graph and an empty table", () => {
    expect(viewHasContent({ type: "graph", id: "g", title: "g", nodes: [], edges: [] })).toBe(false);
    expect(viewHasContent({ type: "table", id: "t", title: "t", columns: ["a"], rows: [] })).toBe(false);
  });

  it("is true for a graph with an edge or a table with a row", () => {
    expect(viewHasContent({ type: "graph", id: "g", title: "g", nodes: [], edges: [{ from: "a", to: "b", kind: "imports" }] })).toBe(true);
    expect(viewHasContent({ type: "table", id: "t", title: "t", columns: ["a"], rows: [["x"]] })).toBe(true);
  });

  it("is false for a tree with only the empty placeholder, and true with real children", () => {
    expect(viewHasContent({ type: "tree", id: "execution", title: "r", root: { label: "r", children: [{ label: "Nothing to show", kind: "empty" }] } })).toBe(false);
    expect(viewHasContent({ type: "tree", id: "execution", title: "r", root: { label: "r", children: [{ label: "parse", kind: "function" }] } })).toBe(true);
  });
});

describe("resultHasContent", () => {
  const graph: LensView = { type: "graph", id: "g", title: "g", nodes: [], edges: [] };

  it("counts a finding as content", () => {
    expect(resultHasContent({ findings: [{}], views: [graph] })).toBe(true);
  });

  it("counts a view with something in it as content", () => {
    const table: LensView = { type: "table", id: "t", title: "t", columns: ["a"], rows: [["x"]] };
    expect(resultHasContent({ findings: [], views: [graph, table] })).toBe(true);
  });

  it("does not count metrics alone, nor empty views", () => {
    expect(resultHasContent({ findings: [], views: [graph] })).toBe(false);
    expect(resultHasContent({ findings: [], views: [] })).toBe(false);
  });

  it("counts a state machine only when it has a transition", () => {
    const base = { type: "state-machine" as const, id: "m", title: "m", holder: { id: "h", name: "h", domainKind: "enum" as const }, states: [] };
    expect(viewHasContent({ ...base, transitions: [] })).toBe(false);
    expect(viewHasContent({ ...base, transitions: [{ id: "t", from: "a", to: "b", confidence: "exact", sites: [] }] })).toBe(true);
  });
});
