import { describe, expect, it } from "vitest";
import { NO_RUNTIME_NOTE } from "@insight/flow";
import { runsLine } from "../src/components/zoom/ExecFunctionPanel.js";
import type { MapSelected } from "../src/zoom/source.js";

const sel = (over: Partial<MapSelected>): MapSelected => ({ ref: "f", name: "f", file: "", line: 0, runtime: "thread", placements: [], ...over });

describe("runsLine", () => {
  it("names the thread a function runs on", () => {
    expect(runsLine(sel({ thread: "Main thread" }))).toBe("Runs on Main thread");
  });

  it("names the coroutine too, when the function runs inside one", () => {
    expect(runsLine(sel({ runtime: "coroutine", thread: "Main thread", coroutine: "step loop" }))).toBe("Runs on Main thread in coroutine step loop");
  });

  it("says exactly the no-runtime note for a function that runs nowhere", () => {
    expect(runsLine(sel({ runtime: "none", note: NO_RUNTIME_NOTE }))).toBe("Plain call with no runtime context. Zoom out to see where it runs.");
    expect(runsLine(sel({ runtime: "none" }))).toBe(NO_RUNTIME_NOTE);
  });
});
