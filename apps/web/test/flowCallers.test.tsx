import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { layoutFunction, relayout, type FunctionFlow, type Rect } from "@insight/flow";
import type { RefRow } from "@insight/model";
import { FlowChart } from "../src/components/FlowChart";
import { ExpansionShape } from "../src/components/zoom/Expansion";
import { mergeCallers } from "../src/zoom/callers";
import {
  CALLERS_W,
  EXPAND_GAP,
  HEADER_STEP,
  callerRowRect,
  callersAt,
  callersKey,
  chainHas,
  closeExpansion,
  headerAnchor,
  hangCallersFrom,
  openCallers,
  openExpansion,
  reflow,
  resizeCallers,
  toggleCallers,
  type Expansion,
} from "../src/zoom/expand.js";

const chart = (id: string, width: number, height: number) => ({ id, name: id, width, height, nodes: [], edges: [] }) as unknown as FunctionFlow;
const view: Rect = { x: 0, y: 0, w: 1000, h: 800 };
const box: Rect = { x: 100, y: 50, w: 230, h: 44 };
const boxAnchor = { kind: "box" as const, nodeId: "n", rect: box };
const row = (over: Partial<RefRow> & { id: string; kind: RefRow["kind"] }): RefRow =>
  ({
    name: over.id,
    file: "src/a.ts",
    line: 3,
    isFunction: true,
    how: undefined,
    candidate: false,
    count: 1,
    inScope: true,
    ...over,
  }) as RefRow;
/** Two placed expansions overlap when their rects share an area. */
const overlaps = (a: Expansion, b: Expansion) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const find = (list: readonly Expansion[], fnId: string): Expansion => {
  const e = list.find((x) => x.fnId === fnId);
  if (e === undefined) throw new Error(`no expansion ${fnId}`);
  return e;
};

describe("merging callers", () => {
  it("merges a call and a dispatch of the same caller into one row with a dispatch badge", () => {
    const rows = [row({ id: "f#pump", kind: "call", name: "VerifyClient.pump" }), row({ id: "f#pump", kind: "dispatch", name: "VerifyClient.pump" }), row({ id: "f#top", kind: "call", name: "verify.worker.ts · top level", isFunction: false })];
    const merged = mergeCallers(rows, true);
    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({ id: "f#pump", kinds: ["dispatch"] });
    expect(merged[1]).toMatchObject({ id: "f#top", kinds: [] });
  });

  it("names a message dispatch by its how, and drops lambda callers unless they are shown", () => {
    const rows = [row({ id: "f#m", kind: "dispatch", how: "message" }), row({ id: "f#λ", kind: "call", name: "λ handler" })];
    expect(mergeCallers(rows, false).map((r) => r.kinds)).toEqual([["message"]]);
    expect(mergeCallers(rows, true)).toHaveLength(2);
  });

  it("drops reference rows (a function passed as a value), keeps spawns, and is a candidate only when every row is", () => {
    const rows = [
      row({ id: "f#ref", kind: "reference" }),
      row({ id: "f#c", kind: "call", candidate: true }),
      row({ id: "f#d", kind: "call", candidate: true }),
      row({ id: "f#d", kind: "dispatch", candidate: false }),
      row({ id: "f#s", kind: "spawn", candidate: false }),
    ];
    const merged = mergeCallers(rows, true);
    expect(merged.map((r) => r.id)).toEqual(["f#c", "f#d", "f#s"]);
    expect(merged[0]).toMatchObject({ candidate: true, kinds: [] });
    expect(merged[1]).toMatchObject({ candidate: false, kinds: ["dispatch"] });
    expect(merged[2]).toMatchObject({ candidate: false, kinds: ["spawn"] });
  });
});

