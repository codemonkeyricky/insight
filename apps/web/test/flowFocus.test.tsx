// @vitest-environment jsdom
// The inter-module focus of the flow map: its preference (default, storage, blocked storage), the Show-menu checkbox and its
// hint, the request each live read sends (the focus is in the URL), the store's charts per focus (the focus replaces the
// coupling Detail, never stacks it), and the reload when the focus changes.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { layoutFunction, type FunctionFlow } from "@insight/flow";
import { api } from "../src/api";
import { FLOW_FOCUS_KEY, readFlowFocus, writeFlowFocus } from "../src/zoom/detailPref";
import { LayersPanel, type LayerState } from "../src/components/sheet/LayersPanel";
import { ZoomStore } from "../src/zoom/scene";

const step = (label: string, extra: Record<string, unknown> = {}) => ({ t: "step" as const, role: "call" as const, label, ...extra });
const shownOf = (over: Partial<LayerState> = {}): LayerState => ({ frames: true, calls: true, findings: false, lambdas: false, motion: true, runtime: true, coupling: true, intermodule: true, ...over });

describe("flow focus preference", () => {
  beforeEach(() => globalThis.localStorage.clear());
  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.localStorage.clear();
  });

  it("defaults to the inter-module focus when nothing is stored", () => {
    expect(readFlowFocus()).toBe("intermodule");
  });

  it("reads the stored choice and writes it back under its own key", () => {
    globalThis.localStorage.setItem(FLOW_FOCUS_KEY, "all");
    expect(readFlowFocus()).toBe("all");
    writeFlowFocus("intermodule");
    expect(globalThis.localStorage.getItem(FLOW_FOCUS_KEY)).toBe("intermodule");
    expect(readFlowFocus()).toBe("intermodule");
  });

  it("falls back to the inter-module focus and never throws when storage is blocked", () => {
    const spy = vi.spyOn(globalThis, "localStorage", "get").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(readFlowFocus()).toBe("intermodule");
    expect(() => writeFlowFocus("all")).not.toThrow();
    // A remount reads the choice the store was given, not the default, while storage stays blocked.
    expect(readFlowFocus()).toBe("all");
    spy.mockRestore();
    writeFlowFocus("intermodule");
    expect(readFlowFocus()).toBe("intermodule");
  });
});

describe("LayersPanel inter-module checkbox", () => {
  afterEach(cleanup);

  it("shows the checkbox with its hint, checked while the focus is on", () => {
    render(<LayersPanel shown={shownOf({ intermodule: true })} onChange={() => {}} onClose={() => {}} />);
    const box = screen.getByLabelText(/Inter-module calls only/) as HTMLInputElement;
    expect(box.checked).toBe(true);
    expect(screen.getByText("Hides file/OS/env access, try frames, and calls to functions that are not exported from another file. Empty branches and loops are pruned.")).toBeTruthy();
  });

  it("calls onChange with intermodule when toggled", () => {
    const onChange = vi.fn();
    render(<LayersPanel shown={shownOf({ intermodule: true })} onChange={onChange} onClose={() => {}} />);
    fireEvent.click(screen.getByLabelText(/Inter-module calls only/));
    expect(onChange).toHaveBeenCalledWith("intermodule", false);
  });

  it("disables the Coupling only box while the focus is on, so the two are never combined", () => {
    const { unmount } = render(<LayersPanel shown={shownOf({ intermodule: true })} onChange={() => {}} onClose={() => {}} />);
    expect((screen.getByLabelText(/Coupling only/) as HTMLInputElement).disabled).toBe(true);
    unmount();
    render(<LayersPanel shown={shownOf({ intermodule: false })} onChange={() => {}} onClose={() => {}} />);
    expect((screen.getByLabelText(/Coupling only/) as HTMLInputElement).disabled).toBe(false);
  });
});

describe("live api requests carry the focus", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** Stubs fetch with an empty answer and returns the URLs it was asked for. */
  function recordFetch(): string[] {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        urls.push(String(input));
        return new Response(JSON.stringify({ snapshot: null, file: "src/a.ts", functions: [], containers: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }),
    );
    return urls;
  }

  it("sends focus=intermodule on the flow request, and focus=all by default", async () => {
    const urls = recordFetch();
    await api.flow("p1", "src/a.ts", "intermodule");
    await api.flow("p1", "src/a.ts");
    expect(urls[0]).toContain("/api/projects/p1/flow?");
    expect(urls[0]).toContain("focus=intermodule");
    expect(urls[1]).toContain("focus=all");
  });

  it("sends the focus with the exec layout request, so a saved layout is never read for another focus", async () => {
    const urls = recordFetch();
    await api.scopeExecLayout("p1", "src", "intermodule");
    expect(urls[0]).toContain("/scope/exec-layout?path=src&focus=intermodule");
  });
});

describe("ZoomStore charts per focus", () => {
  afterEach(() => vi.restoreAllMocks());

  /** The full chart of `src/m.ts#run`, and the same function as the coupling Detail prunes it to. */
  function charts(): { full: FunctionFlow; pruned: FunctionFlow; withCoupling: FunctionFlow } {
    const full = layoutFunction({ id: "src/m.ts#run", name: "run", async: false, items: [step("db.save()", { target: "db#save" }), step("a()")] });
    const pruned = layoutFunction({ id: "src/m.ts#run", name: "run", async: false, items: [step("db.save()", { target: "db#save", coupling: "cross" })] });
    const withCoupling: FunctionFlow = {
      ...full,
      coupling: { module: "src", footprint: { entries: [], modules: [], escape: false }, summary: "", chart: pruned, rows: { all: full.nodes.length, coupling: pruned.nodes.length } },
    };
    return { full, pruned, withCoupling };
  }

  it("loads the inter-module chart under the focus, never the coupling chart, and reloads when the focus changes", async () => {
    const { full, withCoupling } = charts();
    const flow = vi.spyOn(api, "flow").mockImplementation(async (_id, _path, focus) => ({ snapshot: null, file: "src/m.ts", functions: [focus === "intermodule" ? full : withCoupling] }) as never);
    const store = new ZoomStore("p", "coupling", "intermodule");

    const inter = await store.chartOf("src/m.ts#run");
    expect(inter?.coupling).toBeUndefined();
    expect(inter?.nodes.length).toBe(full.nodes.length);
    expect(flow).toHaveBeenLastCalledWith("p", "src/m.ts", "intermodule");

    store.setFocus("all");
    const all = await store.chartOf("src/m.ts#run");
    expect(flow).toHaveBeenLastCalledWith("p", "src/m.ts", "all");
    expect(all?.coupling).toBeDefined();
    expect(all?.nodes.length).toBe(withCoupling.coupling!.chart.nodes.length);
  });

  it("reads the charts again only when the focus differs from the one loaded", async () => {
    const { full } = charts();
    const flow = vi.spyOn(api, "flow").mockImplementation(async () => ({ snapshot: null, file: "src/m.ts", functions: [full] }) as never);
    const store = new ZoomStore("p", "coupling", "intermodule");
    await store.chartOf("src/m.ts#run");
    store.setFocus("intermodule");
    await store.chartOf("src/m.ts#run");
    expect(flow).toHaveBeenCalledTimes(1);
  });
});
