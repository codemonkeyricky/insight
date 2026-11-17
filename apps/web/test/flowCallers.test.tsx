import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CHART_PAD, layoutFunction, type FunctionFlow, type Rect } from "@insight/flow";
import type { RefRow } from "@insight/model";
import { ExpansionShape } from "../src/components/zoom/Expansion";
import { BoxShape } from "../src/components/zoom/ZoomMap";
import { callersKey as keyOf, isCallersKey, kindBadge, mergeCallers, refOfCallersKey, valueRefCount } from "../src/zoom/callers";
import { LatestLoad } from "../src/zoom/latestLoad";
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
  hangsFromCallers,
  syncCallerRows,
  loadFunctionChart,
  openCallers,
  refusedCallersPlan,
  openExpansion,
  reflow,
  shiftAt,
  setInline,
  stillOpen,
  resizeCallers,
  toggleCallers,
  type Expansion,
} from "../src/zoom/expand.js";

const chart = (id: string, width: number, height: number) => ({ id, name: id, width, height, nodes: [], edges: [] }) as unknown as FunctionFlow;
const view: Rect = { x: 0, y: 0, w: 1000, h: 800 };
const box: Rect = { x: 100, y: 50, w: 230, h: 44 };
const inPlaceAnchor = { kind: "box" as const, nodeId: "n", rect: { x: 400, y: 100, w: 230, h: 44 }, inPlace: true };
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

  it("a new, JSX or handler reference is a caller, badged new, renders or handler", () => {
    const rows = [
      row({ id: "f#n", kind: "reference", how: "new" }),
      row({ id: "f#j", kind: "reference", how: "jsx" }),
      row({ id: "f#h", kind: "reference", how: "handler" }),
    ];
    const merged = mergeCallers(rows, true);
    expect(merged.map((r) => [r.id, r.kinds])).toEqual([
      ["f#n", ["new"]],
      ["f#j", ["renders"]],
      ["f#h", ["handler"]],
    ]);
  });

  it("keeps the badges of the other kinds as they were: a plain call has none, a message dispatch is message", () => {
    expect(kindBadge({ kind: "call", how: undefined })).toBeUndefined();
    expect(kindBadge({ kind: "dispatch", how: "message" })).toBe("message");
    expect(kindBadge({ kind: "spawn", how: undefined })).toBe("spawn");
    expect(kindBadge({ kind: "reference", how: "new" })).toBe("new");
    expect(kindBadge({ kind: "reference", how: "jsx" })).toBe("renders");
    expect(kindBadge({ kind: "reference", how: "handler" })).toBe("handler");
  });

  it("a caller with both a call and a new row is one row, badged new (the call adds no badge)", () => {
    const rows = [row({ id: "f#c", kind: "call" }), row({ id: "f#c", kind: "reference", how: "new" })];
    const merged = mergeCallers(rows, true);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ id: "f#c", kinds: ["new"] });
  });

  it("drops a value reference from the rows but counts its distinct places in valueRefCount", () => {
    const rows = [
      row({ id: "f#v", kind: "reference", how: "value" }),
      row({ id: "f#v", kind: "reference", how: "closure" }),
      row({ id: "f#w", kind: "reference" }),
      row({ id: "f#n", kind: "reference", how: "new" }),
    ];
    expect(mergeCallers(rows, true).map((r) => r.id)).toEqual(["f#n"]);
    expect(valueRefCount(rows, true)).toBe(2);
    expect(valueRefCount([row({ id: "f#n", kind: "reference", how: "new" })], true)).toBe(0);
    expect(valueRefCount([], true)).toBe(0);
  });

  it("a row that both renders and passes the function keeps its caller and the renders badge, whichever order the rows came in", () => {
    // refsOf merges one caller's references into one row whose how is the invoking one (jsx), in either relation order.
    const rows = [row({ id: "f#k", kind: "reference", how: "jsx", count: 2 })];
    const merged = mergeCallers(rows, true);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ id: "f#k", kinds: ["renders"] });
    expect(valueRefCount(rows, true)).toBe(0);
    // Unmerged rows in both orders still resolve to one caller row with the badge, and the value row does not count.
    for (const order of [["value", "jsx"], ["jsx", "value"]] as const) {
      const two = order.map((how) => row({ id: "f#k", kind: "reference", how }));
      expect(mergeCallers(two, true)).toMatchObject([{ id: "f#k", kinds: ["renders"] }]);
      expect(valueRefCount(two, true)).toBe(0);
    }
  });

  it("applies the lambda filter to value references as it does to callers", () => {
    const rows = [row({ id: "f#λ", kind: "reference", how: "value", name: "λ cb" }), row({ id: "f#p", kind: "reference", how: "value" })];
    expect(valueRefCount(rows, false)).toBe(1);
    expect(valueRefCount(rows, true)).toBe(2);
    const handlers = [row({ id: "f#λh", kind: "reference", how: "handler", name: "λ onClick" })];
    expect(mergeCallers(handlers, false)).toEqual([]);
    expect(mergeCallers(handlers, true).map((r) => r.id)).toEqual(["f#λh"]);
  });
});