describe("callers box placement", () => {
  it("opens to the right of a function box and reflow keeps it there", () => {
    const list = openCallers([], "A", boxAnchor, "A", 3, view);
    const c = find(list, callersKey("A"));
    expect(c.kind).toBe("callers");
    expect(c.x).toBeGreaterThanOrEqual(box.x + box.w + EXPAND_GAP);
    expect(c.w).toBe(CALLERS_W);
    expect(reflow(list, view).find((e) => e.fnId === callersKey("A"))?.x).toBe(c.x);
  });

  it("hangs a callers box from a chart's header to the chart's right", () => {
    const parent = openExpansion([], "A", boxAnchor, chart("A", 300, 200), view);
    const p = find(parent, "A");
    const list = openCallers(parent, "A", headerAnchor(p), "A", 2, view);
    const c = find(list, callersKey("A"));
    expect(c.x).toBe(p.x + p.w + EXPAND_GAP);
    expect(c.y).toBe(p.y);
  });

  it("follows a resized parent: the callers box keeps its place right of the parent's new edge", () => {
    const parent = openExpansion([], "A", boxAnchor, chart("A", 300, 200), view);
    const list = openCallers(parent, "A", headerAnchor(find(parent, "A")), "A", 2, view);
    const p = find(list, "A");
    const grown = reflow(list.map((e) => (e.fnId === "A" ? { ...e, w: p.w + 200 } : e)), view);
    const c = find(grown, callersKey("A"));
    expect(c.x).toBe(p.x + p.w + 200 + EXPAND_GAP);
    expect(c.x).toBeGreaterThanOrEqual(p.x + p.w + 200 + EXPAND_GAP);
  });

  it("closing the parent closes the callers box and a caller's chart opened from its row", () => {
    const a = openExpansion([], "A", boxAnchor, chart("A", 300, 200), view);
    const withCallers = toggleCallers(a, "A", headerAnchor(find(a, "A")), "A", view);
    const withCaller = openExpansion(withCallers, "B", { kind: "step", fnId: callersKey("A"), stepId: "pump", rect: callerRowRect(0) }, chart("B", 200, 100), view);
    expect(withCaller.map((e) => e.fnId)).toEqual(["A", callersKey("A"), "B"]);
    expect(closeExpansion(withCaller, "A")).toEqual([]);
  });

  it("toggling the callers button twice closes the box", () => {
    const once = toggleCallers([], "A", boxAnchor, "A", view);
    expect(once.some((e) => e.fnId === callersKey("A"))).toBe(true);
    expect(toggleCallers(once, "A", boxAnchor, "A", view)).toEqual([]);
  });

  it("a callers box takes no detail letter: the next chart opened is still B's index after A's", () => {
    const withCallers = openCallers([], "A", boxAnchor, "A", 3, view);
    expect(find(withCallers, callersKey("A")).index).toBe(-1);
    const withChart = openExpansion(withCallers, "B", boxAnchor, chart("B", 200, 100), view);
    expect(find(withChart, "B").index).toBe(0);
  });
});

describe("one right-hand child per chart", () => {
  it("opening a callers box on a chart closes its open step child, and a step child closes the callers box", () => {
    const parent = openExpansion([], "P", boxAnchor, chart("P", 300, 200), view);
    const p = find(parent, "P");
    const step = { kind: "step" as const, fnId: "P", stepId: "n1", rect: { x: 10, y: 20, w: 80, h: 20 } };
    const withStep = openExpansion(parent, "S", step, chart("S", 200, 100), view);
    expect(withStep.some((e) => e.fnId === "S")).toBe(true);

    const withCallers = openCallers(withStep, "P", headerAnchor(p), "P", 2, view);
    expect(withCallers.some((e) => e.fnId === "S")).toBe(false);
    expect(withCallers.some((e) => e.fnId === callersKey("P"))).toBe(true);

    const withStepAgain = openExpansion(withCallers, "S", step, chart("S", 200, 100), view);
    expect(withStepAgain.some((e) => e.fnId === callersKey("P"))).toBe(false);
    expect(withStepAgain.some((e) => e.fnId === "S")).toBe(true);
  });

  it("two callers boxes in one chart never sit side by side", () => {
    const parent = openExpansion([], "P", boxAnchor, chart("P", 300, 200), view);
    const p = find(parent, "P");
    const nested = (stepId: string) => ({ kind: "step" as const, fnId: "P", stepId, rect: { x: 10, y: 20, w: 80, h: 20 } });
    const one = openCallers(parent, "X", nested("n1"), "X", 2, view);
    const two = openCallers(one, "Y", nested("n2"), "Y", 2, view);
    expect(two.some((e) => e.fnId === callersKey("X"))).toBe(false);
    expect(two.some((e) => e.fnId === callersKey("Y"))).toBe(true);
    const all = two.filter((e) => e.anchor.kind === "step" && e.anchor.fnId === "P");
    expect(all).toHaveLength(1);
    for (const a of two) for (const b of two) if (a !== b) expect(overlaps(a, b)).toBe(false);
    expect(p.x).toBeLessThan(find(two, callersKey("Y")).x);
  });
});

describe("a card's chart over its callers box", () => {
  it("opening the card's chart re-anchors its callers box on the chart's header, and the chart opened from a row survives", () => {
    const card = openCallers([], "A", boxAnchor, "A", 3, view);
    const withChart = openExpansion(card, "A", boxAnchor, chart("A", 300, 200), view);
    const hung = hangCallersFrom(withChart, "A", view);
    const withRow = openExpansion(hung, "B", { kind: "step", fnId: callersKey("A"), stepId: "b", rect: callerRowRect(0) }, chart("B", 200, 100), view);
    const head = find(withRow, "A");
    const c = find(withRow, callersKey("A"));
    expect(c.anchor).toMatchObject({ kind: "step", fnId: "A", stepId: HEADER_STEP });
    expect(c.x).toBe(head.x + head.w + EXPAND_GAP);
    expect(withRow.map((e) => e.fnId)).toEqual(expect.arrayContaining(["A", callersKey("A"), "B"]));
    expect(find(withRow, "B").x).toBeGreaterThanOrEqual(c.x + c.w + EXPAND_GAP);
  });
});

