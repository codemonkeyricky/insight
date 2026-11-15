// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { FunctionFlow } from "@insight/flow";
import type { RefRow } from "@insight/model";
import { CallersBox, forgetCallerRows } from "../src/components/zoom/CallersBox";
import { CallersButton, FULL_K, GLYPH_K } from "../src/components/zoom/CallersControl";
import { callersKey, CALLERS_W, type Expansion } from "../src/zoom/expand";
import type { CallerRow } from "../src/zoom/callers";

const { getRefs } = vi.hoisted(() => ({ getRefs: vi.fn() }));
vi.mock("../src/api", () => ({ api: { getRefs } }));

afterEach(() => {
  cleanup();
  getRefs.mockReset();
  forgetCallerRows();
});

const chart = (name: string) => ({ id: name, name, width: 200, height: 100, nodes: [], edges: [] }) as unknown as FunctionFlow;
const expansion = (ref: string): Expansion => ({
  fnId: callersKey(ref),
  kind: "callers",
  anchor: { kind: "box", nodeId: "n", rect: { x: 0, y: 0, w: 100, h: 40 } },
  chart: chart(ref),
  x: 0,
  y: 0,
  w: CALLERS_W,
  h: 200,
  index: -1,
  pivot: 0,
});
const refRow = (over: Partial<RefRow> & { id: string }): RefRow =>
  ({ name: over.id, file: "src/a.ts", line: 4, isFunction: true, kind: "call", how: undefined, candidate: false, count: 1, inScope: true, ...over }) as RefRow;

function mount(over: Partial<React.ComponentProps<typeof CallersBox>> = {}) {
  const props = {
    id: "p",
    scope: "",
    expansion: expansion("pump"),
    k: 1,
    inChain: () => false,
    onClose: vi.fn(),
    onOpen: vi.fn(),
    onSelect: vi.fn(),
    onLines: vi.fn(),
    ...over,
  };
  const ui = (
    <svg>
      <CallersBox {...props} />
    </svg>
  );
  return { props, ...render(ui) };
}