describe("callers box placement", () => {
  it("opens to the left of a function box and reflow keeps it there", () => {
    const list = openCallers([], "A", boxAnchor, "A", 3, undefined);
    const c = find(list, callersKey("A"));
    expect(c.kind).toBe("callers");
    expect(c.x + c.w).toBe(box.x - EXPAND_GAP);
    expect(c.side).toBe("left");
    expect(c.w).toBe(CALLERS_W);
    expect(reflow(list, undefined).find((e) => e.fnId === callersKey("A"))?.x).toBe(c.x);
  });

  it("hangs a callers box from a chart's header to the chart's left", () => {
    const parent = openExpansion([], "A", inPlaceAnchor, chart("A", 300, 200), undefined);
    const p = find(parent, "A");
    const list = openCallers(parent, "A", headerAnchor(p), "A", 2, undefined);
    const c = find(list, callersKey("A"));
    expect(c.x).toBe(p.x - c.w - EXPAND_GAP);
    expect(c.y).toBe(p.y);
  });

  it("follows a resized parent: the callers box keeps its place left of the parent, and the anchor stays at the header's left edge", () => {
    const parent = openExpansion([], "A", inPlaceAnchor, chart("A", 300, 200), undefined);
    const list = openCallers(parent, "A", headerAnchor(find(parent, "A")), "A", 2, undefined);
    const p = find(list, "A");
    const grown = reflow(list.map((e) => (e.fnId === "A" ? { ...e, w: p.w + 200 } : e)), view);
    const c = find(grown, callersKey("A"));
    // Unslotted: the box takes the room from the chart's original x, and the chart slides right past it.
    const pg = find(grown, "A");
    expect(c.x + shiftAt(grown, c.pivot) + c.w + EXPAND_GAP).toBe(pg.x + shiftAt(grown, pg.pivot));
    expect(c.anchor).toMatchObject({ kind: "step", stepId: HEADER_STEP, rect: { x: -CHART_PAD } });
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
    expect(find(two, callersKey("Y")).side).toBeUndefined();
    expect(find(two, callersKey("Y")).x).toBe(p.x + p.w + EXPAND_GAP);
  });
});

describe("a card's chart over its callers box", () => {
  it("opening the card's chart re-anchors its callers box on the chart's header, and the chart opened from a row survives", () => {
    const card = openCallers([], "A", boxAnchor, "A", 3, undefined);
    const withChart = openExpansion(card, "A", inPlaceAnchor, chart("A", 300, 200), undefined);
    const hung = hangCallersFrom(withChart, "A", "n", undefined);
    const withRow = openExpansion(hung, "B", { kind: "step", fnId: callersKey("A"), stepId: "b", rect: callerRowRect(0) }, chart("B", 200, 100), undefined);
    const head = find(withRow, "A");
    const c = find(withRow, callersKey("A"));
    expect(c.anchor).toMatchObject({ kind: "step", fnId: "A", stepId: HEADER_STEP });
    expect(c.x).toBe(head.x - c.w - EXPAND_GAP);
    expect(withRow.map((e) => e.fnId)).toEqual(expect.arrayContaining(["A", callersKey("A"), "B"]));
    expect(find(withRow, "B").side).toBe("left");
    expect(find(withRow, "B").x + find(withRow, "B").w + EXPAND_GAP).toBeLessThanOrEqual(c.x);
  });
});

