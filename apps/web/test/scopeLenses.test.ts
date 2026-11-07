import { describe, expect, it } from "vitest";
import type { LensView, ScopeLensRow, TreeView } from "../src/api.js";
import { granularityOf, lensOrder, lensTab, nodeText, plainReason, resultHasContent, scopeBanner, viewHasContent } from "../src/scopeLenses.js";

function row(over: Partial<ScopeLensRow> & Pick<ScopeLensRow, "id">): ScopeLensRow {
  return { title: over.id, status: "ok", findings: 0, ...over };
}

function tree(root: TreeView["root"], id = "execution"): TreeView {
  return { type: "tree", id, title: "Execution", root };
}

describe("lensOrder", () => {
  it("puts lens-execution first and keeps the rest in the order the server gave", () => {
    const rows = [row({ id: "lens-calls" }), row({ id: "lens-execution" }), row({ id: "lens-effects" }), row({ id: "lens-flow-complexity" })];
    expect(lensOrder(rows).map((r) => r.id)).toEqual(["lens-execution", "lens-calls", "lens-effects", "lens-flow-complexity"]);
  });

  it("does not change the list it is given", () => {
    const rows = [row({ id: "b" }), row({ id: "lens-execution" })];
    lensOrder(rows);
    expect(rows.map((r) => r.id)).toEqual(["b", "lens-execution"]);
  });
});

describe("lensTab", () => {
  it("shows an ok lens with content as a plain tab", () => {
    expect(lensTab(row({ id: "a", status: "ok" }))).toEqual({ id: "a", title: "a", dim: false });
    expect(lensTab(row({ id: "a", status: "ok", hasContent: true })).dim).toBe(false);
  });

  it("dims an ok lens the demo captured as empty, with a reason", () => {
    const tab = lensTab(row({ id: "a", status: "ok", hasContent: false }));
    expect(tab.dim).toBe(true);
    expect(tab.reason).toBe("Nothing to show for this scope.");
  });

  it("dims an unavailable or errored lens with the server's reason", () => {
    expect(lensTab(row({ id: "a", status: "unavailable", reason: "needs a TypeScript project" }))).toEqual({
      id: "a",
      title: "a",
      dim: true,
      reason: "needs a TypeScript project",
    });
    expect(lensTab(row({ id: "a", status: "error", reason: "boom" })).reason).toBe("boom");
  });

  it("dims a lens that has not run on the scope, and says that opening it runs it", () => {
    const tab = lensTab(row({ id: "a", status: "not-run" }));
    expect(tab.dim).toBe(true);
    expect(tab.reason).toBe("Not run on this scope yet. Opening it runs the lens.");
  });

  it("says a lens is not captured in the demo, where opening it cannot run it", () => {
    const tab = lensTab(row({ id: "a", status: "not-run" }), false);
    expect(tab.dim).toBe(true);
    expect(tab.reason).toBe("Not captured for this scope in the demo.");
  });
});

describe("plainReason", () => {
  it("drops the status the server puts in front of a reason", () => {
    expect(plainReason('unavailable: scope "a" has no concurrency facts', "unavailable")).toBe('scope "a" has no concurrency facts');
    expect(plainReason("unavailable: no frontend provides effects", "unavailable")).toBe("no frontend provides effects");
  });

  it("keeps a reason that has no such prefix, and says the status when there is no reason", () => {
    expect(plainReason("boom", "error")).toBe("boom");
    expect(plainReason(undefined, "unavailable")).toBe("unavailable");
  });
});

describe("scopeBanner", () => {
  it("names the scope and counts its nodes, edges and external nodes", () => {
    expect(scopeBanner("src/core", { nodes: 12, edges: 9, findings: 0, external: 2 })).toBe("src/core · 12 nodes · 9 edges · 2 external");
  });

  it("uses the project name at root", () => {
    expect(scopeBanner("my-project", { nodes: 3, edges: 0, findings: 0, external: 0 })).toBe("my-project · 3 nodes · 0 edges · 0 external");
  });
});

describe("granularityOf", () => {
  it("is processes when the execution tree starts at a process", () => {
    const view = tree({ label: "Program", kind: "process", children: [{ label: "Main thread", kind: "thread" }] });
    expect(granularityOf([view])).toBe("processes");
  });

  it("is functions when the root is a module with real children", () => {
    const view = tree({ label: "src/core", kind: "module", children: [{ label: "parse", kind: "function" }] });
    expect(granularityOf([view])).toBe("functions");
  });

  it("is undefined when the tree holds only the empty-state placeholder", () => {
    const view = tree({ label: "src/none", kind: "module", children: [{ label: "Nothing to show", kind: "empty" }] });
    expect(granularityOf([view])).toBeUndefined();
  });

  it("is undefined when there is no execution tree", () => {
    const other = tree({ label: "x", kind: "process", children: [] }, "calls");
    expect(granularityOf([other])).toBeUndefined();
    expect(granularityOf([])).toBeUndefined();
  });
});

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
    expect(viewHasContent(tree({ label: "r", children: [{ label: "Nothing to show", kind: "empty" }] }))).toBe(false);
    expect(viewHasContent(tree({ label: "r", children: [{ label: "parse", kind: "function" }] }))).toBe(true);
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
});

describe("nodeText", () => {
  it("shows a file path by its last two parts", () => {
    expect(nodeText("apps/web/src/components/Workspace.tsx")).toBe("components/Workspace.tsx");
    expect(nodeText("packages/x/y")).toBe("x/y");
  });

  it("keeps a label that is not a bare path", () => {
    expect(nodeText("parse")).toBe("parse");
    expect(nodeText("api.ts")).toBe("api.ts");
    expect(nodeText("src/a.ts:12 load")).toBe("src/a.ts:12 load");
  });
});