describe("callers box rows", () => {
  it("a caller already open above shows ↺ and its row selects; other callers open their charts", async () => {
    getRefs.mockResolvedValue({
      calledBy: [refRow({ id: "f#pump", name: "VerifyClient.pump" }), refRow({ id: "f#other", name: "other" })],
    });
    const { props } = mount({ inChain: (fnId) => fnId === "f#pump" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Select other" })).toBeTruthy());
    expect(screen.getByRole("button", { name: "Already open above: VerifyClient.pump" })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("button", { name: "Open the chart of other" }), { key: "Enter" });
    expect(props.onOpen).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Already open above: VerifyClient.pump" }));
    expect(props.onOpen).toHaveBeenCalledTimes(2);
  });

  it("a module row is selectable too, and a candidate caller carries a possible tag", async () => {
    getRefs.mockResolvedValue({
      calledBy: [refRow({ id: "f#top", name: "a.ts · top level", isFunction: false, line: 0 }), refRow({ id: "f#maybe", name: "maybe", candidate: true })],
    });
    const { props } = mount();
    await waitFor(() => expect(screen.getByRole("button", { name: "Select a.ts · top level" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Select a.ts · top level" }));
    expect(props.onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "f#top", isFunction: false } satisfies Partial<CallerRow>));
    expect(screen.getByText("possible")).toBeTruthy();
  });
});

describe("stale callers fetch", () => {
  it("rows that arrive after the box unmounted do not select, open, resize or throw", async () => {
    let resolve: (v: unknown) => void = () => {};
    getRefs.mockReturnValue(new Promise((r) => (resolve = r)));
    const errors: unknown[] = [];
    const onError = (e: ErrorEvent) => errors.push(e.error);
    window.addEventListener("error", onError);
    const { props, unmount } = mount();
    // The mount itself reports the loading size; only what happens after the unmount is checked.
    props.onLines.mockClear();
    unmount();
    resolve({ calledBy: [refRow({ id: "f#late", name: "late" })] });
    await new Promise((r) => setTimeout(r, 0));
    window.removeEventListener("error", onError);
    expect(errors).toEqual([]);
    expect(props.onSelect).not.toHaveBeenCalled();
    expect(props.onOpen).not.toHaveBeenCalled();
    expect(props.onLines).not.toHaveBeenCalled();
  });

  it("rows that arrive after the box closed do not resize it (onLines is not called)", async () => {
    let resolve: (v: unknown) => void = () => {};
    getRefs.mockReturnValue(new Promise((r) => (resolve = r)));
    const { props, rerender } = mount();
    props.onLines.mockClear();
    const closing = (
      <svg>
        <CallersBox {...props} closing />
      </svg>
    );
    rerender(closing);
    props.onLines.mockClear();
    resolve({ calledBy: [refRow({ id: "f#late", name: "late" }), refRow({ id: "f#later", name: "later" })] });
    await new Promise((r) => setTimeout(r, 0));
    expect(props.onLines).not.toHaveBeenCalled();
  });

  it("a closing box fetches nothing", () => {
    mount({ expansion: expansion("pump"), closing: true });
    expect(getRefs).not.toHaveBeenCalled();
  });
});

describe("callers box rows over time", () => {
  it("reports the callers its rows show, in order, so the charts opened from them follow their rows", async () => {
    getRefs.mockResolvedValue({ calledBy: [refRow({ id: "f#a" }), refRow({ id: "f#b" }), refRow({ id: "f#a", kind: "dispatch" })] });
    const { props } = mount();
    expect(props.onLines).toHaveBeenCalledWith(3, undefined);
    await waitFor(() => expect(props.onLines).toHaveBeenLastCalledWith(2, ["f#a", "f#b"]));
  });

  it("a closing box keeps showing the rows it last showed while it fades, and fetches nothing", async () => {
    getRefs.mockResolvedValue({ calledBy: [refRow({ id: "f#a", name: "alpha" }), refRow({ id: "f#b", name: "beta" })] });
    const { props, rerender } = mount();
    await waitFor(() => expect(screen.getByRole("button", { name: "Select alpha" })).toBeTruthy());
    getRefs.mockClear();
    rerender(
      <svg>
        <CallersBox {...props} closing />
      </svg>,
    );
    expect(screen.getByRole("button", { name: "Select alpha" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Select beta" })).toBeTruthy();
    expect(getRefs).not.toHaveBeenCalled();
  });
});

describe("the Callers button when zoomed out", () => {
  const draw = (k: number) =>
    render(
      <svg>
        <CallersButton x={0} y={0} name="pump" open={false} onClick={() => undefined} k={k} />
      </svg>,
    );

  it("shows its full label at 1×, the ◂ alone where the label would overflow the pill, and nothing below that", () => {
    expect(FULL_K).toBeGreaterThan(0.5);
    expect(GLYPH_K).toBeLessThan(0.5);
    expect(GLYPH_K).toBeGreaterThan(0.3);
    draw(1);
    expect(screen.getByRole("button", { name: "Show callers of pump" }).textContent).toContain("◂ callers");
    cleanup();
    draw(0.5);
    const compact = screen.getByRole("button", { name: "Show callers of pump" });
    expect(compact.querySelector("text")?.textContent).toBe("◂");
    cleanup();
    draw(0.3);
    expect(screen.queryByRole("button", { name: "Show callers of pump" })).toBeNull();
  });
});

describe("review 2 follow-ups in the callers box", () => {
  it("a closing box shows the error the open box showed, not rows from an earlier open (finding 7)", async () => {
    getRefs.mockResolvedValueOnce({ calledBy: [refRow({ id: "f#a", name: "alpha" })] });
    const first = mount();
    await waitFor(() => expect(screen.getByRole("button", { name: "Select alpha" })).toBeTruthy());
    first.unmount();
    getRefs.mockRejectedValueOnce(new Error("offline"));
    const { props, rerender } = mount();
    await waitFor(() => expect(screen.getByText(/Callers are not available: offline/)).toBeTruthy());
    rerender(
      <svg>
        <CallersBox {...props} closing />
      </svg>,
    );
    expect(screen.getByText(/Callers are not available: offline/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Select alpha" })).toBeNull();
  });

  it("a focused row that is gone after the rows change reports the focus lost (finding 5)", async () => {
    getRefs.mockResolvedValueOnce({ calledBy: [refRow({ id: "f#a", name: "alpha" })] });
    const onFocusLost = vi.fn();
    const { props, rerender } = mount({ onFocusLost });
    await waitFor(() => expect(screen.getByRole("button", { name: "Select alpha" })).toBeTruthy());
    (screen.getByRole("button", { name: "Select alpha" }) as unknown as SVGElement).focus();
    getRefs.mockReturnValue(new Promise(() => {}));
    // Another scope: the box's rows change (to loading) and the focused row goes.
    rerender(
      <svg>
        <CallersBox {...props} scope="lib" />
      </svg>,
    );
    expect(screen.queryByRole("button", { name: "Select alpha" })).toBeNull();
    expect(onFocusLost).toHaveBeenCalledTimes(1);
  });

  it("a row that keeps the focus reports nothing when other rows change", async () => {
    getRefs.mockResolvedValueOnce({ calledBy: [refRow({ id: "f#a", name: "alpha" })] });
    const onFocusLost = vi.fn();
    mount({ onFocusLost });
    await waitFor(() => expect(screen.getByRole("button", { name: "Select alpha" })).toBeTruthy());
    expect(onFocusLost).not.toHaveBeenCalled();
  });
});

describe("double-clicks on map controls (real DOM)", () => {
  it("zoomTakes leaves a double-click on a chip, inside a callers box, or on a close × to the control", async () => {
    const { zoomTakes } = await import("../src/zoom/gesture");
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const make = (cls: string) => {
      const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
      g.setAttribute("class", cls);
      const inner = document.createElementNS("http://www.w3.org/2000/svg", "text");
      g.append(inner);
      svg.append(g);
      return inner;
    };
    document.body.append(svg);
    for (const cls of ["zm-callers-btn", "zm-expansion zm-callers", "zm-expansion-close"]) expect(zoomTakes({ type: "dblclick", target: make(cls) })).toBe(false);
    expect(zoomTakes({ type: "dblclick", target: make("zm-box zm-function") })).toBe(true);
    svg.remove();
  });
});
