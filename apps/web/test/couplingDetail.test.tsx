// @vitest-environment jsdom
// The coupling detail layer: the Detail choice (read, written, blocked storage), the layer checkbox, the store's chart per
// detail, a fold opened and closed in a box, the fold row and the class names in the chart, and the panel's Coupling section.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { fireEvent, render, screen, cleanup } from "@testing-library/react";
import { layoutFunction, type FunctionFlow } from "@insight/flow";
import { stepAction } from "../src/zoom/stepAction";
import { isPostStep } from "../src/flowTargets";
import { DETAIL_KEY, readDetail, writeDetail } from "../src/zoom/detailPref";
import { LayersPanel, type LayerState } from "../src/components/sheet/LayersPanel";
import { ZoomStore } from "../src/zoom/scene";
import { refold, toggleFold, type Expansion } from "../src/zoom/expand";
import { FlowChart, couplingClassOf } from "../src/components/FlowChart";
import { CouplingSection, type ListBase } from "../src/components/zoom/ExecFunctionPanel";

const step = (label: string, extra: Record<string, unknown> = {}) => ({ t: "step" as const, role: "call" as const, label, ...extra });

/** A function whose coupling chart keeps one cross call and one fold of two local calls. */
function coupledFlow(): { full: FunctionFlow; coupling: FunctionFlow } {
  const items = [step("db.save()", { target: "db#save", coupling: "cross" }), step("⋯ 2 local", { role: "marker", foldId: "F1", fold: [step("a()"), step("b()")] })];
  const coupling = layoutFunction({ id: "m#run", name: "run", async: false, items });
  const full = layoutFunction({ id: "m#run", name: "run", async: false, items: [step("db.save()", { target: "db#save" }), step("a()"), step("b()")] });
  return { full, coupling };
}

describe("detail preference", () => {
  beforeEach(() => globalThis.localStorage.clear());
  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.localStorage.clear();
  });

  it("defaults to the coupling detail when nothing is stored", () => {
    expect(readDetail()).toBe("coupling");
  });

  it("reads the stored choice and writes it back", () => {
    globalThis.localStorage.setItem(DETAIL_KEY, "all");
    expect(readDetail()).toBe("all");
    writeDetail("coupling");
    expect(globalThis.localStorage.getItem(DETAIL_KEY)).toBe("coupling");
    expect(readDetail()).toBe("coupling");
  });

  it("falls back to coupling and never throws when storage is blocked", () => {
    const blocked = () => {
      throw new Error("blocked");
    };
    vi.spyOn(globalThis, "localStorage", "get").mockImplementation(blocked);
    expect(readDetail()).toBe("coupling");
    expect(() => writeDetail("all")).not.toThrow();
  });
});

describe("LayersPanel coupling checkbox", () => {
  afterEach(cleanup);

  it("calls onChange with coupling when the Coupling only box is toggled", () => {
    const shown: LayerState = { frames: true, calls: true, findings: false, lambdas: false, motion: true, coupling: true, intermodule: false };
    const onChange = vi.fn();
    render(<LayersPanel shown={shown} onChange={onChange} onClose={() => {}} />);
    fireEvent.click(screen.getByLabelText(/Coupling only/));
    expect(onChange).toHaveBeenCalledWith("coupling", false);
  });
});

describe("ZoomStore.chartOf by detail", () => {
  it("returns the coupling chart with its coupling in coupling mode, and the full chart in all mode", async () => {
    const { full, coupling } = coupledFlow();
    const withCoupling: FunctionFlow = {
      ...full,
      coupling: { module: "m", footprint: { entries: [], modules: [], escape: false }, summary: "", chart: coupling, rows: { all: full.nodes.length, coupling: coupling.nodes.length } },
    };
    // The coupling Detail applies under the full chart; the inter-module focus replaces it (see flowFocus.test.tsx).
    const store = new ZoomStore("p", "coupling", "all");
    (store as unknown as { fns: Map<string, FunctionFlow> }).fns.set("m#run", withCoupling);
    const c = await store.chartOf("m#run");
    expect(c?.coupling).toBeDefined();
    expect(c?.nodes.length).toBe(coupling.nodes.length);
    store.setDetail("all");
    const a = await store.chartOf("m#run");
    expect(a?.coupling).toBeDefined();
    expect(a?.nodes.length).toBe(full.nodes.length);
  });
});

