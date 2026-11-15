// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { FunctionFlow } from "@insight/flow";
import type { RefRow } from "@insight/model";
import { CallersBox } from "../src/components/zoom/CallersBox";
import { callersKey, CALLERS_W, type Expansion } from "../src/zoom/expand";
import type { CallerRow } from "../src/zoom/callers";

const { getRefs } = vi.hoisted(() => ({ getRefs: vi.fn() }));
vi.mock("../src/api", () => ({ api: { getRefs } }));

afterEach(() => {
  cleanup();
  getRefs.mockReset();
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
  it("rows that arrive after the box unmounted do not select, open or throw", async () => {
    let resolve: (v: unknown) => void = () => {};
    getRefs.mockReturnValue(new Promise((r) => (resolve = r)));
    const errors: unknown[] = [];
    const onError = (e: ErrorEvent) => errors.push(e.error);
    window.addEventListener("error", onError);
    const { props, unmount } = mount();
    unmount();
    resolve({ calledBy: [refRow({ id: "f#late", name: "late" })] });
    await new Promise((r) => setTimeout(r, 0));
    window.removeEventListener("error", onError);
    expect(errors).toEqual([]);
    expect(props.onSelect).not.toHaveBeenCalled();
    expect(props.onOpen).not.toHaveBeenCalled();
  });

  it("a closing box fetches nothing", () => {
    mount({ expansion: expansion("pump"), closing: true });
    expect(getRefs).not.toHaveBeenCalled();
  });
});
