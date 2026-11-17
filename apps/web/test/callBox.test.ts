import { describe, expect, it } from "vitest";
import { layoutFunction, type FunctionFlow, type FlowNode, type Rect } from "@insight/flow";
import { EXPAND_GAP, calleeAt, calloutOf, closeExpansion, contentOrigin, openExpansion, openStepsOf, type Expansion, type ExpandAnchor } from "../src/zoom/expand.js";
import { stepAction, type StepContext } from "../src/zoom/stepAction.js";

// A call row opens its callee as a separate box to the right of the box that holds the row (ZoomMap openStep, which
// places it through openExpansion with a step anchor). These tests cover that placement and its closing rules.

const call = (label: string, target?: string) => ({ t: "step" as const, role: "call" as const, label, ...(target ? { target } : {}) });
const make = (id: string, items: ReturnType<typeof call>[]): FunctionFlow => layoutFunction({ id, name: id, async: false, items });
const view: Rect = { x: 0, y: 0, w: 4000, h: 4000 };
const box: Rect = { x: 100, y: 50, w: 230, h: 44 };
const rowOf = (chart: FunctionFlow, label: string): FlowNode => chart.nodes.find((n) => n.label === label) as FlowNode;
const stepOf = (fnId: string, n: FlowNode): ExpandAnchor => ({ kind: "step", fnId, stepId: n.id, rect: { x: n.x, y: n.y, w: n.w, h: n.h } });
const overlaps = (a: Expansion, b: Expansion) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

const leaf = make("f#leaf", [call("a()", "f#other")]);
const mid = make("f#mid", [call("leaf()", "f#leaf"), call("x()")]);
const root = make("f#root", [call("mid()", "f#mid"), call("tail()")]);
const other = make("f#other", [call("o()")]);
const sib = make("f#root2", [call("mid()", "f#mid"), call("other()", "f#other")]);

const ctx: StepContext = { hasCallee: true, isLambda: false, runtime: "same" };

describe("a same-thread call opens a box", () => {
  it("stepAction returns the separate-box kind for a same-thread call", () => {
    expect(stepAction({ shape: "step" }, "open", ctx)).toBe("box");
  });
});

describe("opening a callee beside its row", () => {
  const open1 = () => openExpansion([], "f#root", { kind: "box", nodeId: "b", rect: box }, root, view);

  it("places the box at parent.x + parent.w + gap, top aligned with the row, with a callout to the row", () => {
    const list = open1();
    const parent = list[0] as Expansion;
    const row = rowOf(root, "mid()");
    const next = openExpansion(list, "f#mid", stepOf("f#root", row), mid, view);
    const child = next.find((e) => e.fnId === "f#mid") as Expansion;
    expect(child.x).toBe(parent.x + parent.w + EXPAND_GAP);
    expect(child.y).toBe(contentOrigin(parent).y + row.y);
    const callout = calloutOf(child, next);
    expect(callout).toBeDefined();
    expect(callout!.ax).toBe(contentOrigin(parent).x + row.x + row.w);
    expect(callout!.ex).toBe(child.x);
  });

  it("a second-level open goes further right, and so on at any depth", () => {
    const one = openExpansion(open1(), "f#mid", stepOf("f#root", rowOf(root, "mid()")), mid, view);
    const two = openExpansion(one, "f#leaf", stepOf("f#mid", rowOf(mid, "leaf()")), leaf, view);
    const [a, b, c] = ["f#root", "f#mid", "f#leaf"].map((id) => two.find((e) => e.fnId === id) as Expansion);
    expect(b.x).toBe(a.x + a.w + EXPAND_GAP);
    expect(c.x).toBe(b.x + b.w + EXPAND_GAP);
    expect(c.x).toBeGreaterThan(b.x);
    const deep = openExpansion(two, "f#other", stepOf("f#leaf", rowOf(leaf, "a()")), other, view);
    expect(deep.find((e) => e.fnId === "f#other")!.x).toBeGreaterThan(c.x);
  });
});

describe("closing a box", () => {
  const chain = () => {
    const one = openExpansion([], "f#root", { kind: "box", nodeId: "b", rect: box }, root, view);
    const two = openExpansion(one, "f#mid", stepOf("f#root", rowOf(root, "mid()")), mid, view);
    return openExpansion(two, "f#leaf", stepOf("f#mid", rowOf(mid, "leaf()")), leaf, view);
  };

  it("re-toggling the row finds its open box, and closing it closes every box opened from it", () => {
    const list = chain();
    const open = calleeAt(list, "f#root", rowOf(root, "mid()").id);
    expect(open?.fnId).toBe("f#mid");
    expect(closeExpansion(list, open!.fnId).map((e) => e.fnId)).toEqual(["f#root"]);
  });

  it("closing a middle box closes the boxes chained from it, and keeps the ones before it", () => {
    const list = chain();
    const mid2 = list.find((e) => e.fnId === "f#mid")!;
    expect(closeExpansion(list, mid2.fnId).map((e) => e.fnId)).toEqual(["f#root"]);
  });

  it("a row with no open box finds none", () => {
    expect(calleeAt(chain(), "f#root", rowOf(root, "tail()").id)).toBeUndefined();
  });
});

describe("two rows of one box", () => {
  it("never leave two boxes overlapping: the second row's box takes the place of the first", () => {
    const one = openExpansion([], "f#root2", { kind: "box", nodeId: "b", rect: box }, sib, view);
    const first = openExpansion(one, "f#mid", stepOf("f#root2", rowOf(sib, "mid()")), mid, view);
    const both = openExpansion(first, "f#other", stepOf("f#root2", rowOf(sib, "other()")), other, view);
    const ids = both.map((e) => e.fnId).sort();
    expect(ids).toEqual(["f#other", "f#root2"]);
    for (let i = 0; i < both.length; i++) for (let j = i + 1; j < both.length; j++) expect(overlaps(both[i]!, both[j]!)).toBe(false);
    expect(calleeAt(both, "f#root2", rowOf(sib, "mid()").id)).toBeUndefined();
    expect(calleeAt(both, "f#root2", rowOf(sib, "other()").id)).toBeDefined();
  });
});

describe("openStepsOf", () => {
  it("maps each chart to the ids of its steps with a box open from them, and skips callers boxes", () => {
    const list = openExpansion([], "f#root", { kind: "box", nodeId: "b", rect: box }, root, view);
    const row = rowOf(root, "mid()");
    const withMid = openExpansion(list, "f#mid", stepOf("f#root", row), mid, view);
    const steps = openStepsOf(withMid);
    expect([...(steps.get("f#root") ?? [])]).toEqual([row.id]);
    expect(steps.has("f#mid")).toBe(false);
    expect(openStepsOf([]).size).toBe(0);
  });
});
