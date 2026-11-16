import { describe, expect, it } from "vitest";
import { displayLocal, displayLocals } from "../src/index.js";

describe("displayLocal", () => {
  it("strips the line suffix of a keyed local and passes a bare name through", () => {
    expect(displayLocal("x@3")).toBe("x");
    expect(displayLocal("x@3:7")).toBe("x");
    expect(displayLocal("cfg")).toBe("cfg");
  });
});

describe("displayLocals", () => {
  it("shows a line for each key when two different keys share a bare name in the set", () => {
    const shown = displayLocals(["x@3", "x@9"]);
    expect(shown("x@3")).toBe("x (line 3)");
    expect(shown("x@9")).toBe("x (line 9)");
  });

  it("shows the bare name when the set has no collision", () => {
    const shown = displayLocals(["x@3", "y@9"]);
    expect(shown("x@3")).toBe("x");
    expect(shown("y@9")).toBe("y");
  });

  it("does not count the same key twice as a collision", () => {
    const shown = displayLocals(["x@3", "x@3"]);
    expect(shown("x@3")).toBe("x");
  });

  it("shows the line of a keyed local next to a bare one of the same name", () => {
    const shown = displayLocals(["x", "x@4"]);
    expect(shown("x")).toBe("x");
    expect(shown("x@4")).toBe("x (line 4)");
  });
});
