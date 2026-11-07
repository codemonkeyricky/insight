import { describe, expect, it } from "vitest";
import { hrefCompare, hrefFile, hrefLens, hrefProject, hrefReview, parseRoute } from "../src/router.js";

describe("hash router", () => {
  it("parses the projects list, a project and a lens page", () => {
    expect(parseRoute("")).toEqual({ name: "projects" });
    expect(parseRoute("#/")).toEqual({ name: "projects" });
    expect(parseRoute("#/projects/ab12")).toEqual({ name: "project", id: "ab12" });
    expect(parseRoute("#/projects/ab12/lenses/lens-dependencies")).toEqual({ name: "lens", id: "ab12", lensId: "lens-dependencies" });
  });
  it("parses the file browser, with an optional file and line", () => {
    expect(parseRoute("#/projects/ab12/files")).toEqual({ name: "files", id: "ab12" });
    expect(parseRoute("#/projects/ab12/files/src/app.ts")).toEqual({ name: "files", id: "ab12", path: "src/app.ts" });
    expect(parseRoute("#/projects/ab12/files/src/app.ts?line=12")).toEqual({ name: "files", id: "ab12", path: "src/app.ts", line: 12 });
    expect(parseRoute("#/projects/ab12/files/src/app.ts?line=zero")).toEqual({ name: "files", id: "ab12", path: "src/app.ts" });
  });
  it("round-trips file links, including names that need escaping", () => {
    expect(parseRoute(hrefFile("p1"))).toEqual({ name: "files", id: "p1" });
    expect(parseRoute(hrefFile("p1", "src/a b/c#d.ts", 7))).toEqual({ name: "files", id: "p1", path: "src/a b/c#d.ts", line: 7 });
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
