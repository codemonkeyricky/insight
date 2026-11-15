// @vitest-environment jsdom
// The coupling detail layer: the Detail choice (read, written, blocked storage), the layer checkbox, the store's chart per
// detail, a fold opened and closed in a box, the fold row and the class names in the chart, and the panel's Coupling section.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { fireEvent, render, screen, cleanup } from "@testing-library/react";
import { layoutFunction, type FunctionFlow } from "@insight/flow";
import { DETAIL_KEY, readDetail, writeDetail } from "../src/zoom/detailPref";
import { LayersPanel, type LayerState } from "../src/components/sheet/LayersPanel";
import { ZoomStore } from "../src/zoom/scene";
import { toggleFold, type Expansion } from "../src/zoom/expand";
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
    const shown: LayerState = { frames: true, calls: true, findings: false, lambdas: false, motion: true, runtime: true, coupling: true };
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
    const store = new ZoomStore("p", "coupling");
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
    expect(opened[0]!.chart.nodes.some((n) => n.foldId === "F1")).toBe(false);
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

  it("classes an escape row and a hoisted throw as escape", () => {
    expect(couplingClassOf({ coupling: "escape" } as never)).toBe("escape");
    expect(couplingClassOf({ coupling: "io", hoisted: "may throws" } as never)).toBe("escape");
    expect(couplingClassOf({ coupling: "cross" } as never)).toBe("cross");
    expect(couplingClassOf({} as never)).toBeUndefined();
  });
});

describe("CouplingSection", () => {
  it("lists the module and the footprint grouped by class, with cross targets as links", () => {
    const base: ListBase = { id: "p", scope: "s", roots: false, onOpen: () => {} };
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