describe("toggleFold", () => {
  it("opens a fold into its rows, and closes it back to the fold row", () => {
    const { coupling } = coupledFlow();
    const e = { fnId: "m#run", anchor: { kind: "box", nodeId: "n1", rect: { x: 0, y: 0, w: 10, h: 10 } }, chart: coupling, base: coupling } as unknown as Expansion;
    const opened = toggleFold([e], "m#run", "F1", coupling, undefined);
    expect(opened[0]!.folds).toEqual(["F1"]);
    expect(opened[0]!.chart.nodes.filter((n) => n.foldId === "F1").map((n) => n.open)).toEqual([true]);
    expect(opened[0]!.chart.nodes.some((n) => n.label === "a()")).toBe(true);
    const closed = toggleFold(opened, "m#run", "F1", coupling, undefined);
    expect(closed[0]!.folds).toEqual([]);
    expect(closed[0]!.chart.nodes.some((n) => n.foldId === "F1")).toBe(true);
  });
});

describe("FlowChart coupling rows", () => {
  it("draws a fold row with its chevron and the cp- class of a cross call", () => {
    const { coupling } = coupledFlow();
    const html = renderToStaticMarkup(<FlowChart id="p" fn={coupling} scope="" />);
    expect(html).toContain("flow-fold");
    expect(html).toContain("⋯ 2 local");
    expect(html).toContain("cp-cross");
  });

  it("draws each row in its coupling class, without restyling a row by a hoisted throw", () => {
    expect(couplingClassOf({ coupling: "escape" } as never)).toBe("escape");
    // A throw hoisted under an io row does not restyle it: the row takes its strongest class (io).
    expect(couplingClassOf({ coupling: "io", hoisted: "may throws" } as never)).toBe("io");
    expect(couplingClassOf({ coupling: "cross" } as never)).toBe("cross");
    expect(couplingClassOf({} as never)).toBeUndefined();
  });
});

describe("CouplingSection", () => {
  it("lists the module and the footprint grouped by class, with cross targets as links", () => {
    const base: ListBase = { id: "p", scope: "s", onOpen: () => {} };
    const { coupling } = coupledFlow();
    const info = {
      module: "m",
      summary: "1 cross call",
      footprint: {
        entries: [
          { cls: "cross" as const, label: "db.save", target: "db#save", module: "db" },
          { cls: "io" as const, label: "fs.write" },
        ],
        modules: ["db"],
        escape: false,
      },
      chart: coupling,
      rows: { all: 3, coupling: 2 },
    };
    const html = renderToStaticMarkup(<CouplingSection base={base} info={info} />);
    expect(html).toContain("Coupling");
    expect(html).toContain("Module m");
    expect(html).toContain("Calls into other modules");
    expect(html).toContain("Does I/O");
    expect(html).toContain("db.save");
    expect(html).toContain("fn=db%23save");
  });
});