describe("callers box anchors", () => {
  it("a box open at one anchor is not open at another: the header's button is not shown open for the card's box", () => {
    const card = toggleCallers([], "A", boxAnchor, "A", view);
    const chartOpen = openExpansion(card, "A", inPlaceAnchor, chart("A", 300, 200), view);
    const hung = hangCallersFrom(chartOpen, "A", "n", view);
    expect(callersAt(hung, "A", headerAnchor(find(hung, "A")))).toBe(true);
    expect(callersAt(hung, "A", boxAnchor)).toBe(false);
  });

  it("clicking a button whose function has a callers box elsewhere moves the box there, and does not close it", () => {
    const parent = openExpansion([], "A", inPlaceAnchor, chart("A", 300, 200), view);
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
    const parent = openExpansion([], "A", inPlaceAnchor, chart("A", 300, 200), view);
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
  it("a side expansion's header carries a .zm-callers-btn with its aria-label", () => {
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
    expect(HEADER_STEP).toBe("@header");
  });
});

describe("a call step opens its callee at a sibling step (N1)", () => {
  const at = (fnId: string, stepId: string) => ({ kind: "step" as const, fnId, stepId, rect: { x: 0, y: 40, w: 10, h: 10 } });

  it("A's s1 opens B, B's step opens C, then A's s2 (also calling C) moves C to s2 and closes B's chain", () => {
    const a = openExpansion([], "A", inPlaceAnchor, chart("A", 300, 200), view);
    const b = openExpansion(a, "B", at("A", "s1"), chart("B", 200, 100), view);
    const c = openExpansion(b, "C", at("B", "bs"), chart("C", 100, 100), view);
    expect(c.map((e) => e.fnId).sort()).toEqual(["A", "B", "C"]);
    const next = openExpansion(c, "C", at("A", "s2"), chart("C", 100, 100), view);
    expect(next).not.toBe(c);
    expect(next.map((e) => e.fnId).sort()).toEqual(["A", "C"]);
    expect(find(next, "C").anchor).toMatchObject({ kind: "step", fnId: "A", stepId: "s2" });
    expect(overlaps(find(next, "A"), find(next, "C"))).toBe(false);
  });

  it("moving an open callee to another step keeps its own chain attached to it", () => {
    const a = openExpansion([], "A", inPlaceAnchor, chart("A", 300, 200), view);
    const b = openExpansion(a, "B", at("A", "s1"), chart("B", 200, 100), view);
    const withC = openExpansion(b, "C", at("B", "bs"), chart("C", 100, 100), view);
    const next = openExpansion(withC, "B", at("A", "s3"), chart("B", 200, 100), view);
    expect(next.map((e) => e.fnId).sort()).toEqual(["A", "B", "C"]);
    expect(find(next, "B").anchor).toMatchObject({ stepId: "s3" });
    expect(find(next, "C").anchor).toMatchObject({ kind: "step", fnId: "B", stepId: "bs" });
  });

  it("a genuine cycle is still refused: the anchor lies inside the callee's own chain", () => {
    const a = openExpansion([], "A", inPlaceAnchor, chart("A", 300, 200), view);
    const b = openExpansion(a, "B", at("A", "s1"), chart("B", 200, 100), view);
    expect(openExpansion(b, "A", at("B", "bs"), chart("A", 300, 200), view)).toBe(b);
  });
});

describe("hanging a card's callers box (N3)", () => {
  it("moves only a box hung from this card; a box hung elsewhere is left alone", () => {
    const elsewhere: Rect = { x: 500, y: 300, w: 230, h: 44 };
    const a = openExpansion([], "A", inPlaceAnchor, chart("A", 300, 200), view);
    const withBox = openCallers(a, "A", { kind: "box", nodeId: "m", rect: elsewhere }, "A", 3, view);
    expect(hangCallersFrom(withBox, "A", "n", view)).toBe(withBox);
  });

  it("a reattached chart keeps the callees it had open, and the card's callers box closes instead (M2)", () => {
    // A was open in a callee chain elsewhere, with B (and B's C) open to its right, when it reattaches to its card.
    const a = openExpansion([], "A", inPlaceAnchor, chart("A", 300, 200), view);
    const withChild = openExpansion(a, "B", at("A", "s1"), chart("B", 200, 100), view);
    const withGrand = openExpansion(withChild, "C", at("B", "bs"), chart("C", 100, 100), view);
    const withBox = openCallers(withGrand, "A", boxAnchor, "A", 3, view);
    const withRow = openExpansion(withBox, "D", { kind: "step", fnId: callersKey("A"), stepId: "d", rect: callerRowRect(0) }, chart("D", 100, 100), view);
    const hung = hangCallersFrom(withRow, "A", "n", view);
    expect(hung.map((e) => e.fnId).sort()).toEqual(["A", "B", "C"]);
    for (const x of hung) for (const y of hung) if (x !== y) expect(overlaps(x, y)).toBe(false);
  });

  it("a reattached chart with nothing open to its right takes the card's callers box on its header", () => {
    const a = openExpansion([], "A", inPlaceAnchor, chart("A", 300, 200), view);
    const withBox = openCallers(a, "A", boxAnchor, "A", 3, view);
    const hung = hangCallersFrom(withBox, "A", "n", view);
    expect(find(hung, callersKey("A")).anchor).toMatchObject({ kind: "step", fnId: "A", stepId: HEADER_STEP });
    const shown = hung.map((e) => ({ ...e, x: e.x + shiftAt(hung, e.pivot) }));
    for (const x of shown) for (const y of shown) if (x !== y) expect(overlaps(x, y)).toBe(false);
  });

  it("the box hung on the header does not overlap a step child that stays open beside it (M2)", () => {
    const a = openExpansion([], "A", inPlaceAnchor, chart("A", 300, 200), view);
    const withBox = openCallers(a, "A", boxAnchor, "A", 3, view);
    const withChild = openExpansion(withBox, "B", at("A", "s1"), chart("B", 200, 100), view);
    const hung = hangCallersFrom(withChild, "A", "n", view);
    for (const x of hung) for (const y of hung) if (x !== y) expect(overlaps(x, y)).toBe(false);
  });

  const at = (fnId: string, stepId: string) => ({ kind: "step" as const, fnId, stepId, rect: { x: 0, y: 40, w: 10, h: 10 } });
});

describe("a loaded chart opens only while the map still shows its context (N2)", () => {
  const a = openExpansion([], "A", inPlaceAnchor, chart("A", 300, 200), view);
  const started = { context: "p\u0001", path: "src" };

  it("a relayout of the same focus (a new build, same scope) still opens it", () => {
    expect(stillOpen(a, "A", started, { context: "p\u0001", path: "src" })).toBe(true);
  });

  it("a different project, a different scope, or a closed parent opens nothing", () => {
    expect(stillOpen(a, "A", started, { context: "q\u0001", path: "src" })).toBe(false);
    expect(stillOpen(a, "A", started, { context: "p\u0001", path: "lib" })).toBe(false);
    expect(stillOpen(a, "A", started, { context: "p\u0001", path: undefined })).toBe(false);
    expect(stillOpen([], "A", started, { context: "p\u0001", path: "src" })).toBe(false);
  });
});

describe("a refused callers click and off-map loads (M1)", () => {
  it("a refused click reveals the box by its key and selects only its function", () => {
    expect(refusedCallersPlan("A")).toEqual({ box: callersKey("A"), select: "A" });
  });

  it("the function a refused click selects is loaded; a callers key never reaches the store", async () => {
    const chartOf = vi.fn(async () => undefined);
    const store = { chartOf };
    const plan = refusedCallersPlan("A");
    await loadFunctionChart(store, plan.box);
    expect(chartOf).not.toHaveBeenCalled();
    await loadFunctionChart(store, plan.select);
    expect(chartOf).toHaveBeenCalledTimes(1);
    expect(chartOf).toHaveBeenCalledWith("A");
  });
});

describe("callers keys", () => {
  it("one helper names, tests and reads a callers box's key", () => {
    expect(keyOf("f#a")).toBe(callersKey("f#a"));
    expect(isCallersKey(keyOf("f#a"))).toBe(true);
    expect(isCallersKey("f#a")).toBe(false);
    expect(refOfCallersKey(keyOf("f#a"))).toBe("f#a");
    expect(refOfCallersKey("f#a")).toBe("f#a");
  });
});

describe("a caller's chart and the async frame (item 4)", () => {
  it("a chart hung from a callers row, and the callees opened from it, hang from the callers box; the card's own chain does not", () => {
    const a = openExpansion([], "A", inPlaceAnchor, chart("A", 300, 200), view);
    const withCallee = openExpansion(a, "B", { kind: "step", fnId: "A", stepId: "s1", rect: { x: 0, y: 40, w: 10, h: 10 } }, chart("B", 200, 100), view);
    const withBox = openCallers(withCallee, "B", headerAnchor(find(withCallee, "B")), "B", 3, view);
    const withCaller = openExpansion(withBox, "P", { kind: "step", fnId: callersKey("B"), stepId: "P", rect: callerRowRect(0) }, chart("P", 200, 100), view);
    const withDeep = openExpansion(withCaller, "Q", { kind: "step", fnId: "P", stepId: "q", rect: { x: 0, y: 40, w: 10, h: 10 } }, chart("Q", 100, 100), view);
    expect(hangsFromCallers(withDeep, find(withDeep, "P"))).toBe(true);
    expect(hangsFromCallers(withDeep, find(withDeep, "Q"))).toBe(true);
    expect(hangsFromCallers(withDeep, find(withDeep, "B"))).toBe(false);
    expect(hangsFromCallers(withDeep, find(withDeep, "A"))).toBe(false);
  });
});

describe("caller charts follow their rows (item 8)", () => {
  const open = () => {
    const box = openCallers([], "A", boxAnchor, "A", 3, view);
    return openExpansion(box, "P", { kind: "step", fnId: callersKey("A"), stepId: "P", rect: callerRowRect(0) }, chart("P", 200, 100), view);
  };

  it("rows that keep their order move nothing", () => {
    const list = open();
    expect(syncCallerRows(list, "A", ["P", "Q"], view)).toBe(list);
  });

  it("a caller whose row moved takes its chart's anchor to the new row", () => {
    const list = open();
    const moved = syncCallerRows(list, "A", ["Q", "R", "P"], view);
    expect(find(moved, "P").anchor.rect).toEqual(callerRowRect(2));
    expect(find(moved, "P").y).toBeGreaterThan(find(list, "P").y);
  });

  it("a caller whose row is gone, or hidden past the cap, closes its chart", () => {
    const list = open();
    expect(syncCallerRows(list, "A", ["Q"], view).some((e) => e.fnId === "P")).toBe(false);
    const many = Array.from({ length: 13 }, (_, i) => `x${i}`).concat("P");
    expect(syncCallerRows(list, "A", many, view).some((e) => e.fnId === "P")).toBe(false);
  });
});

describe("the latest load per parent (item 5)", () => {
  it("a later click on the same parent supersedes an earlier one; other parents are independent", () => {
    const loads = new LatestLoad();
    const first = loads.start(callersKey("A"));
    const second = loads.start(callersKey("A"));
    const other = loads.start("B");
    expect(loads.isLatest(callersKey("A"), first)).toBe(false);
    expect(loads.isLatest(callersKey("A"), second)).toBe(true);
    expect(loads.isLatest("B", other)).toBe(true);
  });
});

describe("reflow of a header-hung box", () => {
  it("keeps the anchor object when the parent's width did not change", () => {
    const parent = openExpansion([], "A", inPlaceAnchor, chart("A", 300, 200), view);
    const list = openCallers(parent, "A", headerAnchor(find(parent, "A")), "A", 2, view);
    const again = reflow(list, view);
    expect(find(again, callersKey("A")).anchor).toBe(find(list, callersKey("A")).anchor);
  });
});

describe("a callers box on a nested frame", () => {
  it("closes when its frame folds back to a plain step, since its button was the frame's (review 5)", () => {
    const leaf = layoutFunction({ id: "f#leaf", name: "leaf", async: false, items: [{ t: "step", role: "call", label: "a()" }] });
    const root = layoutFunction({ id: "f#root", name: "root", async: false, items: [{ t: "step", role: "call", label: "leaf()", target: "f#leaf" }] });
    const stepId = root.nodes.find((n) => n.label === "leaf()")!.id;
    const opened = openExpansion([], "f#root", boxAnchor, root, view);
    const nested = setInline(opened, "f#root", stepId, leaf, view);
    const frame = find(nested, "f#root").chart.nodes.find((n) => n.id === stepId)!;
    expect(frame.shape).toBe("nest");
    const withBox = openCallers(nested, "f#leaf", { kind: "step", fnId: "f#root", stepId, rect: { x: frame.x, y: frame.y, w: frame.w, h: frame.h } }, "leaf", 3, view);
    expect(withBox.some((e) => e.fnId === callersKey("f#leaf"))).toBe(true);
    const folded = setInline(withBox, "f#root", stepId, undefined, view);
    expect(folded.some((e) => e.fnId === callersKey("f#leaf"))).toBe(false);
    expect(folded.some((e) => e.fnId === "f#root")).toBe(true);
  });

});

describe("the Callers chip on a roots-only card", () => {
  const card = (label: string, k: number, w = 160) =>
    renderToStaticMarkup(
      <svg>
        <BoxShape
          item={{ id: "n", kind: "box", rect: { x: 0, y: 0, w, h: 56 }, depth: 1 }}
          node={{ id: "n", kind: "function", label, ref: "f#x" }}
          line="none"
          k={k}
          onOpen={() => undefined}
          chartOpen={false}
          card
          onCallers={() => undefined}
        />
      </svg>,
    );
  const nameOf = (html: string) => html.match(/zm-card-glyph">ƒ<\/tspan> ([^<]*)<\/text>/)?.[1];

  it("keeps a card's name readable: a name that would not fit beside the full chip gets a compact ◂ chip", () => {
    const html = card("buildExecScene", 1);
    expect(nameOf(html)).toBeDefined();
    expect(nameOf(html)!.length).toBeGreaterThanOrEqual(8);
    expect(html).toMatch(/zm-callers-btn[^]*>◂<\/text>/);
    expect(html).not.toContain("◂ callers");
  });

  it("a wide card whose name fits beside it still takes the compact ◂ chip: cards all use it", () => {
    const html = card("run", 1, 300);
    expect(nameOf(html)).toBe("run");
    expect(html).toMatch(/zm-callers-btn[^]*>◂<\/text>/);
    expect(html).not.toContain("◂ callers");
  });

  it("a card with no chip keeps its whole name: no room is reserved for a button that is not drawn", () => {
    // 14 characters fit in a 160-wide card at 1× with no chip (15 allowed after the glyph). Keeping 24 world units free
    // for an absent chip leaves 12, so this test fails if the no-chip room goes back to 24.
    const label = "loadCallersMap";
    const html = renderToStaticMarkup(
      <svg>
        <BoxShape
          item={{ id: "n", kind: "box", rect: { x: 0, y: 0, w: 160, h: 56 }, depth: 1 }}
          node={{ id: "n", kind: "function", label, ref: "f#x" }}
          line="none"
          k={1}
          onOpen={() => undefined}
          chartOpen={false}
          card
        />
      </svg>,
    );
    expect(html).not.toContain("zm-callers-btn");
    expect(nameOf(html)).toBe(label);
  });
});

describe("a card's name when zoomed in (review 2, finding 4)", () => {
  it("fits the name to the font as it grows with the zoom, so it stays inside the card left of the chip", () => {
    const long = "aVeryLongFunctionNameOfThirtyChars";
    for (const k of [1, 2, 3]) {
      const html = renderToStaticMarkup(
        <svg>
          <BoxShape item={{ id: "n", kind: "box", rect: { x: 0, y: 0, w: 220, h: 56 }, depth: 1 }} node={{ id: "n", kind: "function", label: long, ref: "f#x" }} line="none" k={k} onOpen={() => undefined} chartOpen={false} card onCallers={() => undefined} />
        </svg>,
      );
      const name = html.match(/zm-card-glyph">ƒ<\/tspan> ([^<]*)<\/text>/)?.[1] ?? "";
      // The font is max(13 px, 11 world units) on screen; a character is about 0.6 of it, plus the glyph and its space.
      const charPx = 0.6 * Math.max(13, 11 * k);
      expect((name.length + 2) * charPx + 12 * k).toBeLessThanOrEqual((220 - 26 - 12) * k);
    }
  });
});
