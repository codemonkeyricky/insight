// @vitest-environment jsdom
// The Stages view's error and keyboard behaviour: an error belongs to the scope or driver it was raised for, and an exit pill that opens
// a call site is a button from the keyboard too (Enter or Space), like a card.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { StagesPayload } from "../src/model/payloads";
import { StagesView } from "../src/components/views/StagesView";

const { getStages, showCode } = vi.hoisted(() => ({ getStages: vi.fn(), showCode: vi.fn() }));
vi.mock("../src/api", () => ({ api: { getStages } }));
vi.mock("../src/codeTarget", () => ({
  fileTarget: (file: string, line: number) => ({ file, line }),
  useCodeTarget: () => ({ showCode }),
}));

const RUN = "app/src/run.ts#run";
const site = (line: number) => ({ file: "app/src/run.ts", line, fn: RUN });
/** A driver with a call, a top-level throw exit, and another call. */
const payload = (): StagesPayload => ({
  drivers: [{ id: RUN, name: "run", file: "app/src/run.ts", score: 1 }],
  graph: {
    driver: { id: RUN, name: "run", file: "app/src/run.ts" },
    body: [
      { kind: "call", id: "c0", name: "load", fn: "app/src/load.ts#load", file: "app/src/load.ts", site: site(2) },
      { kind: "exit", id: "ex1", how: "throw", site: site(4) },
      { kind: "call", id: "c1", name: "save", fn: "app/src/save.ts#save", file: "app/src/save.ts", site: site(5) },
    ],
    edges: [],
    coverage: [],
  },
});

afterEach(() => {
  cleanup();
  getStages.mockReset();
  showCode.mockReset();
});

describe("Stages view errors and keyboard", () => {
  it("clears a scope's error when the scope changes, showing the loading line until the new answer comes", async () => {
    getStages.mockRejectedValueOnce(new Error("no graph for a"));
    getStages.mockReturnValueOnce(new Promise(() => {}));
    const { rerender } = render(<StagesView id="p" scope="a" />);
    expect((await screen.findByRole("alert")).textContent).toContain("no graph for a");
    rerender(<StagesView id="p" scope="b" />);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("Loading stages")).toBeTruthy();
  });

  it("opens an exit pill from the keyboard: it is a button in the tab order, opened by Enter and by Space", async () => {
    getStages.mockResolvedValue(payload());
    const { container } = render(<StagesView id="p" scope="a" />);
    await screen.findByRole("img", { name: "Stages of run" });
    const pill = container.querySelector(".stg-pill") as HTMLElement | null;
    expect(pill).not.toBeNull();
    expect(pill?.getAttribute("role")).toBe("button");
    expect(pill?.getAttribute("tabindex")).toBe("0");
    fireEvent.keyDown(pill as HTMLElement, { key: "Enter" });
    expect(showCode).toHaveBeenLastCalledWith({ file: "app/src/run.ts", line: 4 });
    fireEvent.keyDown(pill as HTMLElement, { key: " " });
    expect(showCode).toHaveBeenCalledTimes(2);
  });

  it("says so when the scope has no stage drivers", async () => {
    getStages.mockResolvedValueOnce({ drivers: [] });
    render(<StagesView id="p" scope="empty" />);
    expect(await screen.findByText("No stage drivers in this scope")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows an error line when the stage graph could not be built", async () => {
    getStages.mockResolvedValueOnce({ drivers: [{ id: RUN, name: "run", file: "app/src/run.ts", score: 1 }] });
    render(<StagesView id="p" scope="broken" />);
    expect((await screen.findByRole("alert")).textContent).toBe("Stage graph could not be built");
  });
});
