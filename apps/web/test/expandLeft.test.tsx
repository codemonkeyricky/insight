import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CHART_PAD, type FunctionFlow, type Rect } from "@insight/flow";
import { CALLERS_BTN_W, CALLERS_COMPACT_W, CallersButton } from "../src/components/zoom/CallersControl";
import {
  CALLERS_W,
  EXPAND_GAP,
  SLOT_PAD,
  SLOT_TOP,
  calloutOf,
  callerRowRect,
  callersKey,
  footprintOf,
  headerAnchor,
  openCallers,
  openExpansion,
  reflow,
  sameFootprint,
  shiftAt,
  shiftOf,
  type Expansion,
} from "../src/zoom/expand.js";

const chart = (id: string, width: number, height: number) => ({ id, name: id, width, height, nodes: [], edges: [] }) as unknown as FunctionFlow;
const view: Rect = { x: 0, y: 0, w: 2000, h: 800 };
const box: Rect = { x: 900, y: 50, w: 230, h: 44 };
const boxAnchor = { kind: "box" as const, nodeId: "n", rect: box };
const find = (list: readonly Expansion[], fnId: string): Expansion => {
  const e = list.find((x) => x.fnId === fnId);
  if (e === undefined) throw new Error(`no expansion ${fnId}`);
  return e;
};
const overlaps = (a: Expansion, b: Expansion) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

describe("left-side expansions", () => {
  it("a callers box on a box anchor sits left of the box, top level with it, and a callee chart stays right", () => {
    const withCallers = openCallers([], "A", boxAnchor, "A", 3, undefined);
    const c = find(withCallers, callersKey("A"));
    expect(c.side).toBe("left");
    expect(c.x).toBe(box.x - c.w - EXPAND_GAP);
    expect(c.y).toBe(box.y + SLOT_TOP);
    const both = openExpansion(withCallers, "B", boxAnchor, chart("B", 300, 200), undefined);
    const b = find(both, "B");
    expect(b.side).toBeUndefined();
    expect(b.x).toBe(box.x + box.w + EXPAND_GAP);
    expect(overlaps(find(both, callersKey("A")), b)).toBe(false);
  });

  it("a callers box from an in-place chart's header hangs at the header's left edge", () => {
    const inPlace = { kind: "box" as const, nodeId: "n", rect: box, inPlace: true };
    const parent = openExpansion([], "A", inPlace, chart("A", 300, 200), undefined);
    const p = find(parent, "A");
    const list = openCallers(parent, "A", headerAnchor(p), "A", 2, undefined);
    const c = find(list, callersKey("A"));
    expect(c.anchor).toMatchObject({ kind: "step", stepId: "@header", rect: { x: -CHART_PAD, w: 0 } });
    expect(c.x + c.w + EXPAND_GAP).toBe(p.x);
    expect(c.y).toBe(p.y);
  });

  it("a caller's chart opened from a row, and what it opens, keep going left without overlap", () => {
    const callers = openCallers([], "A", boxAnchor, "A", 3, undefined);
    const row = { kind: "step" as const, fnId: callersKey("A"), stepId: "b", rect: callerRowRect(1) };
    const withCaller = openExpansion(callers, "B", row, chart("B", 240, 120), undefined);
    const bAnchor = { kind: "step" as const, fnId: "B", stepId: "n1", rect: { x: 10, y: 20, w: 80, h: 20 } };
    const all = openExpansion(withCaller, "C", bAnchor, chart("C", 200, 100), undefined);
    const c = find(all, callersKey("A"));
    const b = find(all, "B");
    const cc = find(all, "C");
    expect(b.side).toBe("left");
    expect(cc.side).toBe("left");
    expect(b.x + b.w + EXPAND_GAP).toBe(c.x);
    expect(cc.x + cc.w + EXPAND_GAP).toBe(b.x);
    for (const x of all) for (const y of all) if (x !== y) expect(overlaps(x, y)).toBe(false);
    expect(Math.max(...all.map((e) => e.x + e.w))).toBeLessThan(box.x);
  });

  it("derives the side again on a reflow, so a stale side cannot stick", () => {
    const list = openExpansion([], "A", boxAnchor, chart("A", 300, 200), view);
    const stale = reflow(list.map((e) => ({ ...e, side: "left" as const })), view);
    expect(find(stale, "A").side).toBeUndefined();
  });

  it("an unslotted left box pivots at its card: the card and everything right of it slide right", () => {
    const list = openCallers([], "A", boxAnchor, "A", 3, view);
    const c = find(list, callersKey("A"));
    expect(c.side).toBe("left");
    expect(c.x).toBe(box.x);
    expect(c.pivot).toBeLessThan(box.x);
    expect(shiftAt(list, box.x)).toBe(c.w + EXPAND_GAP);
    expect(shiftAt(list, 1500)).toBe(c.w + EXPAND_GAP);
    expect(shiftAt(list, 100)).toBe(0);
    expect(shiftAt(list, box.x - 1)).toBe(0);
    // The box takes the vacated space: its right edge meets the shifted card across the gap.
    expect(c.x + c.w + EXPAND_GAP).toBe(box.x + shiftAt(list, box.x));
    const g = calloutOf(c, list)!;
    expect(g.ax + shiftAt(list, box.x)).toBe(box.x + c.w + EXPAND_GAP);
    expect(shiftOf({ x: 1500 }, 1000, 300)).toBe(300 + EXPAND_GAP);
  });

  it("what hangs from an unslotted left box shares its pivot: the card slides by the whole chain's room", () => {
    const callers = openCallers([], "A", boxAnchor, "A", 3, view);
    const row = { kind: "step" as const, fnId: callersKey("A"), stepId: "b", rect: callerRowRect(1) };
    const all = openExpansion(callers, "B", row, chart("B", 240, 120), view);
    const c = find(all, callersKey("A"));
    const b = find(all, "B");
    expect(b.side).toBe("left");
    expect(b.pivot).toBe(c.pivot);
    expect(shiftAt(all, box.x)).toBe(c.w + b.w + 2 * EXPAND_GAP);
    expect(shiftAt(all, 100)).toBe(0);
  });

  it("a slotted map (no view) shifts nothing, left or right", () => {
    const both = openExpansion(openCallers([], "A", boxAnchor, "A", 3, undefined), "B", boxAnchor, chart("B", 300, 200), undefined);
    for (const x of [-5000, 0, 1000, 5000]) expect(shiftAt(both, x)).toBe(0);
  });

  it("the callout runs from the anchor's left edge to the box's right edge", () => {
    const list = openCallers([], "A", boxAnchor, "A", 3, undefined);
    const c = find(list, callersKey("A"));
    const g = calloutOf(c, list);
    expect(g).toMatchObject({ side: "left", ax: box.x, ex: c.x + c.w });
    expect(g!.ex).toBeLessThan(g!.ax);
    const inPlace = { kind: "box" as const, nodeId: "n", rect: box, inPlace: true };
    const parent = openExpansion([], "P", inPlace, chart("P", 300, 200), undefined);
    const hung = openCallers(parent, "P", headerAnchor(find(parent, "P")), "P", 2, undefined);
    const hc = find(hung, callersKey("P"));
    expect(calloutOf(hc, hung)!.ax).toBe(find(hung, "P").x);
    const right = openExpansion([], "B", boxAnchor, chart("B", 300, 200), view);
    expect(calloutOf(find(right, "B"), right)).toMatchObject({ ax: box.x + box.w, ex: find(right, "B").x });
    expect(calloutOf(find(right, "B"), right)!.side).toBeUndefined();
  });
});

