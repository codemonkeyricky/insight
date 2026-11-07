import { describe, expect, it } from "vitest";
import { hrefCompare, hrefLens, hrefProject, hrefReview, parseRoute } from "../src/router.js";

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
    expect(parseRoute(hrefReview("p1"))).toEqual({ name: "review", id: "p1" });
  });
  it("parses the compare page and its base and head query", () => {
    expect(parseRoute("#/projects/ab12/compare")).toEqual({ name: "compare", id: "ab12" });
    expect(parseRoute("#/projects/ab12/compare?base=aaa&head=bbb")).toEqual({ name: "compare", id: "ab12", base: "aaa", head: "bbb" });
    expect(parseRoute(hrefCompare("ab12", "main~1", "HEAD"))).toEqual({ name: "compare", id: "ab12", base: "main~1", head: "HEAD" });
    expect(parseRoute(hrefCompare("ab12"))).toEqual({ name: "compare", id: "ab12" });
  });
  it("keeps unknown sub-pages unknown", () => {
    expect(parseRoute("#/projects/ab12/review/extra")).toEqual({ name: "unknown" });
    expect(parseRoute("#/projects/ab12/compare/extra?base=a")).toEqual({ name: "unknown" });
  });
});