describe("fold re-anchoring and refold", () => {
  /** A run whose coupling chart is a fold of a() and b() before a cross call to db.save(). */
  function foldThenSave() {
    const items = [
      { t: "step" as const, role: "marker" as const, label: "⋯ 2 local", foldId: "F1", fold: [step("a()"), step("b()")] },
      step("db.save()", { target: "db#save", coupling: "cross" }),
    ];
    return layoutFunction({ id: "m#run", name: "run", async: false, items });
  }

  it("re-anchors a box to the same row after the fold opens, not the row that now has its old id", () => {
    const coupling = foldThenSave();
    const saveOld = coupling.nodes.find((n) => n.label === "db.save()");
    if (!saveOld) throw new Error("no db.save row");
    const box = { fnId: "db#save", anchor: { kind: "step", fnId: "m#run", stepId: saveOld.id, rect: { x: 0, y: 0, w: 1, h: 1 } }, chart: coupling, base: coupling } as unknown as Expansion;
    const run = { fnId: "m#run", anchor: { kind: "box", nodeId: "n1", rect: { x: 0, y: 0, w: 10, h: 10 } }, chart: coupling, base: coupling } as unknown as Expansion;
    const opened = toggleFold([run, box], "m#run", "F1", coupling, undefined);
    const saveNew = opened[0]!.chart.nodes.find((n) => n.label === "db.save()");
    const hung = opened.find((x) => x.fnId === "db#save");
    expect(saveNew).toBeDefined();
    expect(hung).toBeDefined();
    expect(hung!.anchor.kind === "step" && hung!.anchor.stepId).toBe(saveNew!.id);
    expect(opened[0]!.chart.nodes.find((n) => n.id === (hung!.anchor as { stepId?: string }).stepId)?.label).toBe("db.save()");
  });

  it("closes a box whose row has no match in the new chart", () => {
    const coupling = foldThenSave();
    const gone = { fnId: "x#gone", anchor: { kind: "step", fnId: "m#run", stepId: "n99", rect: { x: 0, y: 0, w: 1, h: 1 } }, chart: coupling, base: coupling } as unknown as Expansion;
    const run = { fnId: "m#run", anchor: { kind: "box", nodeId: "n1", rect: { x: 0, y: 0, w: 10, h: 10 } }, chart: coupling, base: coupling } as unknown as Expansion;
    const opened = toggleFold([run, gone], "m#run", "F1", coupling, undefined);
    expect(opened.some((x) => x.fnId === "x#gone")).toBe(false);
  });

  it("an open fold's header folds the rows back through the step action", () => {
    const { coupling } = coupledFlow();
    const e = { fnId: "m#run", anchor: { kind: "box", nodeId: "n1", rect: { x: 0, y: 0, w: 10, h: 10 } }, chart: coupling, base: coupling } as unknown as Expansion;
    const opened = toggleFold([e], "m#run", "F1", coupling, undefined);
    const header = opened[0]!.chart.nodes.find((n) => n.foldId === "F1");
    if (!header) throw new Error("expected the open header");
    expect(header.open).toBe(true);
    expect(header.label.startsWith("▾")).toBe(true);
    const ctx = { hasCallee: false, isLambda: false, runtime: "same" as const };
    expect(stepAction(header, "open", ctx)).toBe("unfold");
    const closed = toggleFold(opened, "m#run", "F1", coupling, undefined);
    expect(closed[0]!.folds).toEqual([]);
    expect(closed[0]!.chart.nodes.find((n) => n.foldId === "F1")?.open).toBeUndefined();
  });

  it("draws the open header with a down chevron and no second ▾ in its text", () => {
    const { coupling } = coupledFlow();
    const e = { fnId: "m#run", anchor: { kind: "box", nodeId: "n1", rect: { x: 0, y: 0, w: 10, h: 10 } }, chart: coupling, base: coupling } as unknown as Expansion;
    const opened = toggleFold([e], "m#run", "F1", coupling, undefined);
    const html = renderToStaticMarkup(<FlowChart id="p" fn={opened[0]!.chart} scope="" />);
    expect(html).toContain("flow-fold-open");
    expect(html).toContain(">2 local<");
  });

  it("keeps the message target and the coupling summary after a fold opens", async () => {
    const items = [step("message.post(x)"), { t: "step" as const, role: "marker" as const, label: "⋯ 1 local", foldId: "F1", fold: [step("a()")] }];
    const source = layoutFunction({ id: "m#run", name: "run", async: false, items });
    const flow: FunctionFlow = {
      ...source,
      coupling: { module: "m", footprint: { entries: [], modules: [], escape: false }, summary: "io 1", chart: source, rows: { all: 2, coupling: 2 } },
    };
    const store = new ZoomStore("p", "coupling");
    (store as unknown as { receivers: Map<string, Promise<{ id: string; name: string }[]>> }).receivers.set("m#run", Promise.resolve([{ id: "w#onmsg", name: "onmsg" }]));
    const e = { fnId: "m#run", anchor: { kind: "box", nodeId: "n1", rect: { x: 0, y: 0, w: 10, h: 10 } }, chart: flow, base: flow } as unknown as Expansion;
    await store.loadMessages("m#run");
    const opened = toggleFold([e], "m#run", "F1", source, undefined, flow.coupling, (c) => store.messagesOf("m#run", c));
    const post = opened[0]!.chart.nodes.find((n) => isPostStep(n));
    expect(post?.target).toBe("w#onmsg");
    expect(opened[0]!.chart.coupling?.summary).toBe("io 1");
  });
});