describe("footprints with a left side", () => {
  it("a root with a callers box and a callee chart keeps room on both sides", () => {
    const list = openExpansion(openCallers([], "A", boxAnchor, "A", 3, view), "B", boxAnchor, chart("B", 300, 200), view);
    const callers = find(list, callersKey("A"));
    const b = find(list, "B");
    const room = footprintOf(list).get("n")!;
    expect(room.left).toBe(callers.w + EXPAND_GAP + SLOT_PAD);
    expect(room.w).toBe(EXPAND_GAP + b.w + SLOT_PAD);
    expect(room.h).toBe(Math.max(SLOT_TOP + callers.h, SLOT_TOP + b.h) + SLOT_PAD);
  });

  it("a root with only callee charts has no left room (and matches the old width)", () => {
    const list = openExpansion([], "B", boxAnchor, chart("B", 300, 200), view);
    const room = footprintOf(list).get("n")!;
    expect(room.left).toBe(0);
    expect(room.w).toBe(EXPAND_GAP + find(list, "B").w + SLOT_PAD);
  });

  it("an in-place chart with a callers box on its header needs room left of the card", () => {
    const inPlace = { kind: "box" as const, nodeId: "n", rect: box, inPlace: true };
    const chartOpen = openExpansion([], "A", inPlace, chart("A", 400, 200), view);
    const a = find(chartOpen, "A");
    const list = openCallers(chartOpen, "A", headerAnchor(a), "A", 2, view);
    const room = footprintOf(list).get("n")!;
    expect(room.left).toBe(CALLERS_W + EXPAND_GAP + SLOT_PAD);
    expect(room.w).toBe(a.w - box.w + SLOT_PAD);
  });

  it("sameFootprint compares the left room", () => {
    const a = new Map([["n", { left: 10, w: 5, h: 5 }]]);
    expect(sameFootprint(a, new Map([["n", { left: 10, w: 5, h: 5 }]]))).toBe(true);
    expect(sameFootprint(a, new Map([["n", { left: 20, w: 5, h: 5 }]]))).toBe(false);
    expect(sameFootprint(new Map([["n", { w: 5, h: 5 }]]), new Map([["n", { left: 0, w: 5, h: 5 }]]))).toBe(true);
  });
});

