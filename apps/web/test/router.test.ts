import { describe, expect, it } from "vitest";
import { BUILTIN_TABS, hrefCompare, hrefFile, hrefFlow, hrefLens, hrefProject, hrefReview, hrefView, inScope, parseRoute } from "../src/router.js";

describe("hash router", () => {
  it("parses the projects list", () => {
    expect(parseRoute("")).toEqual({ name: "projects" });
    expect(parseRoute("#/")).toEqual({ name: "projects" });
    expect(parseRoute("#/projects")).toEqual({ name: "projects" });
  });

  it("parses a project as its overview of the whole project", () => {
    expect(parseRoute("#/projects/ab12")).toEqual({ name: "workspace", id: "ab12", tab: "overview", scope: "" });
  });

  it("parses the canonical view URL with its scope, line and function", () => {
    expect(parseRoute("#/projects/ab12/view/source")).toEqual({ name: "workspace", id: "ab12", tab: "source", scope: "" });
    expect(parseRoute("#/projects/ab12/view/flow?scope=src%2Fa.ts&fn=src%2Fa.ts%23run&line=7")).toEqual({
      name: "workspace",
      id: "ab12",
      tab: "flow",
      scope: "src/a.ts",
      fn: "src/a.ts#run",
      line: 7,
    });
    expect(parseRoute("#/projects/ab12/view/findings?scope=src")).toEqual({ name: "workspace", id: "ab12", tab: "findings", scope: "src" });
  });

  it("drops a line that is not a positive whole number", () => {
    expect(parseRoute("#/projects/ab12/view/source?scope=src%2Fa.ts&line=zero")).toEqual({
      name: "workspace",
      id: "ab12",
      tab: "source",
      scope: "src/a.ts",
    });
    expect(parseRoute("#/projects/ab12/view/source?scope=src%2Fa.ts&line=0")).toEqual({ name: "workspace", id: "ab12", tab: "source", scope: "src/a.ts" });
  });

  it("parses a lens tab by its id", () => {
    expect(parseRoute("#/projects/ab12/view/lens-dependencies?scope=src")).toEqual({
      name: "workspace",
      id: "ab12",
      tab: "lens-dependencies",
      scope: "src",
    });
  });

  it("maps the older URLs onto the view URL", () => {
    expect(parseRoute("#/projects/ab12/lenses/lens-dependencies")).toEqual({ name: "workspace", id: "ab12", tab: "lens-dependencies", scope: "" });
    expect(parseRoute("#/projects/ab12/review")).toEqual({ name: "workspace", id: "ab12", tab: "review", scope: "" });
    expect(parseRoute("#/projects/ab12/files")).toEqual({ name: "workspace", id: "ab12", tab: "source", scope: "" });
    expect(parseRoute("#/projects/ab12/files/src/app.ts")).toEqual({ name: "workspace", id: "ab12", tab: "source", scope: "src/app.ts" });
    expect(parseRoute("#/projects/ab12/files/src/app.ts?line=12")).toEqual({
      name: "workspace",
      id: "ab12",
      tab: "source",
      scope: "src/app.ts",
      line: 12,
    });
    expect(parseRoute("#/projects/ab12/files/src/app.ts?line=zero")).toEqual({ name: "workspace", id: "ab12", tab: "source", scope: "src/app.ts" });
  });

  it("parses the compare page and its base and head query", () => {
    expect(parseRoute("#/projects/ab12/compare")).toEqual({ name: "workspace", id: "ab12", tab: "compare", scope: "" });
    expect(parseRoute("#/projects/ab12/compare?base=aaa&head=bbb")).toEqual({
      name: "workspace",
      id: "ab12",
      tab: "compare",
      scope: "",
      base: "aaa",
      head: "bbb",
    });
  });

  it("round-trips view links, including names that need escaping", () => {
    const scope = "src/a b/c#d.ts";
    const fn = `${scope}#run?x`;
    expect(parseRoute(hrefView("p1", "flow", { scope, fn, line: 7 }))).toEqual({
      name: "workspace",
      id: "p1",
      tab: "flow",
      scope,
      fn,
      line: 7,
    });
    expect(parseRoute(hrefView("x y", "overview"))).toEqual({ name: "workspace", id: "x y", tab: "overview", scope: "" });
  });

  it("round-trips the helpers that build links", () => {
    expect(parseRoute(hrefProject("x y"))).toEqual({ name: "workspace", id: "x y", tab: "overview", scope: "" });
    expect(parseRoute(hrefLens("p1", "lock-order"))).toEqual({ name: "workspace", id: "p1", tab: "lock-order", scope: "" });
    expect(parseRoute(hrefLens("p1", "lock-order", "src"))).toEqual({ name: "workspace", id: "p1", tab: "lock-order", scope: "src" });
    expect(parseRoute(hrefReview("p1"))).toEqual({ name: "workspace", id: "p1", tab: "review", scope: "" });
    expect(parseRoute(hrefFile("p1"))).toEqual({ name: "workspace", id: "p1", tab: "source", scope: "" });
    expect(parseRoute(hrefFile("p1", "src/a b/c#d.ts", 7))).toEqual({ name: "workspace", id: "p1", tab: "source", scope: "src/a b/c#d.ts", line: 7 });
    expect(parseRoute(hrefFile("p1", "src/a.ts"))).toEqual({ name: "workspace", id: "p1", tab: "source", scope: "src/a.ts" });
  });

  it("builds flow links with the file as the scope and the function as fn", () => {
    expect(hrefFlow("p1", "src/sample.ts", "src/sample.ts#fetchIt")).toBe("#/projects/p1/view/flow?scope=src%2Fsample.ts&fn=src%2Fsample.ts%23fetchIt");
    expect(parseRoute(hrefFlow("p1", "src/sample.ts", "src/sample.ts#fetchIt"))).toEqual({
      name: "workspace",
      id: "p1",
      tab: "flow",
      scope: "src/sample.ts",
      fn: "src/sample.ts#fetchIt",
    });
    expect(parseRoute(hrefFlow("p1", "src/sample.ts"))).toEqual({ name: "workspace", id: "p1", tab: "flow", scope: "src/sample.ts" });
  });

  it("keeps the flow mode in the URL only when it is the hierarchy", () => {
    expect(hrefView("p1", "flow", { scope: "src", mode: "hierarchy" })).toBe("#/projects/p1/view/flow?scope=src&mode=hierarchy");
    expect(hrefView("p1", "flow", { scope: "src", mode: "entries" })).toBe("#/projects/p1/view/flow?scope=src");
    expect(parseRoute("#/projects/p1/view/flow?scope=src&mode=hierarchy")).toEqual({
      name: "workspace",
      id: "p1",
      tab: "flow",
      scope: "src",
      mode: "hierarchy",
    });
    expect(parseRoute("#/projects/p1/view/flow?scope=src")).toEqual({ name: "workspace", id: "p1", tab: "flow", scope: "src" });
    expect(parseRoute("#/projects/p1/view/flow?scope=src&mode=other")).toEqual({ name: "workspace", id: "p1", tab: "flow", scope: "src" });
  });

  it("parses the compare links the helpers build", () => {
    expect(parseRoute(hrefCompare("ab12", "main~1", "HEAD"))).toEqual({
      name: "workspace",
      id: "ab12",
      tab: "compare",
      scope: "",
      base: "main~1",
      head: "HEAD",
    });
    expect(parseRoute(hrefCompare("ab12"))).toEqual({ name: "workspace", id: "ab12", tab: "compare", scope: "" });
  });

  it("treats anything else as unknown", () => {
    expect(parseRoute("#/elsewhere")).toEqual({ name: "unknown" });
    expect(parseRoute("#/projects/ab12/lenses")).toEqual({ name: "unknown" });
    expect(parseRoute("#/projects/ab12/view/flow/extra")).toEqual({ name: "unknown" });
    expect(parseRoute("#/projects/ab12/review/extra")).toEqual({ name: "unknown" });
    expect(parseRoute("#/projects/ab12/compare/extra?base=a")).toEqual({ name: "unknown" });
  });

  it("lists the built-in tabs; any other tab id is a lens", () => {
    expect([...BUILTIN_TABS]).toEqual(["overview", "source", "flow", "findings", "compare", "review"]);
  });

  it("scopes a path to a folder or a file", () => {
    expect(inScope("src/a.ts", "")).toBe(true);
    expect(inScope("src/a.ts", "src")).toBe(true);
    expect(inScope("src/a.ts", "src/a.ts")).toBe(true);
    expect(inScope("src/ab.ts", "src/a")).toBe(false);
    expect(inScope("src/a.ts", "src/a.ts/x")).toBe(false);
    expect(inScope("other/a.ts", "src")).toBe(false);
  });
});
