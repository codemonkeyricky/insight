import { describe, expect, it } from "vitest";
import { contentOf, flowScopeOf } from "../src/components/sheet/shell.js";
import { fuzzyScore, rankFuzzy } from "../src/components/sheet/fuzzy.js";
import { BUILTIN_TABS, hrefCompare, hrefFile, hrefFlow, hrefLens, hrefProject, hrefReview, hrefView, inScope, parseRoute, redirectFor } from "../src/router.js";

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
      roots: true,
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
      roots: true,
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
      roots: true,
      scope: "src/sample.ts",
      fn: "src/sample.ts#fetchIt",
    });
    expect(parseRoute(hrefFlow("p1", "src/sample.ts"))).toEqual({ name: "workspace", id: "p1", tab: "flow", scope: "src/sample.ts", roots: true });
  });

  it("writes the roots-only flag as roots=1 only when it is on", () => {
    expect(hrefView("p1", "flow", { scope: "src", roots: true })).toBe("#/projects/p1/view/flow?scope=src&roots=1");
    expect(hrefView("p1", "flow", { scope: "src", roots: false })).toBe("#/projects/p1/view/flow?scope=src&roots=0");
    expect(hrefView("p1", "flow", { scope: "src/a.py", fn: "src/a.py#run", roots: true })).toBe(
      "#/projects/p1/view/flow?scope=src%2Fa.py&fn=src%2Fa.py%23run&roots=1",
    );
  });

  it("parses roots=0 and roots=1, and defaults roots to on", () => {
    expect(parseRoute("#/projects/p1/view/flow?scope=src&roots=1")).toEqual({ name: "workspace", id: "p1", tab: "flow", scope: "src", roots: true });
    // Roots-only is the default on the flow tab: roots=0 turns it off, any other value leaves it on.
    expect(parseRoute("#/projects/p1/view/flow?scope=src&roots=0")).toEqual({ name: "workspace", id: "p1", tab: "flow", scope: "src", roots: false });
    expect(parseRoute("#/projects/p1/view/flow?scope=src&roots=yes")).toEqual({ name: "workspace", id: "p1", tab: "flow", scope: "src", roots: true });
    expect(parseRoute("#/projects/p1/view/flow?scope=src")).toEqual({ name: "workspace", id: "p1", tab: "flow", scope: "src", roots: true });
  });

  it("round-trips the roots-only flag with its scope and function", () => {
    const scope = "src/a b.py";
    const fn = `${scope}#run`;
    expect(parseRoute(hrefView("p1", "flow", { scope, fn, roots: true }))).toEqual({
      name: "workspace",
      id: "p1",
      tab: "flow",
      scope,
      fn,
      roots: true,
    });
  });

  it("still opens the flow tab from the retired mode links, and ignores their mode", () => {
    expect(parseRoute("#/projects/p1/view/flow?scope=src&mode=hierarchy")).toEqual({ name: "workspace", id: "p1", tab: "flow", scope: "src", roots: true });
    expect(parseRoute("#/projects/p1/view/flow?scope=src&mode=exec")).toEqual({ name: "workspace", id: "p1", tab: "flow", scope: "src", roots: true });
    expect(parseRoute("#/projects/p1/view/flow?scope=src&mode=entries&fn=src%23run")).toEqual({
      name: "workspace",
      id: "p1",
      tab: "flow",
      scope: "src",
      fn: "src#run",
      roots: true,
    });
    expect(parseRoute("#/projects/p1/view/flow?scope=src&mode=hierarchy&roots=1")).toEqual({
      name: "workspace",
      id: "p1",
      tab: "flow",
      scope: "src",
      roots: true,
    });
  });

  it("sends the retired execution lens to the flow tab with the same scope, from both lens URLs", () => {
    const fromView = parseRoute("#/projects/p1/view/lens-execution?scope=src%2Fcore");
    const fromLenses = parseRoute("#/projects/p1/lenses/lens-execution");
    expect(redirectFor(fromView)).toBe("#/projects/p1/view/flow?scope=src%2Fcore");
    expect(redirectFor(fromLenses)).toBe("#/projects/p1/view/flow");
    expect(redirectFor(parseRoute("#/projects/p1/view/lens-execution"))).toBe("#/projects/p1/view/flow");
  });

  it("does not redirect any other route", () => {
    expect(redirectFor(parseRoute("#/projects/p1/view/flow?scope=src"))).toBeUndefined();
    expect(redirectFor(parseRoute("#/projects/p1/view/lens-dependencies?scope=src"))).toBeUndefined();
    expect(redirectFor(parseRoute("#/projects"))).toBeUndefined();
    expect(redirectFor(parseRoute("#/elsewhere"))).toBeUndefined();
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
    expect([...BUILTIN_TABS]).toEqual(["overview", "source", "flow", "arch", "findings", "compare", "review"]);
  });

  it("parses the arch tab as a view, with no scope needed", () => {
    expect(parseRoute("#/projects/p1/view/arch")).toEqual({ name: "workspace", id: "p1", tab: "arch", scope: "" });
    expect(hrefView("p1", "arch")).toBe("#/projects/p1/view/arch");
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

describe("old URLs land on the sheet content", () => {
  it("the bare project and the flow tabs draw the flow sheet", () => {
    expect(parseRoute("#/projects/ab12")).toMatchObject({ tab: "overview" });
    expect(contentOf("overview", "project")).toBe("flow");
    expect(contentOf("flow", "folder")).toBe("flow");
    expect(contentOf("flow", "file")).toBe("flow");
  });

  it("overview is the flow root, and the full overview page only with full=1", () => {
    const route = parseRoute("#/projects/ab12/view/overview?full=1");
    expect(route).toMatchObject({ tab: "overview", full: true });
    expect(contentOf("overview", "project", true)).toBe("overview");
    expect(contentOf("overview", "project")).toBe("flow");
    expect(flowScopeOf("overview", "src/a")).toBe("");
  });

  it("source is the flow sheet on a file and the source page on a folder or the project", () => {
    expect(contentOf("source", "file")).toBe("flow");
    expect(contentOf("source", "folder")).toBe("source");
    expect(contentOf("source", "project")).toBe("source");
  });

  it("arch, findings, compare and review keep their own content, and lens ids draw lens pages", () => {
    expect(contentOf("arch", "project")).toBe("arch");
    expect(contentOf("findings", "folder")).toBe("findings");
    expect(contentOf("compare", "project")).toBe("compare");
    expect(contentOf("review", "project")).toBe("triage");
    expect(contentOf("some-lens", "folder")).toBe("lens");
  });

});

describe("fuzzy matcher", () => {
  it("matches a subsequence and rejects a non-subsequence", () => {
    expect(fuzzyScore("pl", "planAssembly")).toBeDefined();
    expect(fuzzyScore("zz", "planAssembly")).toBeUndefined();
  });

  it("scores a start or word-boundary match above a match inside a word", () => {
    const boundary = fuzzyScore("ab", "a_b");
    const inside = fuzzyScore("ab", "xaxb");
    expect(boundary).toBeDefined();
    expect(inside).toBeDefined();
    expect(boundary!).toBeGreaterThan(inside!);
  });

  it("ranks the best match first and keeps the first items for an empty query", () => {
    expect(rankFuzzy(["freedom", "place"], "pl", (s) => s)[0]).toBe("place");
    expect(rankFuzzy(["one", "two", "three"], "", (s) => s, 2)).toEqual(["one", "two"]);
  });
});

describe("the findings layer link", () => {
  it("carries the kind of finding to the flow tab and back", () => {
    const href = hrefView("p1", "flow", { scope: "src/a.ts", fn: "src/a.ts#run", kind: "unreachable" });
    expect(href).toBe("#/projects/p1/view/flow?scope=src%2Fa.ts&fn=src%2Fa.ts%23run&kind=unreachable");
    expect(parseRoute(href)).toEqual({ name: "workspace", id: "p1", tab: "flow", scope: "src/a.ts", fn: "src/a.ts#run", roots: true, kind: "unreachable" });
    expect(parseRoute(hrefView("p1", "flow"))).not.toHaveProperty("kind");
  });
});
