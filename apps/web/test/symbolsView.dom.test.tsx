// @vitest-environment jsdom
// The Symbols tab's chain: a start list opens a box, a callee opens the box to its right and drops the old tail, and the
// Callers chip opens the callers box, whose caller becomes the new head of the chain. The chain lives in the URL, one `chain=`
// value per id.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { buildProjectModel, type ProjectModel } from "@insight/model";
import { SymbolsView } from "../src/components/symbols/SymbolsView";

const { getSymbolModel, showCode } = vi.hoisted(() => ({ getSymbolModel: vi.fn(), showCode: vi.fn() }));
vi.mock("../src/api", () => ({ api: { getSymbolModel } }));
vi.mock("../src/codeTarget", () => ({
  fileTarget: (file: string, line?: number) => ({ kind: "file", path: file, line }),
  useCodeTarget: () => ({ target: undefined, showCode }),
}));

const P = { frontend: "test", confidence: "exact" as const };
// A comma in a file name: the ids in the chain carry commas, so the URL has to keep them apart.
const F = "src/app,v2.ts";
const G = "src/lib.ts";
const id = (file: string, name: string) => `${file}#${name}`;

/**
 * A project: A (exported) calls B directly and C through the internal helper H; B (exported) calls D (exported). Only A calls B.
 */
function model(): ProjectModel {
  const fn = (file: string, name: string, exported: boolean, line: number) => ({
    id: id(file, name),
    facet: "structure",
    kind: "structure.function",
    parent: file,
    span: { file, start: [line, 0] as [number, number], end: [line + 2, 1] as [number, number] },
    attrs: exported ? { name, exported: true } : { name },
    provenance: P,
  });
  const call = (from: string, to: string) => ({
    from,
    to,
    facet: "calls",
    kind: "calls.call",
    span: { file: F, start: [3, 2] as [number, number], end: [3, 6] as [number, number] },
    provenance: P,
  });
  const doc = {
    nodes: [
      { id: F, facet: "structure", kind: "structure.file", attrs: { path: F }, provenance: P },
      { id: G, facet: "structure", kind: "structure.file", attrs: { path: G }, provenance: P },
      fn(F, "A", true, 1),
      fn(F, "H", false, 6),
      fn(G, "B", true, 1),
      fn(G, "C", true, 6),
      fn(G, "D", true, 12),
    ],
    edges: [call(id(F, "A"), id(G, "B")), call(id(F, "A"), id(F, "H")), call(id(F, "H"), id(G, "C")), call(id(G, "B"), id(G, "D"))],
    findings: [],
  } as unknown as Parameters<typeof buildProjectModel>[0];
  return buildProjectModel(doc);
}

/** The box whose label is `Calls of <name>`. */
const box = (name: string) => screen.queryByRole("region", { name: `Calls of ${name}` });
const startList = () => within(screen.getByRole("complementary", { name: "Exported functions" }));
const chainInUrl = () => new URLSearchParams(window.location.hash.split("?")[1] ?? "").getAll("chain");

/** Renders the view with a chain; returns a rerender that gives it a new chain, as Back or Forward does. */
async function ready(chain: string[] = []) {
  const view = render(<SymbolsView id="p" scope="" chain={chain} />);
  await screen.findByRole("complementary", { name: "Exported functions" });
  return (next: string[]) => view.rerender(<SymbolsView id="p" scope="" chain={next} />);
}

afterEach(() => {
  cleanup();
  getSymbolModel.mockReset();
  showCode.mockReset();
  window.location.hash = "";
});