describe("CallersButton anchoring", () => {
  const rectX = (html: string) => Number(/<rect x="([\d.]+)"/.exec(html)![1]);
  it("keeps its left edge at x for the full and the compact button", () => {
    const full = renderToStaticMarkup(<svg><CallersButton x={40} y={0} name="f" open={false} onClick={() => undefined} k={1} /></svg>);
    const compact = renderToStaticMarkup(<svg><CallersButton x={40} y={0} name="f" open={false} onClick={() => undefined} k={1} compact /></svg>);
    expect(rectX(full)).toBe(40);
    expect(rectX(compact)).toBe(40);
    expect(full).toContain(`width="${CALLERS_BTN_W}"`);
    expect(compact).toContain(`width="${CALLERS_COMPACT_W}"`);
  });
});

describe("callers boxes inside a right-side chart open right", () => {
  const stepA = { kind: "step" as const, fnId: "A", stepId: "s1", rect: { x: 10, y: 20, w: 80, h: 20 } };

  it("unslotted: card -> right chart -> callers from its header, a step and a nested frame opens right, attached", () => {
    const base = openExpansion([], "A", boxAnchor, chart("A", 300, 200), view);
    const a = find(base, "A");
    const header = { kind: "step" as const, fnId: "A", stepId: "@header", rect: { x: a.w - CHART_PAD, y: 0, w: 0, h: 20 } };
    for (const anchor of [header, stepA]) {
      const list = openCallers(base, "Z", anchor, "Z", 2, view);
      const c = find(list, callersKey("Z"));
      expect(c.side).toBeUndefined();
      expect(c.x).toBe(a.x + a.w + EXPAND_GAP);
      expect(c.pivot).toBe(a.pivot);
      expect(overlaps(a, c)).toBe(false);
      const g = calloutOf(c, list)!;
      expect(g.side).toBeUndefined();
      expect(g.ex).toBe(c.x);
      expect(g.ax).toBeLessThanOrEqual(a.x + a.w);
      expect(g.ax).toBeGreaterThanOrEqual(a.x);
      // Shifts are consistent: the chart's group and the box's group share a pivot, so they move together.
      expect(shiftAt(list, c.x)).toBe(shiftAt(list, a.x + a.w + 1));
      expect(shiftAt(list, box.x)).toBe(0);
    }
    // A caller's chart chained from that right-side box stays right.
    const withCallers = openCallers(base, "Z", stepA, "Z", 2, view);
    const row = { kind: "step" as const, fnId: callersKey("Z"), stepId: "r", rect: callerRowRect(0) };
    const caller = find(openExpansion(withCallers, "Y", row, chart("Y", 200, 100), view), "Y");
    expect(caller.side).toBeUndefined();
    expect(caller.x).toBeGreaterThan(find(withCallers, callersKey("Z")).x);
  });

  it("slotted: a callers box from a chart chained right of an in-place chart does not land on it", () => {
    const inPlace = { kind: "box" as const, nodeId: "n", rect: box, inPlace: true };
    const withC = openExpansion([], "C", inPlace, chart("C", 300, 200), undefined);
    const anchorC = { kind: "step" as const, fnId: "C", stepId: "s1", rect: { x: 10, y: 20, w: 80, h: 20 } };
    const withD = openExpansion(withC, "D", anchorC, chart("D", 250, 150), undefined);
    const list = openCallers(withD, "D", { kind: "step", fnId: "D", stepId: "@header", rect: { x: 250, y: 0, w: 0, h: 20 } }, "D", 2, undefined);
    const c = find(list, callersKey("D"));
    const d = find(list, "D");
    expect(c.side).toBeUndefined();
    expect(c.x).toBe(d.x + d.w + EXPAND_GAP);
    for (const x of list) for (const y of list) if (x !== y) expect(overlaps(x, y)).toBe(false);
    // Footprint: only right room grows, no left room.
    expect(footprintOf(list).get("n")!.left).toBe(0);
    // A callers box from the in-place chart's own header still opens left.
    const root = find(openCallers(withC, "C", headerAnchor(find(withC, "C")), "C", 2, undefined), callersKey("C"));
    expect(root.side).toBe("left");
  });
});

