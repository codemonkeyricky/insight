// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { FileEntry } from "../src/api";
import { Workspace } from "../src/components/Workspace";
import { SHEET_MAX_WIDTH } from "../src/components/sheet/bottomSheet";

// The workspace's code pane collapses while the System or Pipeline tab is shown and no code is open. These tests drive the real
// Workspace through tab changes and read the pane's open state from a stub CodePane. Heavy children are stubbed; TopBar, the tab
// strip and the splitters are real.

// jsdom has neither: the real tab strip observes its size and scrolls the current tab into view.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", ResizeObserverStub);
Element.prototype.scrollIntoView = () => {};

const { api } = vi.hoisted(() => ({
  api: {
    overview: vi.fn(),
    files: vi.fn(),
  },
}));

vi.mock("../src/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/api")>()),
  api,
  IS_HOSTED: false,
}));

vi.mock("../src/components/views/FlowView", async () => {
  const { createElement } = await import("react");
  return { FlowView: () => createElement("div", null, "flow view") };
});
vi.mock("../src/components/views/SystemView", async () => {
  const { createElement } = await import("react");
  return { SystemView: () => createElement("div", null, "system view") };
});
vi.mock("../src/components/views/PipelineTab", async () => {
  const { createElement } = await import("react");
  return { PipelineTab: () => createElement("div", null, "pipeline view") };
});
vi.mock("../src/components/views/ArchView", async () => ({ ArchView: () => null }));
vi.mock("../src/components/sheet/CodePane", async () => {
  const { createElement } = await import("react");
  return {
    CodePane: ({ open }: { open: boolean }) => createElement("div", { "data-testid": "code-pane", "data-open": String(open) }),
  };
});
vi.mock("../src/components/sheet/FileTree", async () => ({ FileTree: () => null }));
vi.mock("../src/components/sheet/FindPalette", async () => ({ FindPalette: () => null }));
vi.mock("../src/components/IndexStrip", async () => ({ IndexStrip: () => null, FirstIndex: () => null }));
vi.mock("../src/components/HostedReindex", async () => ({ HostedReindex: () => null }));
vi.mock("../src/pages/Projects", async () => ({ StatusBadge: () => null }));
vi.mock("../src/zoom/scene", () => ({ ZoomStore: class {} }));
vi.mock("../src/useIndexProgress", () => ({
  useIndexProgress: () => ({ running: false, fraction: 0 }),
}));

const overview = {
  project: { id: "p1", name: "Demo", status: "ready", source: { kind: "path", path: "/src/demo" } },
  snapshot: { id: "s1", commit: "abcdef1234", createdAt: "2026-11-16T10:00:00Z" },
};

beforeEach(() => {
  api.overview.mockResolvedValue(overview);
  api.files.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  api.overview.mockReset();
  api.files.mockReset();
  window.localStorage.clear();
});

/** Mounts the workspace on a tab and waits for the code pane to be drawn. */
async function mount(tab: string) {
  const view = render(<Workspace id="p1" tab={tab} scope="" />);
  await waitFor(() => expect(screen.getByTestId("code-pane")).toBeTruthy());
  return view;
}

const paneOpen = () => screen.getByTestId("code-pane").getAttribute("data-open");