describe("re-anchoring by span, inline frames and frames cleared", () => {
  /** A `helper()` call at `line` of a.ts, as a step with its span. */
  const helperAt = (line: number) => step("helper()", { span: { file: "a.ts", start: [line, 2], end: [line, 10] } });

  /** A coupling chart with a fold of the helper at line 10 and a kept helper at line 20 (same label, different span). */
  function helperChart() {
    const items = [{ t: "step" as const, role: "marker" as const, label: "⋯ 1 local", foldId: "F1", fold: [helperAt(10)] }, helperAt(20)];
    return layoutFunction({ id: "m#run", name: "run", async: false, items });
  }

  it("closes a box from a fold's row when the fold folds back, rather than hanging from a same-label row", () => {
    const coupling = helperChart();
    const opened = toggleFold([{ fnId: "m#run", anchor: { kind: "box", nodeId: "n1", rect: { x: 0, y: 0, w: 10, h: 10 } }, chart: coupling, base: coupling } as unknown as Expansion], "m#run", "F1", coupling, undefined);
    const inner = opened[0]!.chart.nodes.find((n) => n.label === "helper()" && n.span?.start[0] === 10);
    if (!inner) throw new Error("expected the line-10 helper row in the open fold");
    const box = { fnId: "x#helper", anchor: { kind: "step", fnId: "m#run", stepId: inner.id, rect: { x: 0, y: 0, w: 1, h: 1 } }, chart: coupling, base: coupling } as unknown as Expansion;
    const closed = toggleFold([opened[0]!, box], "m#run", "F1", coupling, undefined);
    expect(closed[0]!.folds).toEqual([]);
    expect(closed.some((x) => x.fnId === "x#helper")).toBe(false);
  });

  it("closes a box anchored to an inline-frame row (id outer/inner) when a fold toggles, rather than matching an outer row", () => {
    const coupling = helperChart();
    const opened = toggleFold([{ fnId: "m#run", anchor: { kind: "box", nodeId: "n1", rect: { x: 0, y: 0, w: 10, h: 10 } }, chart: coupling, base: coupling } as unknown as Expansion], "m#run", "F1", coupling, undefined);
    // The line-20 helper, as a row of an inline frame: same span as the outer row it would otherwise match.
    const framed = { ...opened[0]!.chart, nodes: opened[0]!.chart.nodes.map((n) => (n.span?.start[0] === 20 ? { ...n, id: "n5/n7" } : n)) };
    const run = { ...opened[0]!, chart: framed } as Expansion;
    const box = { fnId: "x#helper", anchor: { kind: "step", fnId: "m#run", stepId: "n5/n7", rect: { x: 0, y: 0, w: 1, h: 1 } }, chart: coupling, base: coupling } as unknown as Expansion;
    const closed = toggleFold([run, box], "m#run", "F1", coupling, undefined);
    expect(closed.some((x) => x.fnId === "x#helper")).toBe(false);
  });

  it("closes a callers box hung from a parallel line's step when the line is cleared by a fold", () => {
    const coupling = foldThenSaveChart();
    const save = coupling.nodes.find((n) => n.label === "db.save()");
    if (!save) throw new Error("no db.save row");
    // The line: the save call drawn as a parallel line's step (shape fork, as an inline callee is), so a callers box can hang from it.
    const framed = { ...coupling, nodes: coupling.nodes.map((n) => (n.id === save.id ? { ...n, shape: "fork" } : n)) } as unknown as FunctionFlow;
    const run = { fnId: "m#run", anchor: { kind: "box", nodeId: "n1", rect: { x: 0, y: 0, w: 10, h: 10 } }, chart: framed, base: coupling } as unknown as Expansion;
    const callers = { fnId: "x#callers", kind: "callers", anchor: { kind: "step", fnId: "m#run", stepId: save.id, rect: { x: 0, y: 0, w: 1, h: 1 } }, chart: coupling, base: coupling } as unknown as Expansion;
    const next = toggleFold([run, callers], "m#run", "F1", coupling, undefined);
    expect(next.some((x) => x.fnId === "x#callers")).toBe(false);
  });

  /** A fold of a() and b() before a cross call to db.save(), as in the re-anchoring tests above. */
  function foldThenSaveChart() {
    const items = [
      { t: "step" as const, role: "marker" as const, label: "⋯ 2 local", foldId: "F1", fold: [step("a()"), step("b()")] },
      step("db.save()", { target: "db#save", coupling: "cross" }),
    ];
    return layoutFunction({ id: "m#run", name: "run", async: false, items });
  }
});

