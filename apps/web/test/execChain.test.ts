import { describe, expect, it } from "vitest";
import { execCallChain, type ExecIndex } from "../src/zoom/execMap.js";

// A roots-only view draws the functions a thread starts in (`main`, `onMessage`); `pump` and `finish` have no box.
// `verify` calls `pump`, `pump` calls `finish`, `onMessage` calls `verify`.
function indexOf(callers: Record<string, string[]>, placed: string[]): ExecIndex {
  const placements = new Map(placed.map((id) => [id, [{ nodeId: `thread:t>${id}`, thread: "thread:t", depth: 0 }]]));
  return {
    scene: { root: "program", nodes: new Map(), edges: [], levels: [] } as unknown as ExecIndex["scene"],
    fns: new Map(),
    threads: new Map(),
    callees: new Map(),
    callers: new Map(Object.entries(callers)),
    placements,
  };
}

describe("execCallChain", () => {
  it("answers the chain from the nearest drawn caller down to the function", () => {
    const index = indexOf(
      { pump: ["verify"], verify: ["onMessage"], finish: ["pump"] },
      ["onMessage"],
    );
    expect(execCallChain(index, "pump")).toEqual(["onMessage", "verify", "pump"]);
    expect(execCallChain(index, "finish")).toEqual(["onMessage", "verify", "pump", "finish"]);
  });

  it("answers undefined for a function that has a box, or that no drawn function reaches", () => {
    const index = indexOf({ pump: ["verify"], lonely: ["unreached"] }, ["onMessage", "verify"]);
    expect(execCallChain(index, "verify")).toBeUndefined();
    expect(execCallChain(index, "lonely")).toBeUndefined();
    expect(execCallChain(index, "absent")).toBeUndefined();
  });

  it("stops on a cycle of callers", () => {
    const index = indexOf({ a: ["b"], b: ["a"] }, []);
    expect(execCallChain(index, "a")).toBeUndefined();
  });

  it("prefers the shortest chain when several drawn functions reach it", () => {
    const index = indexOf({ pump: ["verify", "main"], verify: ["onMessage"] }, ["onMessage", "main"]);
    expect(execCallChain(index, "pump")).toEqual(["main", "pump"]);
  });
});