describe("workspace code pane follows the System and Pipeline tabs", () => {
  it("System to Pipeline keeps the code pane collapsed", async () => {
    const view = await mount("system");
    await waitFor(() => expect(paneOpen()).toBe("false"));
    view.rerender(<Workspace id="p1" tab="pipeline" scope="" />);
    expect(screen.getByText("pipeline view")).toBeTruthy();
    expect(paneOpen()).toBe("false");
  });

  it("Pipeline to Flow restores the code pane", async () => {
    const view = await mount("pipeline");
    await waitFor(() => expect(paneOpen()).toBe("false"));
    view.rerender(<Workspace id="p1" tab="flow" scope="" />);
    expect(screen.getByText("flow view")).toBeTruthy();
    await waitFor(() => expect(paneOpen()).toBe("true"));
  });

  it("System to Pipeline to System stays collapsed", async () => {
    const view = await mount("system");
    await waitFor(() => expect(paneOpen()).toBe("false"));
    view.rerender(<Workspace id="p1" tab="pipeline" scope="" />);
    expect(paneOpen()).toBe("false");
    view.rerender(<Workspace id="p1" tab="system" scope="" />);
    expect(screen.getByText("system view")).toBeTruthy();
    expect(paneOpen()).toBe("false");
  });

  it("System to Packages restores the code pane", async () => {
    const view = await mount("system");
    await waitFor(() => expect(paneOpen()).toBe("false"));
    view.rerender(<Workspace id="p1" tab="packages" scope="" />);
    await waitFor(() => expect(paneOpen()).toBe("true"));
  });

  it("a Code click on System keeps the pane open when the reader leaves for Flow", async () => {
    const view = await mount("system");
    await waitFor(() => expect(paneOpen()).toBe("false"));
    const toggle = document.querySelector('button[aria-controls="sh-code"]') as HTMLButtonElement;
    expect(toggle).toBeTruthy();
    fireEvent.click(toggle);
    await waitFor(() => expect(paneOpen()).toBe("true"));
    view.rerender(<Workspace id="p1" tab="flow" scope="" />);
    expect(paneOpen()).toBe("true");
  });
});

describe("a scope that names nothing in the snapshot", () => {
  const files = [{ path: "src/a.ts" }] as unknown as FileEntry[];

  beforeEach(() => {
    api.files.mockResolvedValue(files);
  });

  it("System shows the message in place of its view", async () => {
    render(<Workspace id="p1" tab="system" scope="nope" />);
    await waitFor(() => expect(screen.getByText("Nothing at this path in the snapshot.")).toBeTruthy());
    expect(screen.queryByText("system view")).toBeNull();
  });

  it("Pipeline shows the message in place of its view", async () => {
    render(<Workspace id="p1" tab="pipeline" scope="nope" />);
    await waitFor(() => expect(screen.getByText("Nothing at this path in the snapshot.")).toBeTruthy());
    expect(screen.queryByText("pipeline view")).toBeNull();
  });

  it("Packages shows the message in place of its view", async () => {
    render(<Workspace id="p1" tab="packages" scope="nope" />);
    await waitFor(() => expect(screen.getByText("Nothing at this path in the snapshot.")).toBeTruthy());
    expect(document.querySelector(".packages-tab")).toBeNull();
  });

  it("a folder that holds files still shows its System view", async () => {
    render(<Workspace id="p1" tab="system" scope="src" />);
    await waitFor(() => expect(screen.getByText("system view")).toBeTruthy());
    expect(screen.queryByText("Nothing at this path in the snapshot.")).toBeNull();
  });
});

describe("resizing the window does not move the code pane", () => {
  let narrowNow = true;
  const listeners = new Set<() => void>();

  beforeEach(() => {
    narrowNow = true;
    // Only the narrow-layout query reports a match, and it follows narrowNow, so a test can widen the window in place.
    vi.stubGlobal("matchMedia", (q: string) => {
      const isNarrowQuery = q.includes(`max-width: ${SHEET_MAX_WIDTH}px`);
      return {
        get matches() {
          return isNarrowQuery && narrowNow;
        },
        media: q,
        onchange: null,
        addEventListener: (_: string, f: () => void) => listeners.add(f),
        removeEventListener: (_: string, f: () => void) => listeners.delete(f),
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      };
    });
    api.files.mockResolvedValue([]);
  });

  afterEach(() => {
    listeners.clear();
    delete (globalThis as { matchMedia?: unknown }).matchMedia;
  });

  it("System opened at a narrow width keeps the pane as it is when the window widens", async () => {
    await mount("system");
    // Narrow: the code pane is a closed drawer, and nothing collapses it on mount.
    expect(paneOpen()).toBe("false");
    act(() => {
      narrowNow = false;
      listeners.forEach((f) => f());
    });
    // Wide: the desktop pane is open, because no tab change collapsed it.
    expect(paneOpen()).toBe("true");
  });
});
