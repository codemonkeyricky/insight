// @vitest-environment jsdom
// The callers box wired into the zoom map: a fake source draws a roots-only map of two function cards, F and G, so the map's
// own handlers (the card chip, Escape, the rows' ◂, the focus after a close) run as they do in the app.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { layoutFunction, type FunctionFlow, type Rect } from "@insight/flow";
import type { RefRow } from "@insight/model";
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

/** A small real chart, so an opened chart draws as it does in the app. */
const flow = (id: string, targets: readonly string[] = ["X"]): FunctionFlow =>
  layoutFunction({ id, name: id, async: false, items: targets.map((t) => ({ t: "step" as const, role: "call" as const, label: `${t.toLowerCase()}()`, target: t })) });
/** A chart that cannot nest in a call step (it has no pre-layout steps): its call opens beside the step instead. */
const flat = (id: string): FunctionFlow => ({ ...flow(id), items: undefined }) as FunctionFlow;

let chartOf: ReturnType<typeof vi.fn>;
// loadMessages stands in for the store's: it reads the function's references, as the real one does.
const charts = () => ({
  id: "p",
  scope: "",
  store: { chartOf, loadMessages: async (id: string) => { await getRefs("p", "", id); }, messagesOf: (_id: string, c: FunctionFlow) => c } as unknown as ZoomStore,
});
const refRow = (id: string): RefRow => ({ id, name: id, file: "src/a.ts", line: 3, isFunction: true, kind: "call", how: undefined, candidate: false, count: 1, inScope: true }) as RefRow;

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  // d3-zoom reads an svg's size from its width and height; jsdom has no layout.
  for (const [prop, value] of [["width", 1200], ["height", 800]] as const) {
    Object.defineProperty(SVGElement.prototype, prop, { configurable: true, get: () => ({ baseVal: { value } }) });
  }
  // Reduced motion: the camera moves at once, so nothing animates past the test.
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  chartOf = vi.fn(async (id: string) => flow(id));
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1200);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(800);
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

const chip = (name: string) => screen.queryByRole("button", { name: `Show callers of ${name}` });
const callersBox = (name: string) => screen.queryByRole("group", { name: `Callers of ${name}` });
const stage = () => screen.getByRole("application", { name: "Execution map of the scope" });
/** The chart box of a function, by its accessible name ("Detail A: F"). */
const chartBox = (name: string) =>
  [...document.querySelectorAll(".zm-expansion[aria-label]")].find((g) => g.closest(".is-leaving") === null && /^Detail [A-Z]+: /.test(g.getAttribute("aria-label") ?? "") && g.getAttribute("aria-label")!.endsWith(`: ${name}`));
const pressed = (name: string) => chip(name)?.getAttribute("aria-pressed");
const deferred = <T,>() => {
  let resolve: (v: T) => void = () => {};
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};

