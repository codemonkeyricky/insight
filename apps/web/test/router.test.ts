import { describe, expect, it } from "vitest";
import { hrefLens, hrefProject, parseRoute } from "../src/router.js";

describe("hash router", () => {
  it("parses the projects list, a project and a lens page", () => {
    expect(parseRoute("")).toEqual({ name: "projects" });
    expect(parseRoute("#/")).toEqual({ name: "projects" });
    expect(parseRoute("#/projects/ab12")).toEqual({ name: "project", id: "ab12" });
    expect(parseRoute("#/projects/ab12/lenses/lens-dependencies")).toEqual({ name: "lens", id: "ab12", lensId: "lens-dependencies" });
  });
  it("treats anything else as unknown", () => {
    expect(parseRoute("#/projects/ab12/lenses")).toEqual({ name: "unknown" });
    expect(parseRoute("#/elsewhere")).toEqual({ name: "unknown" });
  });
  it("builds links that parse back to the same route", () => {
    expect(parseRoute(hrefProject("x y"))).toEqual({ name: "project", id: "x y" });
    expect(parseRoute(hrefLens("p1", "lock-order"))).toEqual({ name: "lens", id: "p1", lensId: "lock-order" });
  });
});
