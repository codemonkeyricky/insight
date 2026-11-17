// @vitest-environment jsdom
// A call row opens its callee as a separate box beside the box that holds the row, never nested in it. The chevron shows
// whether that box is open (▸ closed, ▾ open) and clicking it does what it shows. The map is the real ZoomMap, over a fake
// source of two function cards (F and G) whose charts the test supplies, as flowCallersMap.dom.test.tsx does.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { layoutFunction, type FunctionFlow, type Rect } from "@insight/flow";
import { ZoomMap } from "../src/components/zoom/ZoomMap";
import { forgetCallerRows } from "../src/components/zoom/CallersBox";
import type { MapBuild, MapNode, MapSource } from "../src/zoom/source";
import type { ZoomStore } from "../src/zoom/scene";

const { getRefs } = vi.hoisted(() => ({ getRefs: vi.fn() }));
vi.mock("../src/api", () => ({ api: { getRefs } }));

const ROOT: MapNode = { id: "root", kind: "folder", label: "src" };
const card = (id: string, ref: string): MapNode => ({ id, kind: "function", label: ref, parent: "root", ref, file: "src/a.ts", chart: { w: 200, h: 120 } });
const NODES: Record<string, MapNode> = { root: ROOT, nF: card("nF", "F"), nG: card("nG", "G") };
const RECTS: Record<string, Rect> = { root: { x: 0, y: 0, w: 1200, h: 600 }, nF: { x: 40, y: 60, w: 220, h: 60 }, nG: { x: 40, y: 300, w: 220, h: 60 } };

function buildOf(focus: string): MapBuild {
  const rects = new Map(Object.entries(RECTS));
  return {
    focus,
    nodeId: focus,
    path: "src",
    placed: {
      items: Object.keys(RECTS).map((id) => ({ id, kind: id === "root" ? "frame" : "box", rect: RECTS[id]!, depth: id === "root" ? 0 : 1 })) as MapBuild["placed"]["items"],
      rects,
      width: 1200,
      height: 600,
    },
    edges: [],
    node: (id) => NODES[id],
    depth: (id) => (id === "root" ? 0 : 1),
    crumbs: [ROOT],
  };
}

const source: MapSource = {
  resolve: async () => "root",
  ensureFocus: async () => undefined,
  build: async (focus) => buildOf(focus),
  url: () => undefined,
};

/** A chart whose rows call each of `targets` (a plain call, or a spawn on another thread when `thread` is set). */
const chart = (id: string, targets: readonly string[] = [], thread = false): FunctionFlow =>
  layoutFunction({
    id,
    name: id,
    async: false,
    items: targets.map((t) =>
      thread
        ? { t: "step" as const, role: "spawn" as const, label: `spawn thread · ${t.toLowerCase()}`, target: t }
        : { t: "step" as const, role: "call" as const, label: `${t.toLowerCase()}()`, target: t },
    ),
  });
/** A chart that cannot be drawn as a parallel line (no pre-layout steps): a call into it opens beside its step instead. */
const flat = (id: string): FunctionFlow => ({ ...chart(id), items: undefined }) as FunctionFlow;

let chartOf: ReturnType<typeof vi.fn>;
const charts = () => ({
  id: "p",
  scope: "",
  store: { chartOf, loadMessages: async () => undefined, messagesOf: (_id: string, c: FunctionFlow) => c } as unknown as ZoomStore,
});

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  for (const [prop, value] of [["width", 1200], ["height", 800]] as const) {
    Object.defineProperty(SVGElement.prototype, prop, { configurable: true, get: () => ({ baseVal: { value } }) });
  }
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1200);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(800);
  getRefs.mockResolvedValue({ calledBy: [] });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  getRefs.mockReset();
  forgetCallerRows();
});

async function mount() {
  const ui = render(<ZoomMap id="p" source={source} scope="" charts={charts()} flat hint={false} />);
  await waitFor(() => expect(document.querySelector('[data-fid="nF"]')).not.toBeNull());
  return ui;
}

