import { describe, expect, it } from "vitest";
import { contentOf, flowScopeOf } from "../src/components/sheet/shell.js";
import { fuzzyPositions, fuzzyScore, rankFiles, rankFuzzy } from "../src/components/sheet/fuzzy.js";
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
    expect(parseRoute(hrefFile("p1"))).toEqual({ name: "workspace", id: "p1", tab: "flow", scope: "", roots: true });
    expect(parseRoute(hrefFile("p1", "src/a b/c#d.ts", 7))).toEqual({ name: "workspace", id: "p1", tab: "flow", scope: "src/a b/c#d.ts", roots: true, line: 7 });
    expect(parseRoute(hrefFile("p1", "src/a.ts"))).toEqual({ name: "workspace", id: "p1", tab: "flow", scope: "src/a.ts", roots: true });
  });

  it("keeps the tab a file link is made from, so an Arch link stays on Arch", () => {
    expect(hrefFile("p1", "src/a.ts", 7, "arch")).toBe("#/projects/p1/view/arch?scope=src%2Fa.ts&line=7");
    expect(parseRoute(hrefFile("p1", "src/a.ts", 7, "arch"))).toEqual({ name: "workspace", id: "p1", tab: "arch", scope: "src/a.ts", line: 7 });
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

  it("sends a hidden lens to the flow tab with the same scope, from both lens URLs", () => {
    const hidden = ["lens-execution"];
    const fromView = parseRoute("#/projects/p1/view/lens-execution?scope=src%2Fcore");
    const fromLenses = parseRoute("#/projects/p1/lenses/lens-execution");
    expect(redirectFor(fromView, hidden)).toBe("#/projects/p1/view/flow?scope=src%2Fcore");
    expect(redirectFor(fromLenses, hidden)).toBe("#/projects/p1/view/flow");
    expect(redirectFor(parseRoute("#/projects/p1/view/lens-execution"), hidden)).toBe("#/projects/p1/view/flow");
  });

  it("leaves a lens alone until the loaded rows say it is hidden", () => {
    expect(redirectFor(parseRoute("#/projects/p1/view/lens-execution"))).toBeUndefined();
    expect(redirectFor(parseRoute("#/projects/p1/view/lens-calls"), ["lens-execution"])).toBeUndefined();
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
    expect([...BUILTIN_TABS]).toEqual(["overview", "flow", "arch", "compare", "review"]);
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

  it("arch, compare and review keep their own content, and lens ids draw lens pages", () => {
    expect(contentOf("arch", "project")).toBe("arch");
    expect(contentOf("compare", "project")).toBe("compare");
    expect(contentOf("review", "project")).toBe("triage");
    expect(contentOf("some-lens", "folder")).toBe("lens");
  });

});

describe("the retired Source and Findings tabs", () => {
  it("send the Findings view to Overview, keeping its scope", () => {
    expect(redirectFor(parseRoute("#/projects/p1/view/findings?scope=src"))).toBe("#/projects/p1/view/overview?scope=src");
    expect(redirectFor(parseRoute("#/projects/p1/view/findings"))).toBe("#/projects/p1/view/overview");
  });

  it("send the Source view to Overview, keeping the file scope and line, so the code pane opens that file", () => {
    const route = parseRoute("#/projects/p1/view/source?scope=src%2Fa.ts&line=7");
    expect(redirectFor(route)).toBe("#/projects/p1/view/overview?scope=src%2Fa.ts&line=7");
    expect(redirectFor(parseRoute("#/projects/p1/view/source"))).toBe("#/projects/p1/view/overview");
  });

  it("send the old files URLs to Overview with the file and line", () => {
    expect(redirectFor(parseRoute("#/projects/p1/files/src/app.ts?line=12"))).toBe("#/projects/p1/view/overview?scope=src%2Fapp.ts&line=12");
    expect(redirectFor(parseRoute("#/projects/p1/files"))).toBe("#/projects/p1/view/overview");
  });

  it("the redirect target is a route that shows Overview with the file as its scope", () => {
    const target = parseRoute(redirectFor(parseRoute("#/projects/p1/view/source?scope=src%2Fa.ts&line=7")) as string);
    expect(target).toEqual({ name: "workspace", id: "p1", tab: "overview", scope: "src/a.ts", line: 7 });
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

  it("gives the indices of the matched characters, and undefined when there is no match", () => {
    expect(fuzzyPositions("ab", "xaxb")).toEqual([1, 3]);
    expect(fuzzyPositions("pa", "planAssembly")).toEqual([0, 2]);
    expect(fuzzyPositions("zz", "planAssembly")).toBeUndefined();
    expect(fuzzyPositions("", "planAssembly")).toEqual([]);
  });

  it("keeps fuzzyScore's values: ab in xaxb scores 1.6 less 0.04 for the length", () => {
    expect(fuzzyScore("ab", "xaxb")).toBeCloseTo(1.56, 10);
    expect(fuzzyScore("zz", "xaxb")).toBeUndefined();
    expect(fuzzyScore("", "xaxb")).toBe(0);
  });
});

describe("rankFiles", () => {
  it("ranks a file-name match above a directory-only match", () => {
    const files = [{ path: "src/explain/notes.ts" }, { path: "src/components/Explorer.tsx" }];
    const ranked = rankFiles(files, "exp");
    expect(ranked.map((r) => r.file.path)).toEqual(["src/components/Explorer.tsx", "src/explain/notes.ts"]);
  });

  it("gives positions as offsets into the full path, for a name match and a path match", () => {
    const files = [{ path: "src/explain/notes.ts" }, { path: "src/components/Explorer.tsx" }];
    const ranked = rankFiles(files, "exp");
    // "src/components/" is 15 characters, so the name's e, x, p sit at 15, 16, 17.
    expect(ranked[0]!.positions).toEqual([15, 16, 17]);
    // Only the path matches: e, x, p at 4, 5, 6 in "src/explain/notes.ts".
    expect(ranked[1]!.positions).toEqual([4, 5, 6]);
  });

  it("drops files that match neither, and an empty or blank query gives nothing", () => {
    const files = [{ path: "a/b.ts" }, { path: "readme.md" }];
    expect(rankFiles(files, "qqq")).toEqual([]);
    expect(rankFiles(files, "")).toEqual([]);
    expect(rankFiles(files, "   ")).toEqual([]);
  });

  it("keeps the input order for equal scores and stops at the limit", () => {
    const files = [{ path: "x/a.ts" }, { path: "y/a.ts" }, { path: "z/a.ts" }];
    expect(rankFiles(files, "a", 2).map((r) => r.file.path)).toEqual(["x/a.ts", "y/a.ts"]);
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
