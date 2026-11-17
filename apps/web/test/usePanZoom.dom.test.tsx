// @vitest-environment jsdom
// The pan and zoom hook: its tween, what cancels it, reduced motion, the zoom buttons, the auto-fit, the toolbar band, the drag flag,
// and the camera written without a re-render. Animation frames are run by hand (step), so each frame is exact.
import { useState } from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePanZoom, type PanZoomOpts } from "../src/components/views/usePanZoom";
import type { Camera } from "../src/symbols/camera";

type PZ = ReturnType<typeof usePanZoom>;

// The frame queue: requestAnimationFrame only queues; step(ms) runs every queued frame, once, at the time it is given.
let now = 0;
let nextId = 1;
let queue = new Map<number, FrameRequestCallback>();

function step(ms: number) {
  now += ms;
  for (const [id, cb] of [...queue]) {
    if (!queue.has(id)) continue;
    queue.delete(id);
    cb(now);
  }
}

/** Runs frames until none is queued. A tween of 320 ms takes about 20 frames of 16 ms. */
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

beforeEach(() => {
  now = 0;
  nextId = 1;
  queue = new Map();
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    const id = nextId++;
    queue.set(id, cb);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    queue.delete(id);
  });
  // A stage of 800 by 600 px, so the fit and the reveal have a size to work with.
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 600 });
  setReducedMotion(false);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete (window as unknown as { matchMedia?: unknown }).matchMedia;
});

/**
 * Renders the hook on a stage (with a button in it, and the stage's pointer handlers), and keeps the latest result in `ref`.
 * `renders` counts the renders of the owner, so a test can see that a camera change does not re-render it.
 */
function setup(opts: PanZoomOpts = {}, content = { w: 800, h: 600 }) {
  const ref: { pz: PZ | null; renders: number } = { pz: null, renders: 0 };
  function Owner({ c }: { c: { w: number; h: number } }) {
    const [el, setEl] = useState<HTMLDivElement | null>(null);
    const pz = usePanZoom(el, c, opts);
    ref.pz = pz;
    ref.renders++;
    return (
      <div
        data-testid="stage"
        ref={setEl}
        onPointerDown={pz.pointer.onPointerDown}
        onPointerMove={pz.pointer.onPointerMove}
        onPointerUp={pz.pointer.onPointerUp}
        onPointerCancel={pz.pointer.onPointerCancel}
      >
        <button type="button">inside</button>
      </div>
    );
  }
  const view = render(<Owner c={content} />);
  const stage = view.getByTestId("stage");
  return {
    ref,
    stage,
    button: view.getByRole("button", { name: "inside" }),
    rerender: (c: { w: number; h: number }) => view.rerender(<Owner c={c} />),
    pz: () => ref.pz as PZ,
  };
}

/** A pointer event with its coordinates. jsdom has no PointerEvent, so the fields are set on a plain event. */
function pointer(type: "pointerdown" | "pointermove" | "pointerup", target: Element, x = 0, y = 0) {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(ev, { clientX: x, clientY: y, button: 0, pointerId: 1 });
  act(() => {
    target.dispatchEvent(ev);
  });
}

function wheel(target: Element, deltaY: number) {
  act(() => {
    target.dispatchEvent(new WheelEvent("wheel", { deltaY, clientX: 0, clientY: 0, bubbles: true, cancelable: true }));
  });
}

const FAR: Camera = { k: 2, x: -400, y: -120 };

describe("usePanZoom tween", () => {
  it("animateTo eases to its target over the tween, and lands on it exactly", () => {
    const { pz } = setup();
    const start = pz().getCam();
    act(() => pz().animateTo(FAR));
    act(() => step(0));
    act(() => step(160));
    const mid = pz().getCam();
    expect(mid.k).toBeGreaterThan(start.k);
    expect(mid.k).toBeLessThan(FAR.k);
    settle();
    expect(pz().getCam()).toEqual(FAR);
    expect(queue.size).toBe(0);
  });

  it("a wheel stops a running tween, and the camera keeps what the wheel set", () => {
    const { pz, stage } = setup();
    act(() => pz().animateTo(FAR));
    act(() => step(0));
    act(() => step(100));
    wheel(stage, -200);
    const afterWheel = pz().getCam();
    expect(afterWheel.k).not.toBe(1);
    settle();
    expect(pz().getCam()).toEqual(afterWheel);
  });

  it("a press stops a running tween", () => {
    const { pz, stage } = setup();
    act(() => pz().animateTo(FAR));
    act(() => step(0));
    act(() => step(100));
    const before = pz().getCam();
    pointer("pointerdown", stage, 0, 0);
    settle();
    expect(pz().getCam()).toEqual(before);
  });

  it("a new animateTo replaces the running one, and the tween ends on the new target", () => {
    const { pz } = setup();
    act(() => pz().animateTo(FAR));
    act(() => step(0));
    act(() => step(100));
    const other: Camera = { k: 0.5, x: 30, y: 40 };
    act(() => pz().animateTo(other));
    settle();
    expect(pz().getCam()).toEqual(other);
  });

  it("under reduced motion a tween jumps straight to its target", () => {
    setReducedMotion(true);
    const { pz } = setup();
    act(() => pz().animateTo(FAR));
    expect(pz().getCam()).toEqual(FAR);
    expect(queue.size).toBe(0);
  });

  it("the zoom buttons compound from the running tween's target, so quick presses add up", () => {
    const { pz } = setup({ autoFit: false });
    act(() => {
      pz().zoomBy(1.25);
      pz().zoomBy(1.25);
    });
    settle();
    expect(pz().getCam().k).toBeCloseTo(1.25 * 1.25, 6);
  });

  it("a reveal moves the camera by the least amount that shows the box, and keeps the top band", () => {
    const { pz } = setup({ autoFit: false, bandTop: 48 });
    expect(pz().getCam()).toEqual({ k: 1, x: 0, y: 48 });
    // A box to the right of the stage: revealed on its right edge, with the default 24 px margin.
    act(() => pz().revealBox({ x: 900, y: 100, w: 100, h: 50 }));
    settle();
    expect(pz().getCam().x).toBe(800 - 24 - 1000);
    expect(pz().getCam().y).toBe(48);
    // A box on screen whose top is exactly at the band (screen y 48) is already clear: nothing moves and no tween starts.
    act(() => pz().revealBox({ x: 300, y: 0, w: 100, h: 50 }));
    expect(queue.size).toBe(0);
  });
});

