import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { CallerEdge, CallerGraph, CallerNode } from "@insight/model";
import { CallerChain, CallerChainView, callerHref } from "../src/components/zoom/CallerChain";
import type { MapSelection } from "../src/components/zoom/ZoomMap";
import { blindTip, completeness, expandAllKeys, summaryLine, treeKey, visibleRows, childEdges } from "../src/components/zoom/callerTree";
import { api } from "../src/api";
import { hrefView, parseRoute } from "../src/router";
import { findKeyAction, type FindItem } from "../src/components/sheet/FindPalette";

// Hand-built graphs: node ids are short names, so a row's key reads as its path (B, then B\u0001C, and so on).

const node = (id: string, depth: number, over: Partial<CallerNode> = {}): CallerNode => ({
  id,
  name: id,
  file: `src/${id.toLowerCase()}.ts`,
  line: 10,
  isFunction: true,
  inScope: true,
  depth,
  certainty: "exact",
  stop: "none",
  ...over,
});

const edge = (from: string, to: string, over: Partial<CallerEdge> = {}): CallerEdge => ({
  from,
  to,
  kind: "call",
  candidate: false,
  count: 1,
  back: false,
  ...over,
});

const graphOf = (root: string, nodes: CallerNode[], edges: CallerEdge[], over: Partial<CallerGraph> = {}): CallerGraph => {
  const callers = nodes.length - 1;
  const levels = Math.max(0, ...nodes.map((n) => n.depth));
  return {
    root,
    nodes,
    edges,
    cycles: [],
    stats: {
      callers,
      levels,
      possible: nodes.filter((n) => n.certainty === "possible").length,
      blind: nodes.filter((n) => n.blind !== undefined).length,
      outsideScope: nodes.filter((n) => !n.inScope).length,
    },
    ...over,
  };
};

// (a) A -> B -> T: A calls B, B calls T.
const chainA = graphOf("T", [node("T", 0), node("B", 1), node("A", 2)], [edge("B", "T"), edge("A", "B")]);
// (b) diamond: A -> B -> T and A -> C -> T.
const diamondB = graphOf(
  "T",
  [node("T", 0), node("B", 1), node("C", 1), node("A", 2)],
  [edge("B", "T"), edge("C", "T"), edge("A", "B"), edge("A", "C")],
);
// (b2) the diamond with a caller Z of A, so A has rows under both B and C.
const diamondZ = graphOf(
  "T",
  [node("T", 0), node("B", 1), node("C", 1), node("A", 2), node("Z", 3)],
  [edge("B", "T"), edge("C", "T"), edge("A", "B"), edge("A", "C"), edge("Z", "A")],
);
// (c) recursion: B calls T, C calls B, B calls C.
const recursion = graphOf("T", [node("T", 0), node("B", 1), node("C", 2)], [edge("B", "T"), edge("C", "B"), edge("B", "C")]);
// (d) a possible caller that is not followed.
const possibleOff = graphOf(
  "T",
  [node("T", 0), node("P", 1, { certainty: "possible", stop: "possible-off" })],
  [edge("P", "T", { kind: "reference", candidate: true })],
);
// (e) a value reference to V, with its call site.
const blindV = graphOf(
  "T",
  [node("T", 0), node("V", 1, { blind: ["value"] })],
  [edge("V", "T", { kind: "reference", how: "value", site: { file: "src/x.ts", line: 42 } })],
);
// (f) capped at 3 nodes: B has two callers the cap dropped.
const capped = graphOf(
  "T",
  [node("T", 0), node("B", 1, { stop: "nodes", hidden: 2 }), node("A", 2)],
  [edge("B", "T"), edge("A", "B")],
  { truncated: { reason: "nodes", at: 3 } },
);

const viewProps = (g: CallerGraph, over: Partial<Parameters<typeof CallerChainView>[0]> = {}) => ({
  id: "p1",
  scope: "packages/core",
  roots: false,
  graph: g,
  expanded: new Set<string>(),
  possible: false,
  stayInScope: false,
  depth: 10,
  lambdas: true,
  ...over,
});

const keysOf = (g: CallerGraph, expanded: string[] = [], lambdas = true) => visibleRows(g, new Set(expanded), { lambdas }).map((r) => r.key);

