// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SystemDiagram, SystemView } from "../src/components/views/SystemView";
import { model } from "./systemFixtures";

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
  it("Tab to a frame header, Enter collapses it, Enter again expands it", async () => {
    const user = userEvent.setup();
    render(<SystemDiagram id="p" sys={model()} tests={false} onTests={() => {}} />);
    const header = document.querySelector('[data-frame="program:svc"]') as HTMLElement;
    expect(header).not.toBeNull();
    expect(header.getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelector('[data-node="program:svc|A"]')).not.toBeNull();

    // Real Tab presses until the frame header has focus.
    for (let i = 0; i < 80 && document.activeElement !== header; i++) await user.tab();
    expect(document.activeElement).toBe(header);

    await user.keyboard("{Enter}");
    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector('[data-node="program:svc|A"]')).toBeNull();
    expect(document.querySelector('[data-frame="program:svc"]')).toBe(header);

    await user.keyboard("{Enter}");
    expect(header.getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelector('[data-node="program:svc|A"]')).not.toBeNull();
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