describe("the map's callers wiring", () => {
  it("a card's chip opens its callers box, and pressing it again closes it", async () => {
    getRefs.mockResolvedValue({ calledBy: [refRow("P")] });
    await mount();
    fireEvent.click(chip("F")!);
    await waitFor(() => expect(callersBox("F")).not.toBeNull());
    expect(pressed("F")).toBe("true");
    fireEvent.click(chip("F")!);
    await waitFor(() => expect(callersBox("F")).toBeNull());
  });

  it("Escape on a selected card's callers box closes the box alone: the map does not go up a level (item 1)", async () => {
    getRefs.mockResolvedValue({ calledBy: [refRow("P")] });
    const build = vi.spyOn(source, "build");
    await mount();
    // Click F: its chart opens and F is selected. Click again: the chart closes, F stays selected.
    fireEvent.click(document.querySelector('[data-fid="nF"]')!);
    await waitFor(() => expect(chartBox("F")).toBeDefined());
    fireEvent.click(document.querySelector('[data-fid="nF"]')!);
    await waitFor(() => expect(chartBox("F")).toBeUndefined());
    fireEvent.click(chip("F")!);
    await waitFor(() => expect(callersBox("F")).not.toBeNull());
    const upBefore = build.mock.calls.filter(([f]) => f === "root").length;
    fireEvent.keyDown(stage(), { key: "Escape" });
    await waitFor(() => expect(callersBox("F")).toBeNull());
    await act(async () => new Promise((r) => setTimeout(r, 20)));
    expect(build.mock.calls.filter(([f]) => f === "root").length).toBe(upBefore);
  });

  it("a card keeps its chip, shown pressed, while its callers box hangs on it and its chart is open elsewhere (item 3)", async () => {
    getRefs.mockImplementation(async (_id: string, _scope: string, ref: string) => ({ calledBy: ref === "G" ? [refRow("F")] : [refRow("P")] }));
    await mount();
    fireEvent.click(chip("F")!);
    await waitFor(() => expect(callersBox("F")).not.toBeNull());
    // F's chart opens from its row in G's callers box: F's chart is open, but not on F's card.
    fireEvent.click(chip("G")!);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Open the chart of F" })).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Open the chart of F" }));
    await waitFor(() => expect(chartBox("F")).toBeDefined());
    expect(callersBox("F")).not.toBeNull();
    const cardChip = document.querySelector('[data-fid="nF"] .zm-callers-btn');
    expect(cardChip).not.toBeNull();
    expect(cardChip!.getAttribute("aria-pressed")).toBe("true");
  });

  it("two quick ◂ clicks on two rows open the row clicked last, whichever chart loads last (item 5)", async () => {
    getRefs.mockResolvedValue({ calledBy: [refRow("A"), refRow("B")] });
    const slowA = deferred<FunctionFlow>();
    chartOf.mockImplementation(async (id: string) => (id === "A" ? slowA.promise : flow(id)));
    await mount();
    fireEvent.click(chip("F")!);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Open the chart of B" })).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Open the chart of A" }));
    fireEvent.click(screen.getByRole("button", { name: "Open the chart of B" }));
    await waitFor(() => expect(chartBox("B")).toBeDefined());
    await act(async () => slowA.resolve(flow("A")));
    await act(async () => new Promise((r) => setTimeout(r, 20)));
    expect(chartBox("A")).toBeUndefined();
    expect(chartBox("B")).toBeDefined();
  });

  it("Escape with the focus on a row of the box it closes gives the focus back to the stage (item 7)", async () => {
    getRefs.mockResolvedValue({ calledBy: [refRow("P")] });
    await mount();
    fireEvent.click(chip("F")!);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Open the chart of P" })).not.toBeNull());
    const chev = screen.getByRole("button", { name: "Open the chart of P" }) as unknown as SVGElement;
    chev.focus();
    expect(document.activeElement).toBe(chev);
    fireEvent.keyDown(chev, { key: "Escape" });
    await waitFor(() => expect(callersBox("F")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(stage()));
  });

  it("a close keeps the focus on a control of a box that stays open (item 7)", async () => {
    getRefs.mockResolvedValue({ calledBy: [refRow("P")] });
    await mount();
    fireEvent.click(chip("F")!);
    fireEvent.click(chip("G")!);
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Open the chart of P" })).toHaveLength(2));
    const kept = callersBox("F")!.querySelector(".zm-caller-chev") as SVGElement;
    kept.focus();
    fireEvent.click(chip("G")!);
    await waitFor(() => expect(callersBox("G")).toBeNull());
    await act(async () => new Promise((r) => setTimeout(r, 20)));
    expect(document.activeElement).toBe(kept);
  });

  it("the box's own × pressed from the keyboard gives the focus back to the stage (item 7)", async () => {
    getRefs.mockResolvedValue({ calledBy: [refRow("P")] });
    await mount();
    fireEvent.click(chip("F")!);
    await waitFor(() => expect(callersBox("F")).not.toBeNull());
    const close = screen.getByRole("button", { name: "Close the callers of F" }) as unknown as SVGElement;
    close.focus();
    fireEvent.keyDown(close, { key: "Enter" });
    await waitFor(() => expect(callersBox("F")).toBeNull());
    expect(document.activeElement).toBe(stage());
  });

  it("a close never takes the focus from outside the map (item 7)", async () => {
    getRefs.mockResolvedValue({ calledBy: [refRow("P")] });
    await mount();
    fireEvent.click(chip("F")!);
    await waitFor(() => expect(callersBox("F")).not.toBeNull());
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();
    fireEvent.click(chip("F")!);
    await waitFor(() => expect(callersBox("F")).toBeNull());
    await act(async () => new Promise((r) => setTimeout(r, 40)));
    expect(document.activeElement).toBe(input);
    input.remove();
  });

  it("two quick opens of two call steps open the step clicked last, whichever callee loads last (review 2, finding 1)", async () => {
    const slowA = deferred<FunctionFlow>();
    chartOf.mockImplementation(async (id: string) => (id === "F" ? flow("F", ["A", "B"]) : id === "A" ? slowA.promise : flat(id)));
    await mount();
    fireEvent.click(document.querySelector('[data-fid="nF"]')!);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Open b()" })).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Open a()" }));
    fireEvent.click(screen.getByRole("button", { name: "Open b()" }));
    await waitFor(() => expect(chartBox("B")).toBeDefined());
    await act(async () => slowA.resolve(flat("A")));
    await act(async () => new Promise((r) => setTimeout(r, 20)));
    expect(chartBox("A")).toBeUndefined();
    expect(chartBox("B")).toBeDefined();
  });

  it("a callers box opened on a chart while a callee loads there keeps its place (review 2, finding 1)", async () => {
    getRefs.mockResolvedValue({ calledBy: [refRow("P")] });
    const slowX = deferred<FunctionFlow>();
    chartOf.mockImplementation(async (id: string) => (id === "X" ? slowX.promise : flow(id)));
    await mount();
    fireEvent.click(document.querySelector('[data-fid="nF"]')!);
    await waitFor(() => expect(chartBox("F")).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: "Open x()" }));
    const header = chartBox("F")!.querySelector(".zm-callers-btn")!;
    fireEvent.click(header);
    await waitFor(() => expect(callersBox("F")).not.toBeNull());
    await act(async () => slowX.resolve(flat("X")));
    await act(async () => new Promise((r) => setTimeout(r, 20)));
    expect(chartBox("X")).toBeUndefined();
    expect(callersBox("F")).not.toBeNull();
  });

  it("closing a callers box does not cancel a callee loading on its chart (review 2, finding 3)", async () => {
    getRefs.mockResolvedValue({ calledBy: [refRow("P")] });
    const slowX = deferred<FunctionFlow>();
    chartOf.mockImplementation(async (id: string) => (id === "X" ? slowX.promise : flow(id)));
    await mount();
    fireEvent.click(document.querySelector('[data-fid="nF"]')!);
    await waitFor(() => expect(chartBox("F")).toBeDefined());
    const header = () => chartBox("F")!.querySelector(".zm-callers-btn")!;
    fireEvent.click(header());
    await waitFor(() => expect(callersBox("F")).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Open x()" }));
    fireEvent.click(header());
    await waitFor(() => expect(callersBox("F")).toBeNull());
    await act(async () => slowX.resolve(flat("X")));
    await waitFor(() => expect(chartBox("X")).toBeDefined());
  });

  it("a caller's chart whose row is gone from the fresh rows does not open (review 2, finding 2)", async () => {
    getRefs.mockResolvedValue({ calledBy: [refRow("A"), refRow("B")] });
    await mount();
    fireEvent.click(chip("F")!);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Open the chart of A" })).not.toBeNull());
    fireEvent.click(chip("F")!);
    await waitFor(() => expect(callersBox("F")).toBeNull());
    // Reopen: the box shows its last rows at once, while the fresh ones (without A) and A's chart load.
    const fresh = deferred<{ calledBy: RefRow[] }>();
    getRefs.mockReturnValue(fresh.promise);
    const slowA = deferred<FunctionFlow>();
    chartOf.mockImplementation(async (id: string) => (id === "A" ? slowA.promise : flow(id)));
    fireEvent.click(chip("F")!);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Open the chart of A" })).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Open the chart of A" }));
    await act(async () => fresh.resolve({ calledBy: [refRow("B")] }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Open the chart of A" })).toBeNull());
    await act(async () => slowA.resolve(flow("A")));
    await act(async () => new Promise((r) => setTimeout(r, 20)));
    expect(chartBox("A")).toBeUndefined();
  });
});