describe("state rows in the coupling view", () => {
  it("draws a write with cp-state-write, a global with cp-global, and no unresolved mark for a variable target", () => {
    const items = [
      step("▲ counter", { role: "state", coupling: "state", write: true, hidden: true, target: "m#var:counter" }),
      step("▽ config", { role: "state", coupling: "state", global: true, target: "m#var:config" }),
    ];
    const fn = layoutFunction({ id: "m#run", name: "run", async: false, items });
    const html = renderToStaticMarkup(<FlowChart id="p" fn={fn} scope="m" />);
    expect(html).toContain("cp-state-write");
    expect(html).toContain("cp-global");
    expect(html).toContain("▲ counter");
    expect(html).not.toContain("unresolved");
  });

  it("draws a plain read with cp-state only, not the write or global classes", () => {
    const items = [step("▽ total", { role: "state", coupling: "state", target: "m#var:total" })];
    const fn = layoutFunction({ id: "m#run", name: "run", async: false, items });
    const html = renderToStaticMarkup(<FlowChart id="p" fn={fn} scope="m" />);
    expect(html).toContain("cp-state");
    expect(html).not.toContain("cp-state-write");
    expect(html).not.toContain("cp-global");
  });

  it("lists the state entries in the panel with their hidden and global badges", () => {
    const base: ListBase = { id: "p", scope: "s", onOpen: () => {} };
    const { coupling } = coupledFlow();
    const info = {
      module: "m",
      summary: "state 1w 1r · ◆",
      footprint: {
        entries: [
          { cls: "state" as const, label: "▲ counter", target: "m#var:counter", write: true, hidden: true },
          { cls: "state" as const, label: "▽ config", target: "m#var:config", global: true },
        ],
        modules: [],
        escape: false,
      },
      chart: coupling,
      rows: { all: 3, coupling: 2 },
    };
    const html = renderToStaticMarkup(<CouplingSection base={base} info={info} />);
    expect(html).toContain("Touches shared state");
    expect(html).toContain("▲ counter");
    expect(html).toContain("◆ hidden");
    expect(html).toContain("▽ config");
    expect(html).toContain("global");
  });
});