/** Where an item is drawn: its placed x plus the shift of its group (writeShift shifts a group by shiftAt at its pivot). */
const drawn = (list: readonly Expansion[], e: Expansion): Rect => ({ x: e.x + shiftAt(list, e.pivot), y: e.y, w: e.w, h: e.h });
const cardDrawn = (list: readonly Expansion[], r: Rect = box): Rect => ({ ...r, x: r.x + shiftAt(list, r.x) });
const hit = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const row = (i: number) => ({ kind: "step" as const, fnId: callersKey("A"), stepId: `r${i}`, rect: callerRowRect(i) });

describe("unslotted left chains, by their drawn x", () => {
  const noOverlap = (rects: Rect[]) => {
    for (const a of rects) for (const b of rects) if (a !== b) expect(hit(a, b)).toBe(false);
  };

  it("card + callers box + a caller's chart: adjacent, in order, no overlap", () => {
    const callers = openCallers([], "A", boxAnchor, "A", 3, view);
    const list = openExpansion(callers, "B", row(1), chart("B", 264, 120), view);
    const c = find(list, callersKey("A"));
    const b = find(list, "B");
    const R = c.w + b.w + 2 * EXPAND_GAP;
    const card = cardDrawn(list);
    const dc = drawn(list, c);
    const db = drawn(list, b);
    expect(card.x).toBe(box.x + R);
    expect(dc.x + dc.w + EXPAND_GAP).toBe(card.x);
    expect(db.x + db.w + EXPAND_GAP).toBe(dc.x);
    expect(db.x).toBe(box.x);
    noOverlap([card, dc, db]);
    // Callouts connect the drawn edges.
    const g = calloutOf(c, list)!;
    expect(g.ax + shiftAt(list, box.x)).toBe(card.x);
    expect(g.ex + shiftAt(list, c.pivot)).toBe(dc.x + dc.w);
    const gb = calloutOf(b, list)!;
    expect(gb.ex + shiftAt(list, b.pivot)).toBe(db.x + db.w);
    expect(gb.ax + shiftAt(list, c.pivot)).toBeGreaterThan(db.x + db.w);
  });

  it("a three-deep chain fills the room from the card's original x", () => {
    const callers = openCallers([], "A", boxAnchor, "A", 3, view);
    const b = openExpansion(callers, "B", row(0), chart("B", 240, 120), view);
    const bStep = { kind: "step" as const, fnId: "B", stepId: "n1", rect: { x: 10, y: 20, w: 80, h: 20 } };
    const list = openExpansion(b, "C", bStep, chart("C", 200, 100), view);
    const [c, bb, cc] = [find(list, callersKey("A")), find(list, "B"), find(list, "C")];
    expect([bb.side, cc.side]).toEqual(["left", "left"]);
    const R = c.w + bb.w + cc.w + 3 * EXPAND_GAP;
    const card = cardDrawn(list);
    expect(card.x).toBe(box.x + R);
    const d = [c, bb, cc].map((e) => drawn(list, e));
    expect(d[0]!.x + d[0]!.w + EXPAND_GAP).toBe(card.x);
    expect(d[1]!.x + d[1]!.w + EXPAND_GAP).toBe(d[0]!.x);
    expect(d[2]!.x + d[2]!.w + EXPAND_GAP).toBe(d[1]!.x);
    expect(d[2]!.x).toBe(box.x);
    noOverlap([card, ...d]);
  });

  it("a second card left of the anchor card is not covered, and one right of it slides clear", () => {
    const left: Rect = { x: 560, y: 50, w: 230, h: 44 };
    const right: Rect = { x: 1200, y: 50, w: 230, h: 44 };
    const callers = openCallers([], "A", boxAnchor, "A", 3, view);
    const list = openExpansion(callers, "B", row(1), chart("B", 264, 120), view);
    const items = [find(list, callersKey("A")), find(list, "B")].map((e) => drawn(list, e));
    const card = cardDrawn(list);
    expect(cardDrawn(list, left)).toEqual(left);
    noOverlap([cardDrawn(list, left), ...items, card, cardDrawn(list, right)]);
    expect(items.every((r) => r.x >= left.x + left.w)).toBe(true);
  });
});