describe("caller chain container", () => {
  it("renders a collapsed details without fetching", () => {
    const spy = vi.spyOn(api, "getCallerGraph");
    const sel = { build: { path: "packages/core" }, selected: { ref: "packages/core/x.ts#f" } } as unknown as MapSelection;
    const html = renderToStaticMarkup(<CallerChain id="p1" sel={sel} roots={false} />);
    expect(html).toContain('<details class="ref-list caller-chain">');
    expect(html).not.toMatch(/<details[^>]* open/);
    expect(html).toContain("Caller chain");
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("visibleRows", () => {
  it("shows only the level-1 callers when nothing is expanded", () => {
    expect(keysOf(chainA)).toEqual(["B"]);
  });

  it("expanding B's key shows A at level 2", () => {
    const rows = visibleRows(chainA, new Set(["B"]), { lambdas: true });
    expect(rows.map((r) => [r.key, r.type === "more" ? -1 : r.level])).toEqual([
      ["B", 1],
      ["B\u0001A", 2],
    ]);
  });

  it("marks a node already on its path as a cycle that never expands", () => {
    const rows = visibleRows(recursion, new Set(["B", "B\u0001C"]), { lambdas: true });
    const back = rows.find((r) => r.key === "B\u0001C\u0001B");
    expect(back).toMatchObject({ type: "cycle", expandable: false });
  });

  it("gives A two rows in the diamond with alsoVia 1", () => {
    const rows = visibleRows(diamondB, new Set(["B", "C"]), { lambdas: true });
    const aRows = rows.filter((r) => r.type === "node" && r.node.id === "A");
    expect(aRows).toHaveLength(2);
    for (const r of aRows) expect(r.type === "node" && r.alsoVia).toBe(1);
  });

  it("drops lambda rows and their subtrees when lambdas are off", () => {
    const g = graphOf("T", [node("T", 0), node("λ1", 1), node("A", 2)], [edge("λ1", "T"), edge("A", "λ1")]);
    expect(keysOf(g, ["λ1"], false)).toEqual([]);
    expect(keysOf(g, ["λ1"], true)).toEqual(["λ1", "λ1\u0001A"]);
  });
});

describe("expandAllKeys", () => {
  it("expands the level-1 rows to depth 2 and not further", () => {
    const { keys, capped: c } = expandAllKeys(chainA, 2, { lambdas: true });
    expect(c).toBe(false);
    expect([...keys]).toEqual(["B"]);
  });

  it("does not expand a node twice on a second path", () => {
    const { keys } = expandAllKeys(diamondZ, 10, { lambdas: true });
    expect(keys.has("B\u0001A")).toBe(true);
    expect(keys.has("C\u0001A")).toBe(false);
    expect(keys.size).toBe(3);
  });

  it("stops when the rows would pass the cap", () => {
    const { keys, capped: c } = expandAllKeys(diamondB, 10, { lambdas: true }, 2);
    expect(c).toBe(true);
    expect(keys.size).toBe(0);
  });
});

describe("views and notes", () => {
  it("shows the cycle text for the recursion", () => {
    const html = renderToStaticMarkup(<CallerChainView {...viewProps(recursion, { expanded: new Set(["B", "B\u0001C"]) })} />);
    expect(html).toContain("↻ calls back into B");
  });

  it("shows the also-via text for the diamond", () => {
    const html = renderToStaticMarkup(<CallerChainView {...viewProps(diamondB, { expanded: new Set(["B"]) })} />);
    expect(html).toContain("also via 1 path");
  });

  it("marks a possible caller, with the possible tag and no toggle", () => {
    const html = renderToStaticMarkup(<CallerChainView {...viewProps(possibleOff)} />);
    expect(html).toMatch(/<li[^>]*class="chain-row possible"/);
    expect(html).toContain('<span class="chain-possible">possible</span>');
    expect(html).not.toContain("aria-expanded");
    expect(completeness(possibleOff, false).complete).toBe(false);
    expect(completeness(possibleOff, false).text).toContain("Possible callers");
  });

  it("gives the blind mark a tip with the value site", () => {
    const html = renderToStaticMarkup(<CallerChainView {...viewProps(blindV)} />);
    const title = html.match(/class="chain-blind" title="([^"]+)"/)?.[1] ?? "";
    expect(title).toContain("Passed as a value at src/x.ts:42");
    expect(blindTip(blindV.nodes[1] as CallerNode, blindV.edges[0])).toContain("Passed as a value at src/x.ts:42");
  });

  it("shows the +N more row under an expanded node, and the cap in the summary", () => {
    const closed = renderToStaticMarkup(<CallerChainView {...viewProps(capped)} />);
    expect(closed).not.toContain("+2 more");
    const open = renderToStaticMarkup(<CallerChainView {...viewProps(capped, { expanded: new Set(["B"]) })} />);
    expect(open).toContain("+2 more");
    expect(summaryLine(capped)).toContain("capped at 3 nodes");
  });

  it("says the chain is complete when nothing is blind, capped or possible", () => {
    expect(completeness(chainA, false)).toEqual({ complete: true, text: "Complete within the index." });
    expect(summaryLine(chainA)).toBe("2 callers across 2 levels");
  });
});

describe("treeKey", () => {
  const rows = visibleRows(diamondB, new Set(), { lambdas: true });
  const none = new Set<string>();

  it("moves focus down from the first row", () => {
    expect(treeKey(rows, { expanded: none }, "ArrowDown").focus).toBe("C");
  });

  it("expands a collapsed row on right, then moves to its first child", () => {
    const first = treeKey(rows, { focus: "B", expanded: none }, "ArrowRight");
    expect(first.expanded.has("B")).toBe(true);
    const open = visibleRows(diamondB, first.expanded, { lambdas: true });
    const second = treeKey(open, { focus: "B", expanded: first.expanded }, "ArrowRight");
    expect(second.focus).toBe("B\u0001A");
  });

  it("moves to the parent on left from a child", () => {
    const open = visibleRows(diamondB, new Set(["B"]), { lambdas: true });
    expect(treeKey(open, { focus: "B\u0001A", expanded: new Set(["B"]) }, "ArrowLeft").focus).toBe("B");
  });

  it("collapses an expanded row on left", () => {
    const opened = visibleRows(diamondB, new Set(["B"]), { lambdas: true });
    const r = treeKey(opened, { focus: "B", expanded: new Set(["B"]) }, "ArrowLeft");
    expect(r.expanded.has("B")).toBe(false);
  });

  it("goes to the first and last row on Home and End", () => {
    const open = visibleRows(diamondB, new Set(["B", "C"]), { lambdas: true });
    expect(treeKey(open, { focus: "B", expanded: new Set() }, "End").focus).toBe(open[open.length - 1]?.key);
    expect(treeKey(open, { focus: "C", expanded: new Set() }, "Home").focus).toBe("B");
  });

  it("opens the focused row on Enter", () => {
    expect(treeKey(rows, { focus: "C", expanded: none }, "Enter").open).toBe("C");
  });

  it("expands every expandable sibling on star", () => {
    const r = treeKey(rows, { focus: "B", expanded: none }, "*");
    expect([...r.expanded].sort()).toEqual(["B", "C"]);
  });

  it("returns the state unchanged for an unknown key", () => {
    expect(treeKey(rows, { focus: "C", expanded: none }, "x")).toEqual({ focus: "C", expanded: new Set() });
  });
});

describe("tree markup", () => {
  it("exposes the tree roles, levels and expansion, with one tab stop", () => {
    const html = renderToStaticMarkup(<CallerChainView {...viewProps(diamondB)} />);
    expect(html).toContain('role="tree"');
    expect(html).toContain('role="treeitem"');
    expect(html).toContain('aria-level="1"');
    expect(html).toContain('aria-expanded="false"');
    expect(html.match(/tabindex="0"/g) ?? []).toHaveLength(1);
  });
});

describe("callerHref", () => {
  it("keeps the scope for an in-scope function", () => {
    const n = node("packages/core/model/src/scope.ts#inScope", 1, { file: "packages/core/model/src/scope.ts" });
    const route = parseRoute(callerHref("p1", "packages/core/model", false, n));
    expect(route).toMatchObject({ name: "workspace", tab: "flow", scope: "packages/core/model", fn: n.id });
  });

  it("switches to the file's scope for an outside function", () => {
    const n = node("packages/core/test/scope.test.ts#caller", 1, { file: "packages/core/test/scope.test.ts", inScope: false });
    const route = parseRoute(callerHref("p1", "packages/core/model", false, n));
    expect(route).toMatchObject({ name: "workspace", scope: "packages/core/test/scope.test.ts", fn: n.id });
  });

  it("opens the file's flow for a non-function", () => {
    const n = node("src/mod.ts", 1, { isFunction: false, file: "src/mod.ts" });
    const route = parseRoute(callerHref("p1", "packages/core", false, n));
    expect(route).toMatchObject({ name: "workspace", tab: "flow", scope: "src/mod.ts" });
    expect((route as { fn?: string }).fn).toBeUndefined();
  });
});

describe("childEdges", () => {
  it("groups the edges by callee in graph order", () => {
    const map = childEdges(diamondB);
    expect(map.get("T")?.map((e) => e.from)).toEqual(["B", "C"]);
  });
});

describe("trace anchor", () => {
  it("parses trace from the view route", () => {
    expect(parseRoute("#/projects/p/view/flow?scope=src&fn=a&trace=b")).toMatchObject({ name: "workspace", fn: "a", trace: "b" });
  });

  it("round-trips trace through hrefView and parseRoute", () => {
    const href = hrefView("p", "flow", { scope: "src", fn: "src/a.ts#a", trace: "src/b.ts#b", roots: true });
    expect(href).toContain("trace=");
    expect(parseRoute(href)).toMatchObject({ trace: "src/b.ts#b", fn: "src/a.ts#a", scope: "src" });
  });

  it("keeps trace in callerHref for in-scope and out-of-scope function rows", () => {
    const inside = node("src/x.ts#f", 1, { file: "src/x.ts" });
    const outside = node("lib/y.ts#g", 1, { file: "lib/y.ts", inScope: false });
    expect(parseRoute(callerHref("p1", "src", true, inside, "src/t.ts#t"))).toMatchObject({ trace: "src/t.ts#t", scope: "src" });
    expect(parseRoute(callerHref("p1", "src", true, outside, "src/t.ts#t"))).toMatchObject({ trace: "src/t.ts#t", scope: "lib/y.ts" });
  });

  it("drops trace for a non-function row", () => {
    const file = node("src/z.ts", 1, { isFunction: false, file: "src/z.ts" });
    expect(callerHref("p1", "src", true, file, "src/t.ts#t")).not.toContain("trace=");
  });

  it("shows trace in the row links of a traced view", () => {
    const html = renderToStaticMarkup(
      <CallerChainView
        id="p1"
        scope="src"
        roots={true}
        graph={chainA}
        expanded={new Set(["B"])}
        possible={false}
        stayInScope={false}
        depth={6}
        lambdas={true}
        trace="T"
      />,
    );
    expect(html).toContain("trace=T");
    expect(html).not.toContain("Anchor here");
  });

  it("offers Anchor here in the untraced view", () => {
    const html = renderToStaticMarkup(
      <CallerChainView id="p1" scope="src" roots={true} graph={chainA} expanded={new Set()} possible={false} stayInScope={false} depth={6} lambdas={true} pin="T" />,
    );
    expect(html).toContain('class="chain-pin"');
    expect(html).toContain("trace=T");
  });

  it("renders the traced container open with the Callers header and a clearing link without trace", () => {
    const sel = { build: { path: "src" }, selected: { ref: "src/a.ts#walk", name: "walk" } } as unknown as MapSelection;
    const html = renderToStaticMarkup(<CallerChain id="p1" sel={sel} roots={true} trace="src/t.ts#target" />);
    expect(html).toMatch(/<details class="ref-list caller-chain" open="">/);
    expect(html).toContain("Callers of");
    expect(html).toContain("target");
    const clear = html.match(/<a class="chain-clear" href="([^"]*)"/);
    expect(clear).not.toBeNull();
    expect(clear?.[1]).toContain("fn=");
    expect(clear?.[1]).not.toContain("trace=");
  });
});

describe("findKeyAction", () => {
  const fnRow: FindItem = {
    key: "fn:src/a.ts#run",
    label: "run",
    detail: "src/a.ts:3",
    href: hrefView("p1", "flow", { scope: "src/a.ts", fn: "src/a.ts#run" }),
    callersHref: hrefView("p1", "flow", { scope: "src/a.ts", fn: "src/a.ts#run", trace: "src/a.ts#run" }),
    kind: "function",
  };
  const fileRow: FindItem = { key: "file:src/a.ts", label: "a.ts", detail: "src/a.ts", href: hrefView("p1", "flow", { scope: "src/a.ts" }), kind: "file" };

  it("opens the callers view on Shift+Enter for a function, with trace", () => {
    const act = findKeyAction(fnRow, { key: "Enter", shiftKey: true });
    expect(act?.href).toContain("trace=");
    expect(parseRoute(act?.href ?? "")).toMatchObject({ fn: "src/a.ts#run", scope: "src/a.ts", trace: "src/a.ts#run" });
  });

  it("keeps the plain link on Enter", () => {
    expect(findKeyAction(fnRow, { key: "Enter", shiftKey: false })).toEqual({ href: fnRow.href });
  });

  it("treats Shift+Enter on a file row as Enter", () => {
    expect(findKeyAction(fileRow, { key: "Enter", shiftKey: true })).toEqual({ href: fileRow.href });
  });

  it("ignores other keys and a missing row", () => {
    expect(findKeyAction(fnRow, { key: "ArrowDown", shiftKey: false })).toBeUndefined();
    expect(findKeyAction(undefined, { key: "Enter", shiftKey: false })).toBeUndefined();
  });
});