describe("Symbols tab chain", () => {
  it("opens a function's box from the start list, and lists its exported callees", async () => {
    getSymbolModel.mockResolvedValue(model());
    await ready();
    expect(screen.getByText("Pick an exported function on the left to open its calls.")).toBeTruthy();
    fireEvent.click(startList().getByRole("button", { name: "A" }));
    const a = box("A") as HTMLElement;
    expect(a).not.toBeNull();
    const rows = within(a).getAllByRole("button").filter((b) => b.classList.contains("sym-row"));
    expect(rows.map((r) => r.querySelector(".sym-row-name")?.textContent)).toEqual(["B", "C"]);
    expect(rows.find((r) => r.querySelector(".sym-row-name")?.textContent === "C")?.textContent).toContain("via H");
    expect(window.location.hash).toContain("chain=");
  });

  it("a callee opens its box to the right and drops the boxes that were right of the old one", async () => {
    getSymbolModel.mockResolvedValue(model());
    await ready();
    fireEvent.click(startList().getByRole("button", { name: "A" }));
    fireEvent.click(within(box("A") as HTMLElement).getByRole("button", { name: /^B/ }));
    // B's box opens right of A, and its row for D is the next callee.
    expect(box("B")).not.toBeNull();
    fireEvent.click(within(box("B") as HTMLElement).getByRole("button", { name: /^D/ }));
    expect(box("D")).not.toBeNull();
    // A callee of A (C, through H) replaces B and D: the chain is now A, C.
    fireEvent.click(within(box("A") as HTMLElement).getByRole("button", { name: /^C\b/ }));
    expect(box("C")).not.toBeNull();
    expect(box("B")).toBeNull();
    expect(box("D")).toBeNull();
    expect(chainInUrl()).toEqual([id(F, "A"), id(G, "C")]);
  });

  it("clicking the selected callee again closes everything right of its box", async () => {
    getSymbolModel.mockResolvedValue(model());
    await ready([id(F, "A"), id(G, "B")]);
    expect(box("B")).not.toBeNull();
    fireEvent.click(within(box("A") as HTMLElement).getByRole("button", { name: /^B/ }));
    expect(box("B")).toBeNull();
    expect(box("A")).not.toBeNull();
  });

  it("the Callers chip opens the callers box, and clicking a caller makes it the head of the chain", async () => {
    getSymbolModel.mockResolvedValue(model());
    await ready([id(G, "B")]);
    expect(box("B")).not.toBeNull();
    const chip = within(box("B") as HTMLElement).getByRole("button", { name: "Callers 1" });
    fireEvent.click(chip);
    const callers = screen.getByRole("region", { name: "Callers of B" });
    expect(chip.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(within(callers).getByRole("button", { name: /^A/ }));
    // The caller A is now the head, with B still right of it; the callers box has closed.
    expect(screen.queryByRole("region", { name: "Callers of B" })).toBeNull();
    expect(box("A")).not.toBeNull();
    const b = within(box("A") as HTMLElement).getByRole("button", { name: /^B/ });
    expect(b.getAttribute("aria-pressed")).toBe("true");
    expect(chainInUrl()).toEqual([id(F, "A"), id(G, "B")]);
  });

  it("restores the chain from the URL, and keeps the valid prefix when an id mid-chain is not an exported function", async () => {
    getSymbolModel.mockResolvedValue(model());
    await ready([id(F, "A"), "nope.ts#missing", id(G, "B")]);
    expect(box("A")).not.toBeNull();
    // The valid id after the unknown one is dropped too: every box must be a callee of its left neighbour.
    expect(box("B")).toBeNull();
    expect(screen.queryByText("nope.ts#missing")).toBeNull();
  });

  it("accepts a legacy comma-joined chain when every part is known, and drops it when one part is unknown", async () => {
    getSymbolModel.mockResolvedValue(model());
    // Legacy ids are read by splitting on commas, so these two use file names without one (F has a comma and cannot be split).
    await ready([`${id(G, "B")},${id(G, "C")}`]);
    expect(box("B")).not.toBeNull();
    expect(box("C")).not.toBeNull();
    cleanup();
    await ready([`${id(G, "B")},nope.ts#missing`]);
    expect(box("B")).toBeNull();
    expect(screen.getByText("Pick an exported function on the left to open its calls.")).toBeTruthy();
  });

  it("ids that contain commas round-trip through the URL, one chain= value per id", async () => {
    getSymbolModel.mockResolvedValue(model());
    await ready();
    fireEvent.click(startList().getByRole("button", { name: "A" }));
    fireEvent.click(within(box("A") as HTMLElement).getByRole("button", { name: /^B/ }));
    const chain = chainInUrl();
    expect(chain).toEqual([id(F, "A"), id(G, "B")]);
    expect(chain[0]).toContain(",");
    cleanup();
    await ready(chain);
    expect(box("A")).not.toBeNull();
    expect(box("B")).not.toBeNull();
  });

  it("a Back or Forward chain change closes an open callers box", async () => {
    getSymbolModel.mockResolvedValue(model());
    const rerender = await ready([id(F, "A"), id(G, "B")]);
    fireEvent.click(within(box("B") as HTMLElement).getByRole("button", { name: "Callers 1" }));
    expect(screen.getByRole("region", { name: "Callers of B" })).toBeTruthy();
    // Back to a chain whose head is B: B's box is still there, its callers box is not.
    rerender([id(G, "B")]);
    expect(screen.queryByRole("region", { name: "Callers of B" })).toBeNull();
    expect(box("B")).not.toBeNull();
    expect(box("A")).toBeNull();
  });

  it("the header opens the function's source in the code pane", async () => {
    getSymbolModel.mockResolvedValue(model());
    await ready([id(G, "B")]);
    fireEvent.click(within(box("B") as HTMLElement).getByRole("button", { name: /Show the source|^B/, hidden: true }) as HTMLElement);
    expect(showCode).toHaveBeenCalledWith({ kind: "file", path: G, line: 2 });
  });
});

describe("Symbols tab camera", () => {
  /** Records every scrollIntoView call. The camera replaces it: opening a box must not scroll the page or any ancestor. */
  function spyScroll() {
    const calls: Element[] = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element) {
      calls.push(this);
    };
    return { calls, restore: () => (Element.prototype.scrollIntoView = original) };
  }

  it("opening a box does not scroll the page (the camera follows instead)", async () => {
    getSymbolModel.mockResolvedValue(model());
    const scroll = spyScroll();
    try {
      await ready();
      fireEvent.click(startList().getByRole("button", { name: "A" }));
      fireEvent.click(within(box("A") as HTMLElement).getByRole("button", { name: /^Callers/ }));
      fireEvent.click(within(box("A") as HTMLElement).getByRole("button", { name: /^B/ }));
      expect(scroll.calls).toEqual([]);
    } finally {
      scroll.restore();
    }
  });

  it("the start list is a scroll container, and the canvas is the pan and zoom stage with a world layer", async () => {
    getSymbolModel.mockResolvedValue(model());
    await ready([id(F, "A")]);
    const list = screen.getByRole("complementary", { name: "Exported functions" });
    expect(list.classList.contains("sym-list")).toBe(true);
    const canvas = document.querySelector(".sym-canvas") as HTMLElement;
    expect(canvas).not.toBeNull();
    const world = canvas.querySelector(".sym-world") as HTMLElement;
    expect(world.querySelector(".sym-track")).not.toBeNull();
    expect(world.style.transform).toContain("scale(");
    // The toolbar sits outside the scaled world.
    expect(world.contains(canvas.querySelector(".sysv-zoom"))).toBe(false);
  });
});

