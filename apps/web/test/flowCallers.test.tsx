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
  callerRowRect,
  callersKey,
  closeExpansion,
  headerAnchor,
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
const row = (over: Partial<RefRow> & { id: string; kind: RefRow["kind"] }): RefRow => ({
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
});

describe("callers box placement", () => {
  it("opens to the right of a function box and reflow keeps it there", () => {
    const list = openCallers([], "A", { kind: "box", nodeId: "n", rect: box }, "A", 3, view);
    const c = list.find((e) => e.fnId === callersKey("A"));
    expect(c?.kind).toBe("callers");
    expect(c?.x).toBeGreaterThanOrEqual(box.x + box.w + EXPAND_GAP);
    expect(c?.w).toBe(CALLERS_W);
    const again = reflow(list, view).find((e) => e.fnId === callersKey("A"));
    expect(again?.x).toBe(c?.x);
  });

  it("hangs a callers box from a chart's header to the chart's right, and follows the chart when it is resized", () => {
    const parent = openExpansion([], "A", { kind: "box", nodeId: "n", rect: box }, chart("A", 300, 200), view);
    const p = parent[0] as Expansion;
    const list = openCallers(parent, "A", headerAnchor(p), "A", 2, view);
    const c = list.find((e) => e.fnId === callersKey("A")) as Expansion;
    expect(c.x).toBe(p.x + p.w + EXPAND_GAP);
    expect(c.y).toBe(p.y);
    const grown = resizeCallers(list, "A", 2, view);
    expect(grown).toBe(list);
  });

  it("closing the parent closes the callers box and a caller's chart opened from its row", () => {
    const a = openExpansion([], "A", { kind: "box", nodeId: "n", rect: box }, chart("A", 300, 200), view);
    const withCallers = toggleCallers(a, "A", headerAnchor(a[0] as Expansion), "A", view);
    const withCaller = openExpansion(withCallers, "B", { kind: "step", fnId: callersKey("A"), stepId: "pump", rect: callerRowRect(0) }, chart("B", 200, 100), view);
    expect(withCaller.map((e) => e.fnId)).toEqual(["A", callersKey("A"), "B"]);
    expect(closeExpansion(withCaller, "A")).toEqual([]);
  });

  it("toggling the callers button twice closes the box", () => {
    const anchor = { kind: "box" as const, nodeId: "n", rect: box };
    const once = toggleCallers([], "A", anchor, "A", view);
    expect(once.some((e) => e.fnId === callersKey("A"))).toBe(true);
    const twice = toggleCallers(once, "A", anchor, "A", view);
    expect(twice).toEqual([]);
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

    const leaf = layoutFunction({ id: "f#leaf", name: "leaf", async: false, items: [{ t: "step", role: "call", label: "a()" }] });
    const root = layoutFunction({ id: "f#root", name: "root", async: false, items: [{ t: "step", role: "call", label: "leaf()", target: "f#leaf" }] });
    const nodeId = root.nodes.find((n) => n.label === "leaf()")!.id;
    const nested = relayout(root, new Map([[nodeId, { flow: leaf }]]));
    const html = renderToStaticMarkup(<FlowChart id="p" fn={nested} scope="" onCallers={() => {}} />);
    expect(html).toContain("zm-callers-btn");
    expect(html).toContain('aria-label="Show callers of leaf"');
    expect(html).not.toContain("zm-callers-btn is-open");
  });
});