describe("callers box anchors", () => {
  it("a box open at one anchor is not open at another: the header's button is not shown open for the card's box", () => {
    const card = toggleCallers([], "A", boxAnchor, "A", view);
    const chartOpen = openExpansion(card, "A", boxAnchor, chart("A", 300, 200), view);
    const hung = hangCallersFrom(chartOpen, "A", view);
    expect(callersAt(hung, "A", headerAnchor(find(hung, "A")))).toBe(true);
    expect(callersAt(hung, "A", boxAnchor)).toBe(false);
  });

  it("clicking a button whose function has a callers box elsewhere moves the box there, and does not close it", () => {
    const parent = openExpansion([], "A", boxAnchor, chart("A", 300, 200), view);
    const p = find(parent, "A");
    const atBox = toggleCallers(parent, "A", boxAnchor, "A", view);
    expect(callersAt(atBox, "A", boxAnchor)).toBe(true);
    const moved = toggleCallers(atBox, "A", headerAnchor(p), "A", view);
    expect(moved.some((e) => e.fnId === callersKey("A"))).toBe(true);
    expect(callersAt(moved, "A", headerAnchor(p))).toBe(true);
    expect(callersAt(moved, "A", boxAnchor)).toBe(false);
    expect(toggleCallers(moved, "A", headerAnchor(p), "A", view).some((e) => e.fnId === callersKey("A"))).toBe(false);
  });
});

describe("recursion", () => {
  it("a caller already open above its box is in the chain: opening it again is refused, so the row selects instead", () => {
    const parent = openExpansion([], "A", boxAnchor, chart("A", 300, 200), view);
    const withCallers = toggleCallers(parent, "A", headerAnchor(find(parent, "A")), "A", view);
    expect(chainHas(withCallers, callersKey("A"), "A")).toBe(true);
    const again = openExpansion(withCallers, "A", { kind: "step", fnId: callersKey("A"), stepId: "A", rect: callerRowRect(0) }, chart("A", 300, 200), view);
    expect(again).toBe(withCallers);
  });
});

describe("resizing a callers box", () => {
  it("resizeCallers keeps the box's size when unchanged and grows it when the rows change", () => {
    const list = openCallers([], "A", boxAnchor, "A", 1, view);
    expect(resizeCallers(list, "A", 1, view)).toBe(list);
    const grown = resizeCallers(list, "A", 4, view);
    expect(find(grown, callersKey("A")).h).toBeGreaterThan(find(list, callersKey("A")).h);
  });
});

describe("callers buttons in the rendered chart", () => {
  it("a side expansion's header and a nested frame's header carry a .zm-callers-btn with its aria-label", () => {
    const side = renderToStaticMarkup(
      <svg>
        <ExpansionShape
          id="p"
          scope=""
          expansion={{ fnId: "A", anchor: { kind: "box", nodeId: "n", rect: box }, chart: chart("A", 300, 200), x: 0, y: 0, w: 340, h: 200, index: 0, pivot: 0 }}
          k={1}
          onNodeClick={() => true}
          onNodeOpen={() => true}
          onSelect={() => {}}
          onClose={() => {}}
          onCallers={() => {}}
        />
      </svg>,
    );
    expect(side).toContain("zm-callers-btn");
    expect(side).toContain('aria-label="Show callers of A"');
    expect(side).toContain('tabindex="0"');

    const leaf = layoutFunction({ id: "f#leaf", name: "leaf", async: false, items: [{ t: "step", role: "call", label: "a()" }] });
    const root = layoutFunction({ id: "f#root", name: "root", async: false, items: [{ t: "step", role: "call", label: "leaf()", target: "f#leaf" }] });
    const nodeId = root.nodes.find((n) => n.label === "leaf()")!.id;
    const nested = relayout(root, new Map([[nodeId, { flow: leaf }]]));
    const html = renderToStaticMarkup(<FlowChart id="p" fn={nested} scope="" onCallers={() => {}} />);
    expect(html).toContain("zm-callers-btn");
    expect(html).toContain('aria-label="Show callers of leaf"');
    expect(html).not.toContain("zm-callers-btn is-open");
    expect(HEADER_STEP).toBe("@header");
  });
});