/*
 * The camera's motion. jsdom has no layout, so the stage is stubbed: a stage of 800 by 600 px, each column at 32 + 332 n px in the
 * track (its padding plus its place), each box 300 by 200 px. Frames run by hand (settle), so each tween is exact.
 */
describe("Symbols tab camera motion", () => {
  let queue = new Map<number, FrameRequestCallback>();
  let now = 0;
  let nextId = 1;
  function step(ms: number) {
    now += ms;
    for (const [id, cb] of [...queue]) {
      if (!queue.has(id)) continue;
      queue.delete(id);
      cb(now);
    }
  }
  function settle() {
    act(() => {
      for (let i = 0; i < 200 && queue.size > 0; i++) step(16);
    });
  }
  function setReducedMotion(reduced: boolean) {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: (query: string) => ({ matches: reduced, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false }),
    });
  }
  /** Records every scrollIntoView call. Opening a box moves the camera; nothing may scroll the page or the stage. */
  function scrollSpy() {
    const calls: Element[] = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element) {
      calls.push(this);
    };
    return { calls, restore: () => (Element.prototype.scrollIntoView = original) };
  }
  /** A pointer event with coordinates (jsdom has no PointerEvent). */
  function pointerEv(type: "pointerdown" | "pointermove" | "pointerup", target: Element, x: number, y: number) {
    const ev = new Event(type, { bubbles: true, cancelable: true });
    Object.assign(ev, { clientX: x, clientY: y, button: 0, pointerId: 1 });
    act(() => {
      target.dispatchEvent(ev);
    });
  }
  /** The camera as the world layer holds it: the transform writeCam writes. */
  function worldCam() {
    const world = document.querySelector(".sym-world") as HTMLElement;
    const m = /translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\(([\d.]+)\)/.exec(world.style.transform);
    if (m === null) throw new Error(`no camera in "${world.style.transform}"`);
    return { x: Number(m[1]), y: Number(m[2]), k: Number(m[3]) };
  }
  const columns = (cls = "") => document.querySelectorAll(`.sym-column${cls}`).length;

  beforeEach(() => {
    queue = new Map();
    now = 0;
    nextId = 1;
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      const id = nextId++;
      queue.set(id, cb);
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => {
      queue.delete(id);
    });
    const indexOfColumn = (el: Element) =>
      el.parentElement === null ? 0 : Array.from(el.parentElement.children).filter((c) => c.classList.contains("sym-column")).indexOf(el);
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 800 });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 600 });
    Object.defineProperty(HTMLElement.prototype, "offsetLeft", {
      configurable: true,
      get(this: HTMLElement) {
        return this.classList.contains("sym-column") ? 32 + indexOfColumn(this) * 332 : 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "offsetTop", { configurable: true, get: () => 0 });
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
      configurable: true,
      get(this: HTMLElement) {
        return this.classList.contains("sym-box") || this.classList.contains("sym-column") ? 300 : 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      get(this: HTMLElement) {
        return this.classList.contains("sym-box") ? 200 : 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "offsetParent", {
      configurable: true,
      get(this: HTMLElement) {
        return this.parentElement;
      },
    });
    setReducedMotion(false);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    delete (window as unknown as { matchMedia?: unknown }).matchMedia;
  });

  it("opening a box that is off screen moves the camera to show it, and scrolls nothing", async () => {
    getSymbolModel.mockResolvedValue(model());
    const scroll = scrollSpy();
    try {
      await ready([id(F, "A"), id(G, "B")]);
      fireEvent.click(within(box("B") as HTMLElement).getByRole("button", { name: /^D/ }));
      settle();
      // D is the third column: at the start its box spans x 696 to 996, so the camera moves it left by 220 to leave 24 px at the right.
      // The top stays at the band the toolbar keeps (48 px).
      expect(worldCam()).toEqual({ x: -220, y: 48, k: 1 });
      expect(scroll.calls).toEqual([]);
    } finally {
      scroll.restore();
    }
  });

  it("under reduced motion the same reveal lands at once, with no frame to run", async () => {
    getSymbolModel.mockResolvedValue(model());
    setReducedMotion(true);
    await ready([id(F, "A"), id(G, "B")]);
    fireEvent.click(within(box("B") as HTMLElement).getByRole("button", { name: /^D/ }));
    expect(worldCam().x).toBe(-220);
    expect(queue.size).toBe(0);
  });

  it("a caller picked from the head prepends a box, and the old head keeps its place on screen", async () => {
    getSymbolModel.mockResolvedValue(model());
    await ready([id(G, "B"), id(G, "D")]);
    const canvas = document.querySelector(".sym-canvas") as HTMLElement;
    // Pan right by 400 px, so the caller opened on the left has room on screen (its place is then not off the edge).
    pointerEv("pointerdown", canvas, 0, 0);
    pointerEv("pointermove", canvas, 400, 0);
    pointerEv("pointerup", canvas, 400, 0);
    expect(worldCam().x).toBe(400);
    // Open B's callers, then pick A from them. Each click is preceded by its press, as a real click is.
    const chip = within(box("B") as HTMLElement).getByRole("button", { name: "Callers 1" });
    pointerEv("pointerdown", chip, 400, 0);
    fireEvent.click(chip);
    const a = within(screen.getByRole("region", { name: "Callers of B" })).getByRole("button", { name: /^A/ });
    pointerEv("pointerdown", a, 400, 0);
    fireEvent.click(a);
    settle();
    // B is now the second column, at 364 px in the track. It is where it was on screen (32 + 400 = 432); A is left of it, on screen.
    expect(worldCam().x + 364).toBe(432);
    expect(worldCam().x + 32).toBe(100);
  });

  it("a box that leaves stays in place for 180 ms, then is removed", async () => {
    getSymbolModel.mockResolvedValue(model());
    await ready([id(F, "A"), id(G, "B"), id(G, "D")]);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    // Picking A's callee B closes the boxes right of B: B and D leave.
    fireEvent.click(within(box("A") as HTMLElement).getByRole("button", { name: /^B/ }));
    expect(columns(".sym-leaving")).toBe(2);
    act(() => vi.advanceTimersByTime(170));
    expect(columns(".sym-leaving")).toBe(2);
    act(() => vi.advanceTimersByTime(20));
    expect(columns(".sym-leaving")).toBe(0);
  });

  it("under reduced motion a box that leaves is removed at once", async () => {
    getSymbolModel.mockResolvedValue(model());
    setReducedMotion(true);
    await ready([id(F, "A"), id(G, "B"), id(G, "D")]);
    fireEvent.click(within(box("A") as HTMLElement).getByRole("button", { name: /^B/ }));
    expect(columns(".sym-leaving")).toBe(0);
  });

  it("four quick clicks on one row leave ghosts with unique keys, and React warns about no duplicate key", async () => {
    getSymbolModel.mockResolvedValue(model());
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await ready([id(F, "A")]);
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const row = () => within(box("A") as HTMLElement).getByRole("button", { name: /^B/ });
      // Open, close, open, close: B's column leaves twice, and both ghosts are still in place.
      for (let i = 0; i < 4; i++) fireEvent.click(row());
      expect(columns(".sym-leaving")).toBe(2);
      const dup = errors.mock.calls.filter((c) => /same key|unique "key"|duplicate key/i.test(String(c[0])));
      expect(dup).toEqual([]);
    } finally {
      errors.mockRestore();
    }
  });

  it("keyboard focus into an off-screen box reveals it, and holds the stage's own scroll at 0", async () => {
    getSymbolModel.mockResolvedValue(model());
    await ready([id(F, "A"), id(G, "B"), id(G, "D")]);
    const canvas = document.querySelector(".sym-canvas") as HTMLElement;
    // The stage is overflow hidden: its scroll is held in a plain property here, so the test can see the reset.
    let sl = 50;
    let st = 20;
    Object.defineProperty(canvas, "scrollLeft", { configurable: true, get: () => sl, set: (v: number) => (sl = v) });
    Object.defineProperty(canvas, "scrollTop", { configurable: true, get: () => st, set: (v: number) => (st = v) });
    // The mount's reveal already shows D. Pan away from it by 300 px first, so only the focus can bring D back on screen.
    settle();
    pointerEv("pointerdown", canvas, 0, 0);
    pointerEv("pointermove", canvas, 300, 0);
    pointerEv("pointerup", canvas, 300, 0);
    expect(worldCam().x).toBe(300);
    const title = (box("D") as HTMLElement).querySelector(".sym-title") as HTMLElement;
    act(() => title.focus());
    settle();
    expect(sl).toBe(0);
    expect(st).toBe(0);
    // The focused title is what is revealed, not the box: its left edge is at 696 px in the track (zero width in this stub), and
    // it is kept 24 px from the stage's right edge: 800 - 24 - 696 = 80.
    expect(worldCam()).toEqual({ x: 80, y: 48, k: 1 });
  });

  it("a mouse click's focus (no focus ring) does not move the camera", async () => {
    getSymbolModel.mockResolvedValue(model());
    await ready([id(F, "A"), id(G, "B"), id(G, "D")]);
    const canvas = document.querySelector(".sym-canvas") as HTMLElement;
    settle();
    pointerEv("pointerdown", canvas, 0, 0);
    pointerEv("pointermove", canvas, 300, 0);
    pointerEv("pointerup", canvas, 300, 0);
    expect(worldCam().x).toBe(300);
    const title = (box("D") as HTMLElement).querySelector(".sym-title") as HTMLElement;
    // A focus with no focus ring, as a mouse click gives a button: :focus-visible does not match it.
    const real = Element.prototype.matches;
    Element.prototype.matches = function (this: Element, sel: string) {
      return sel === ":focus-visible" ? false : real.call(this, sel);
    };
    try {
      act(() => title.focus());
    } finally {
      Element.prototype.matches = real;
    }
    settle();
    expect(worldCam()).toEqual({ x: 300, y: 48, k: 1 });
  });

  it("keyboard focus on a row below the stage, in a box taller than the stage, reveals that row and not the box's top", async () => {
    getSymbolModel.mockResolvedValue(model());
    // A's box is 1200 px tall, and its rows start at 700 px in the box: below the stage's 600 px, out of view.
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      get(this: HTMLElement) {
        return this.classList.contains("sym-box") ? 1200 : this.classList.contains("sym-row") ? 24 : 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "offsetTop", {
      configurable: true,
      get(this: HTMLElement) {
        if (!this.classList.contains("sym-row")) return 0;
        const rows = Array.from(this.closest(".sym-box")?.querySelectorAll(".sym-row") ?? []);
        return 700 + 40 * Math.max(0, rows.indexOf(this));
      },
    });
    await ready([id(F, "A")]);
    settle();
    const rows = Array.from((box("A") as HTMLElement).querySelectorAll<HTMLElement>(".sym-row"));
    expect(rows.length).toBe(2);
    // The second row (C, via H) sits at 740 px. Revealed, it keeps 24 px from the stage's bottom: y = 576 - 764 = -188. The top
    // of the box stays out of view, so the camera is not at the box's top (y 48).
    act(() => rows[1]?.focus());
    settle();
    expect(worldCam()).toEqual({ x: 0, y: -188, k: 1 });
    expect(worldCam().y + 740).toBeGreaterThanOrEqual(48);
    expect(worldCam().y + 764).toBeLessThanOrEqual(600 - 24);
  });

  it("the first tap on the start list after a touch drag opens the function", async () => {
    getSymbolModel.mockResolvedValue(model());
    await ready([]);
    const canvas = document.querySelector(".sym-canvas") as HTMLElement;
    // A touch pan: pointer events only, and no click follows them.
    pointerEv("pointerdown", canvas, 0, 0);
    pointerEv("pointermove", canvas, 60, 0);
    pointerEv("pointerup", canvas, 60, 0);
    const a = startList().getByRole("button", { name: "A" });
    pointerEv("pointerdown", a, 0, 0);
    fireEvent.click(a);
    expect(box("A")).not.toBeNull();
  });
});