/** The chart box of a function, by its accessible name ("Detail F: F"), when it is open. */
const chartBox = (name: string) =>
  [...document.querySelectorAll(".zm-expansion[aria-label]")].find((g) => g.closest(".is-leaving") === null && /^Detail [A-Z]+: /.test(g.getAttribute("aria-label") ?? "") && g.getAttribute("aria-label")!.endsWith(`: ${name}`));
const chevron = (label: string) => document.querySelector(`[aria-label="Open ${label}"]`) ?? document.querySelector(`[aria-label="Fold ${label}"]`);
const chevronState = (label: string) => (document.querySelector(`[aria-label="Fold ${label}"]`) ? "fold" : document.querySelector(`[aria-label="Open ${label}"]`) ? "open" : "none");
const settle = () => act(async () => new Promise((r) => setTimeout(r, 20)));

describe("a same-thread call row opens its callee as a separate box", () => {
  beforeEach(() => {
    // F calls X; X calls Y; Y calls nothing.
    chartOf = vi.fn(async (id: string) => (id === "F" ? chart("F", ["X"]) : id === "X" ? chart("X", ["Y"]) : chart(id)));
  });

  it("▸ opens X beside F (not nested in F's box), the chevron shows ▾, and a second click closes X", async () => {
    await mount();
    fireEvent.doubleClick(document.querySelector('[data-fid="nF"]')!);
    await waitFor(() => expect(chartBox("F")).toBeDefined());
    expect(chevronState("x()")).toBe("open");

    fireEvent.click(chevron("x()")!);
    await waitFor(() => expect(chartBox("X")).toBeDefined());
    const f = chartBox("F")!;
    const x = chartBox("X")!;
    expect(f.contains(x)).toBe(false);
    expect(chevronState("x()")).toBe("fold");

    fireEvent.click(chevron("x()")!);
    await waitFor(() => expect(chartBox("X")).toBeUndefined());
    expect(chartBox("F")).toBeDefined();
    expect(chevronState("x()")).toBe("open");
  });

  it("folding the row closes the box and every box chained from it", async () => {
    await mount();
    fireEvent.doubleClick(document.querySelector('[data-fid="nF"]')!);
    await waitFor(() => expect(chartBox("F")).toBeDefined());
    fireEvent.click(chevron("x()")!);
    await waitFor(() => expect(chartBox("X")).toBeDefined());
    fireEvent.click(chevron("y()")!);
    await waitFor(() => expect(chartBox("Y")).toBeDefined());

    fireEvent.click(chevron("x()")!);
    await waitFor(() => expect(chartBox("X")).toBeUndefined());
    await settle();
    expect(chartBox("Y")).toBeUndefined();
    expect(chartBox("F")).toBeDefined();
  });
});

describe("a call on another thread whose line cannot be drawn opens as a box beside its row", () => {
  beforeEach(() => {
    // F spawns a thread on X; X has no pre-layout steps, so no parallel line can be drawn for it.
    chartOf = vi.fn(async (id: string) => (id === "F" ? chart("F", ["X"], true) : flat(id)));
  });

  it("the row opens X as a side box, its chevron shows ▾, and clicking it closes the box", async () => {
    await mount();
    fireEvent.doubleClick(document.querySelector('[data-fid="nF"]')!);
    await waitFor(() => expect(chartBox("F")).toBeDefined());
    expect(chevronState("spawn thread · x")).toBe("open");

    fireEvent.click(chevron("spawn thread · x")!);
    await waitFor(() => expect(chartBox("X")).toBeDefined());
    expect(chartBox("F")!.contains(chartBox("X")!)).toBe(false);
    expect(chevronState("spawn thread · x")).toBe("fold");

    fireEvent.click(chevron("spawn thread · x")!);
    await waitFor(() => expect(chartBox("X")).toBeUndefined());
    expect(chevronState("spawn thread · x")).toBe("open");
  });
});