/** A function whose coupling chart keeps a `⋯ 1 local` fold; `post` adds a message step to its own chart. */
function foldedChart(id: string, post: boolean): FunctionFlow {
  const fold = { t: "step" as const, role: "marker" as const, label: "⋯ 1 local", foldId: "F1", fold: [{ t: "step" as const, role: "call" as const, label: "a()" }] };
  const items = post ? [{ t: "step" as const, role: "call" as const, label: "message.post(x)" }, fold] : [fold];
  const source = layoutFunction({ id, name: id, async: false, items });
  return { ...source, coupling: { module: "m", footprint: { entries: [], modules: [], escape: false }, summary: "io 1", chart: source, rows: { all: 2, coupling: 1 } } };
}

describe("unfolding a coupling fold", () => {
  async function openFold() {
    await mount();
    fireEvent.click(document.querySelector('[data-fid="nF"]')!);
    await waitFor(() => expect(document.querySelector('[data-fold="F1"]')).not.toBeNull());
    // A fold opens from a double click or Enter (a single click selects it).
    fireEvent.keyDown(document.querySelector('[data-fold="F1"]')!, { key: "Enter" });
    await waitFor(() => expect(document.querySelector('[data-fold="F1"].flow-fold-open')).not.toBeNull());
  }

  it("does not request the function's references when its chart has no post step", async () => {
    chartOf.mockImplementation(async () => foldedChart("F", false));
    await openFold();
    expect(getRefs).not.toHaveBeenCalled();
  });

  it("requests the references when its chart has a post step (control)", async () => {
    chartOf.mockImplementation(async () => foldedChart("F", true));
    getRefs.mockResolvedValue({ calledBy: [] });
    await openFold();
    expect(getRefs).toHaveBeenCalledWith("p", "", "F");
  });
});
