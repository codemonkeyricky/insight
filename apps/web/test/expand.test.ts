import { describe, expect, it } from "vitest";
import { expandedAfter } from "../src/zoom/expand.js";

describe("expandedAfter", () => {
  const start = new Set(["caller"]);

  it("a click, a call or a URL adds the function and keeps the caller open", () => {
    for (const action of ["click", "call", "url"] as const) {
      const next = expandedAfter(start, action, "callee");
      expect([...next].sort()).toEqual(["callee", "caller"]);
    }
  });

  it("returns the same set when the function is already expanded", () => {
    expect(expandedAfter(start, "click", "caller")).toBe(start);
    expect(expandedAfter(start, "url", "caller")).toBe(start);
  });

  it("never mutates the set it is given", () => {
    const before = new Set(start);
    expandedAfter(start, "call", "callee");
    expandedAfter(start, "escape", "caller");
    expect([...start]).toEqual([...before]);
  });

  it("escape removes only the named function", () => {
    const both = new Set(["caller", "callee"]);
    expect([...expandedAfter(both, "escape", "callee")]).toEqual(["caller"]);
    expect([...expandedAfter(both, "escape", "caller")]).toEqual(["callee"]);
  });

  it("escape on a function that is not expanded changes nothing", () => {
    expect(expandedAfter(start, "escape", "other")).toBe(start);
  });

  it("escape then a click re-expands the function", () => {
    const closed = expandedAfter(start, "escape", "caller");
    expect([...expandedAfter(closed, "click", "caller")]).toEqual(["caller"]);
  });
});