describe("usePanZoom auto-fit", () => {
  it("with autoFit false the camera never refits when the content changes", () => {
    const { pz, rerender } = setup({ autoFit: false });
    const before = pz().getCam();
    rerender({ w: 2000, h: 1500 });
    expect(pz().getCam()).toEqual(before);
  });

  it("with autoFit a content change stops a running tween before the fit, so the fit is what the camera keeps", () => {
    const { pz, rerender } = setup({ autoFit: true });
    act(() => pz().animateTo(FAR));
    act(() => step(0));
    act(() => step(100));
    rerender({ w: 900, h: 700 });
    const fitted = pz().getCam();
    expect(fitted.k).not.toBe(FAR.k);
    settle();
    expect(pz().getCam()).toEqual(fitted);
  });

  it("the fit keeps a band at the top when the content is taller than the stage", () => {
    // Content this tall sits at the top pad: the band, so the toolbar never covers its first row.
    const { pz } = setup({ autoFit: true, bandTop: 48 }, { w: 100, h: 2000 });
    expect(pz().getCam().y).toBe(48);
  });
});

describe("usePanZoom drag and clicks", () => {
  it("a drag pans the camera; moved() is true until the next press", () => {
    const { pz, stage, button } = setup({ autoFit: false });
    pointer("pointerdown", stage, 0, 0);
    pointer("pointermove", stage, 10, 0);
    expect(pz().getCam().x).toBe(10);
    pointer("pointerup", stage, 10, 0);
    expect(pz().moved()).toBe(true);
    // The click that ends the drag still reads the flag; the next press clears it.
    fireEvent.click(button);
    expect(pz().moved()).toBe(true);
    pointer("pointerdown", button, 0, 0);
    expect(pz().moved()).toBe(false);
  });

  it("a touch drag makes no click, and the next press anywhere clears moved()", () => {
    const { pz, stage } = setup({ autoFit: false });
    pointer("pointerdown", stage, 0, 0);
    pointer("pointermove", stage, 40, 0);
    pointer("pointerup", stage, 40, 0);
    expect(pz().moved()).toBe(true);
    pointer("pointerdown", document.body, 0, 0);
    expect(pz().moved()).toBe(false);
  });

  it("the window press listener is added once for the hook's life, and removed on unmount", () => {
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    try {
      const { stage } = setup({ autoFit: false });
      for (let i = 0; i < 5; i++) {
        pointer("pointerdown", stage, 0, 0);
        pointer("pointermove", stage, 20, 0);
        pointer("pointerup", stage, 20, 0);
      }
      const added = add.mock.calls.filter((c) => c[0] === "pointerdown");
      expect(added.length).toBe(1);
      cleanup();
      const removed = remove.mock.calls.filter((c) => c[0] === "pointerdown");
      expect(removed.length).toBe(1);
      expect(removed[0]?.[1]).toBe(added[0]?.[1]);
    } finally {
      add.mockRestore();
      remove.mockRestore();
    }
  });

  it("a press without a move is not a drag, and a press on a button does not pan", () => {
    const { pz, stage, button } = setup({ autoFit: false });
    pointer("pointerdown", stage, 0, 0);
    pointer("pointerup", stage, 0, 0);
    expect(pz().moved()).toBe(false);
    pointer("pointerdown", button, 0, 0);
    pointer("pointermove", stage, 50, 0);
    expect(pz().getCam().x).toBe(0);
  });
});

describe("usePanZoom camera writes", () => {
  it("applyTo receives every camera change, and a tween frame re-renders the owner not at all", () => {
    const applied: Camera[] = [];
    const { pz, ref } = setup({ applyTo: (c) => applied.push({ ...c }) });
    const renders = ref.renders;
    act(() => pz().animateTo(FAR));
    settle();
    expect(ref.renders).toBe(renders);
    expect(applied.length).toBeGreaterThan(3);
    expect(applied[applied.length - 1]).toEqual(FAR);
  });
});
