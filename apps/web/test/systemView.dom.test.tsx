// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { boxLabel, SystemDiagram, SystemView } from "../src/components/views/SystemView";
import type { SysBox } from "../src/arch/system-layout";
import type { SystemModel, SystemSlice } from "@insight/model";
import { SLICE_LIMIT } from "../src/arch/system-frames";
import { PA, TW, CO, A, B, C, runtimes, model, slice } from "./systemFixtures";

const { getSystem } = vi.hoisted(() => ({ getSystem: vi.fn() }));
vi.mock("../src/api", () => ({ api: { getSystem } }));

afterEach(() => {
  cleanup();
  getSystem.mockReset();
});

describe("Computing runtime", () => {
  it("paints the message before the model is computed and the diagram appears", async () => {
    getSystem.mockResolvedValue(model());
    render(<SystemView id="p" scope="" />);
    // The first render shows only the message; the model is requested on a later task.
    expect(screen.getByRole("status").textContent).toBe("Computing runtime…");
    expect(document.querySelector(".sysv-svg")).toBeNull();
    expect(getSystem).not.toHaveBeenCalled();
    await waitFor(() => expect(document.querySelector(".sysv-svg")).not.toBeNull());
    expect(getSystem).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("keyboard on a frame header", () => {
  it("Tab to a frame header, Space collapses it, Space again expands it", async () => {
    const user = userEvent.setup();
    render(<SystemDiagram id="p" sys={model()} tests={false} onTests={() => {}} />);
    const header = document.querySelector('[data-frame="program:svc"]') as HTMLElement;
    expect(header).not.toBeNull();
    expect(header.getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelector('[data-node="program:svc|A"]')).not.toBeNull();

    // Real Tab presses until the frame header has focus.
    for (let i = 0; i < 80 && document.activeElement !== header; i++) await user.tab();
    expect(document.activeElement).toBe(header);

    await user.keyboard(" ");
    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector('[data-node="program:svc|A"]')).toBeNull();
    expect(document.querySelector('[data-frame="program:svc"]')).toBe(header);

    await user.keyboard(" ");
    expect(header.getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelector('[data-node="program:svc|A"]')).not.toBeNull();
  });

  it("Enter selects the frame, and its panel can collapse it", async () => {
    const user = userEvent.setup();
    render(<SystemDiagram id="p" sys={model()} tests={false} onTests={() => {}} />);
    const header = document.querySelector('[data-frame="program:svc"]') as HTMLElement;
    expect(header.getAttribute("role")).toBe("button");
    expect(header.getAttribute("aria-label")).toContain("svc · Node");
    header.focus();
    await user.keyboard("{Enter}");
    expect(header.getAttribute("aria-expanded")).toBe("true");
    const panel = screen.getByLabelText("Selection");
    expect(panel.textContent).toContain("svc · Node");
    await user.click(screen.getByRole("button", { name: "Collapse" }));
    expect(header.getAttribute("aria-expanded")).toBe("false");
  });

  it("reaches 'Group the N coroutines' from the keyboard, and folds the group back", async () => {
    const user = userEvent.setup();
    const cos = Array.from({ length: 5 }, (_, i) => ({ id: `coroutine:worker:c${i}`, kind: "coroutine" as const, label: `c${i}`, parent: TW }));
    const m = model();
    const sys: SystemModel = { ...m, runtimes: [...runtimes, ...cos], slices: [...(m.slices ?? []), ...cos.map((c) => slice(c.id, C, 1, { root: true }))] };
    render(<SystemDiagram id="p" sys={sys} tests={false} onTests={() => {}} />);
    // The thread has six coroutines: they show as one summary until the thread's group is opened.
    const summary = document.querySelector('[data-frame="cogroup:thread:worker"]') as HTMLElement;
    expect(summary).not.toBeNull();
    summary.focus();
    await user.keyboard("{Enter}");
    expect(document.querySelector('[data-frame="cogroup:thread:worker"]')).toBeNull();
    const thread = document.querySelector('[data-frame="thread:worker"]') as HTMLElement;
    thread.focus();
    await user.keyboard("{Enter}");
    await user.click(screen.getByRole("button", { name: /Group the \d+ coroutines/ }));
    expect(document.querySelector('[data-frame="cogroup:thread:worker"]')).not.toBeNull();
  });

  it("Enter and Space on a '+N more' chip widen the frame instead of selecting it", async () => {
    const user = userEvent.setup();
    const many: SystemSlice[] = Array.from({ length: SLICE_LIMIT + 2 }, (_, i) => slice(PA, `c${i}`, 1));
    const m = model();
    const sys: SystemModel = {
      ...m,
      slices: [...many],
      components: [...m.components, ...many.map((s) => ({ id: s.component, label: s.component, path: s.component, kind: "folder" as const, files: 1, functions: 1, entry: false }))],
      stages: [[A], [B], [C], many.map((s) => s.component)],
    };
    render(<SystemDiagram id="p" sys={sys} tests={false} onTests={() => {}} />);
    const more = document.querySelector('[data-node="more:program:svc"]') as HTMLElement;
    expect(more).not.toBeNull();
    expect(more.getAttribute("aria-label")).toBe("+2 more slices, show all");
    // A strip's "+N more" row names its resources, not its slices.
    expect(boxLabel({ kind: "more", title: "+13 more", sub: "", frame: "res:program:svc" } as SysBox)).toBe("+13 more resources, show all");
    more.focus();
    await user.keyboard("{Enter}");
    expect(document.querySelector('[data-node="more:program:svc"]')).toBeNull();
    expect(screen.queryByLabelText("Selection")).toBeNull();
    expect(document.querySelectorAll('[data-node^="program:svc|c"]').length).toBe(SLICE_LIMIT + 2);
  });
});

describe("aria labels", () => {
  it("names every box by its title and kind, never 'undefined'", () => {
    const m = model();
    const many: SystemSlice[] = Array.from({ length: SLICE_LIMIT + 1 }, (_, i) => slice(PA, `c${i}`, 1));
    const sys: SystemModel = {
      ...m,
      slices: [...(m.slices ?? []), ...many],
      components: [...m.components, ...many.map((s) => ({ id: s.component, label: s.component, path: s.component, kind: "folder" as const, files: 1, functions: 1, entry: false }))],
      stages: [[A], [B], [C], many.map((s) => s.component)],
    };
    render(<SystemDiagram id="p" sys={sys} tests={false} onTests={() => {}} />);
    const nodes = Array.from(document.querySelectorAll("[data-node]"));
    expect(nodes.length).toBeGreaterThan(10);
    for (const n of nodes) expect(n.getAttribute("aria-label") ?? "").not.toContain("undefined");
    const kinds = new Set(Array.from(document.querySelectorAll(".sysv-node")).map((n) => n.getAttribute("class")?.split(" ")[1]));
    for (const k of ["slice", "chip", "more", "resource", "os", "external"]) expect(kinds.has(k)).toBe(true);
    expect(document.querySelector("[data-node='fs']")?.getAttribute("aria-label")).toBe("Filesystem, outside system");
  });
});

describe("a collapsed lone process", () => {
  it("is not the empty state, and its header expands it again", async () => {
    const user = userEvent.setup();
    const sys: SystemModel = {
      ...model(),
      externals: [],
      edges: [],
      resources: [],
      stages: [[A]],
      runtimes: [runtimes[0] as (typeof runtimes)[number]],
      slices: [slice(PA, A, 3, { root: true })],
    };
    render(<SystemDiagram id="p" sys={sys} tests={false} onTests={() => {}} />);
    const header = document.querySelector('[data-frame="program:svc"]') as HTMLElement;
    header.focus();
    await user.keyboard(" ");
    expect(screen.queryByText("No system facts in this scope.")).toBeNull();
    expect(header.getAttribute("aria-expanded")).toBe("false");
    await user.keyboard(" ");
    expect(header.getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelector('[data-node="program:svc|A"]')).not.toBeNull();
  });
});

describe("zoom and pan", () => {
  const camOf = (): { k: number } => {
    const g = document.querySelector(".sysv-svg > g") as SVGGElement;
    const m = /scale\(([\d.e-]+)\)/.exec(g.getAttribute("transform") ?? "");
    return { k: Number(m?.[1]) };
  };

  it("keeps the zoom when a frame is collapsed", async () => {
    const user = userEvent.setup();
    render(<SystemDiagram id="p" sys={model()} tests={false} onTests={() => {}} />);
    await user.click(screen.getByRole("button", { name: "Zoom in" }));
    await user.click(screen.getByRole("button", { name: "Zoom in" }));
    const k = camOf().k;
    (document.querySelector('[data-frame="thread:worker"]') as HTMLElement).focus();
    await user.keyboard(" ");
    expect(document.querySelector('[data-frame="thread:worker"]')?.getAttribute("aria-expanded")).toBe("false");
    expect(camOf().k).toBe(k);
  });

  it("zooming out of a large fit never zooms in", async () => {
    const user = userEvent.setup();
    // A model whose fit is far below 0.1: many process frames.
    const m = model();
    const progs = Array.from({ length: 150 }, (_, i) => ({ id: `program:x${i}`, kind: "program" as const, label: `x${i}`, programKind: "node" as const }));
    const sys: SystemModel = { ...m, runtimes: [...runtimes, ...progs], slices: [...(m.slices ?? []), ...progs.map((p) => slice(p.id, A, 1, { root: true })), ...Array.from({ length: 12 }, (_, i) => slice(CO, `z${i}`, 1))] };
    // jsdom has no layout: give the stage a size so the fit is real.
    const w = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(400);
    const h = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(300);
    try {
      render(<SystemDiagram id="p" sys={sys} tests={false} onTests={() => {}} />);
      const fitK = camOf().k;
      expect(fitK).toBeLessThan(0.1);
      await user.click(screen.getByRole("button", { name: "Zoom out" }));
      expect(camOf().k).toBeLessThanOrEqual(fitK + 1e-9);
    } finally {
      w.mockRestore();
      h.mockRestore();
    }
  });
});


describe("frame and slice panels", () => {
  it("links a frame's roots to their Flow charts", () => {
    const sys = model();
    sys.runtimes = (sys.runtimes ?? []).map((r) => (r.id === "program:svc" ? { ...r, roots: ["svc/src/main.ts#main"] } : r));
    render(<SystemDiagram id="p" sys={sys} tests={false} onTests={() => {}} />);
    fireEvent.click(document.querySelector('[data-frame="program:svc"]') as Element);
    const link = screen.getByRole("link", { name: "main" });
    expect(link.getAttribute("href")).toContain("flow");
    expect(link.getAttribute("href")).toContain("svc%2Fsrc%2Fmain.ts%23main");
  });

  it("shows a slice's atomics count", () => {
    const sys = model();
    sys.slices = (sys.slices ?? []).map((x) => (x.id === "program:svc|A" ? { ...x, atomics: 2 } : x));
    render(<SystemDiagram id="p" sys={sys} tests={false} onTests={() => {}} />);
    fireEvent.click(document.querySelector('[data-node="program:svc|A"]') as Element);
    expect(screen.getByText(/2 atomic ops/)).toBeTruthy();
  });
});
