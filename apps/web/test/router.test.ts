import { describe, expect, it } from "vitest";
import { contentOf } from "../src/components/sheet/shell.js";
import { fuzzyPositions, fuzzyScore, rankFiles, rankFuzzy } from "../src/components/sheet/fuzzy.js";
import { BUILTIN_TABS, hrefFile, hrefFlow, hrefProject, hrefView, inScope, parseRoute, redirectFor } from "../src/router.js";

describe("hash router", () => {
  it("parses the projects list", () => {
    expect(parseRoute("")).toEqual({ name: "projects" });
    expect(parseRoute("#/")).toEqual({ name: "projects" });
    expect(parseRoute("#/projects")).toEqual({ name: "projects" });
  });

  it("parses a project as the Flow tab of the whole project", () => {
    expect(parseRoute("#/projects/ab12")).toEqual({ name: "workspace", id: "ab12", tab: "flow", scope: "" });
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

  it("parses a legacy lens tab id as its tab (redirectFor sends it to Flow)", () => {
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
    expect(parseRoute(hrefView("x y", "flow"))).toEqual({ name: "workspace", id: "x y", tab: "flow", scope: "" });
  });

  it("round-trips the helpers that build links", () => {
    expect(parseRoute(hrefProject("x y"))).toEqual({ name: "workspace", id: "x y", tab: "flow", scope: "" });
    expect(parseRoute(hrefView("p1", "lock-order"))).toEqual({ name: "workspace", id: "p1", tab: "lock-order", scope: "" });
    expect(parseRoute(hrefView("p1", "lock-order", { scope: "src" }))).toEqual({ name: "workspace", id: "p1", tab: "lock-order", scope: "src" });
    expect(parseRoute(hrefView("p1", "review"))).toEqual({ name: "workspace", id: "p1", tab: "review", scope: "" });
    expect(parseRoute(hrefFile("p1"))).toEqual({ name: "workspace", id: "p1", tab: "flow", scope: "" });
    expect(parseRoute(hrefFile("p1", "src/a b/c#d.ts", 7))).toEqual({ name: "workspace", id: "p1", tab: "flow", scope: "src/a b/c#d.ts", line: 7 });
    expect(parseRoute(hrefFile("p1", "src/a.ts"))).toEqual({ name: "workspace", id: "p1", tab: "flow", scope: "src/a.ts" });
  });

  it("keeps the tab a file link is made from, so a Packages link stays on Packages", () => {
    expect(hrefFile("p1", "src/a.ts", 7, "packages")).toBe("#/projects/p1/view/packages?scope=src%2Fa.ts&line=7");
    expect(parseRoute(hrefFile("p1", "src/a.ts", 7, "packages"))).toEqual({ name: "workspace", id: "p1", tab: "packages", scope: "src/a.ts", line: 7 });
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

  it("writes no roots flag: the flow link is the same with or without a roots option", () => {
    expect(hrefView("p1", "flow", { scope: "src" })).toBe("#/projects/p1/view/flow?scope=src");
    expect(hrefView("p1", "flow", { scope: "src/a.py", fn: "src/a.py#run" })).toBe("#/projects/p1/view/flow?scope=src%2Fa.py&fn=src%2Fa.py%23run");
  });

  it("ignores an old roots= flag: the canvas is always the flat grid", () => {
    expect(parseRoute("#/projects/p1/view/flow?scope=src&roots=1")).toEqual({ name: "workspace", id: "p1", tab: "flow", scope: "src" });
    expect(parseRoute("#/projects/p1/view/flow?scope=src&roots=0")).toEqual({ name: "workspace", id: "p1", tab: "flow", scope: "src" });
    expect(parseRoute("#/projects/p1/view/flow?scope=src")).toEqual({ name: "workspace", id: "p1", tab: "flow", scope: "src" });
  });

  it("round-trips a flow link with its scope and function", () => {
    const scope = "src/a b.py";
    const fn = `${scope}#run`;
    expect(parseRoute(hrefView("p1", "flow", { scope, fn }))).toEqual({
      name: "workspace",
      id: "p1",
      tab: "flow",
      scope,
      fn,
    });
  });

  it("still opens the flow tab from the retired mode links, and ignores their mode", () => {
    expect(parseRoute("#/projects/p1/view/flow?scope=src&mode=hierarchy")).toEqual({ name: "workspace", id: "p1", tab: "flow", scope: "src" });
    expect(parseRoute("#/projects/p1/view/flow?scope=src&mode=exec")).toEqual({ name: "workspace", id: "p1", tab: "flow", scope: "src" });
    expect(parseRoute("#/projects/p1/view/flow?scope=src&mode=entries&fn=src%23run")).toEqual({
      name: "workspace",
      id: "p1",
      tab: "flow",
      scope: "src",
      fn: "src#run",
    });
    expect(parseRoute("#/projects/p1/view/flow?scope=src&mode=hierarchy&roots=1")).toEqual({
      name: "workspace",
      id: "p1",
      tab: "flow",
      scope: "src",
    });
  });

  it("sends a lens view to Flow with the same scope, from both lens URLs", () => {
    expect(redirectFor(parseRoute("#/projects/p1/view/lens-execution?scope=src%2Fcore"))).toBe("#/projects/p1/view/flow?scope=src%2Fcore");
    expect(redirectFor(parseRoute("#/projects/p1/lenses/lens-execution"))).toBe("#/projects/p1/view/flow");
  });

  it("does not redirect the four tabs or the project", () => {
    for (const t of ["flow", "system", "pipeline", "packages"]) {
      expect(redirectFor(parseRoute(`#/projects/p1/view/${t}?scope=src`))).toBeUndefined();
    }
    expect(redirectFor(parseRoute("#/projects"))).toBeUndefined();
    expect(redirectFor(parseRoute("#/elsewhere"))).toBeUndefined();
  });

  it("parses the compare links the helpers build", () => {
    expect(parseRoute(hrefView("ab12", "compare", { base: "main~1", head: "HEAD" }))).toEqual({
      name: "workspace",
      id: "ab12",
      tab: "compare",
      scope: "",
      base: "main~1",
      head: "HEAD",
    });
    expect(parseRoute(hrefView("ab12", "compare"))).toEqual({ name: "workspace", id: "ab12", tab: "compare", scope: "" });
  });

  it("treats anything else as unknown", () => {
    expect(parseRoute("#/elsewhere")).toEqual({ name: "unknown" });
    expect(parseRoute("#/projects/ab12/lenses")).toEqual({ name: "unknown" });
    expect(parseRoute("#/projects/ab12/view/flow/extra")).toEqual({ name: "unknown" });
    expect(parseRoute("#/projects/ab12/review/extra")).toEqual({ name: "unknown" });
    expect(parseRoute("#/projects/ab12/compare/extra?base=a")).toEqual({ name: "unknown" });
  });

  it("lists the built-in tabs, and a route to any other tab redirects (see redirectFor)", () => {
    expect([...BUILTIN_TABS]).toEqual(["flow", "system", "pipeline", "packages"]);
  });

  it("parses a legacy arch tab id as its tab (redirectFor sends it to Packages)", () => {
    expect(parseRoute("#/projects/p1/view/arch")).toEqual({ name: "workspace", id: "p1", tab: "arch", scope: "" });
    expect(hrefView("p1", "arch")).toBe("#/projects/p1/view/arch");
  });

  it("parses the system tab as a view, with its scope", () => {
    expect(parseRoute("#/projects/p1/view/system")).toEqual({ name: "workspace", id: "p1", tab: "system", scope: "" });
    expect(parseRoute("#/projects/p1/view/system?scope=src%2Fa")).toEqual({ name: "workspace", id: "p1", tab: "system", scope: "src/a" });
    expect(hrefView("p1", "system", { scope: "src/a" })).toBe("#/projects/p1/view/system?scope=src%2Fa");
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

describe("the content of each tab", () => {
  it("the bare project opens the flow tab", () => {
    expect(parseRoute("#/projects/ab12")).toMatchObject({ tab: "flow" });
    expect(contentOf("flow")).toBe("flow");
  });

  it("system, pipeline and packages draw their own content", () => {
    expect(contentOf("system")).toBe("system");
    expect(contentOf("pipeline")).toBe("pipeline");
    expect(contentOf("packages")).toBe("packages");
  });

  it("drops the full flag of the retired overview page", () => {
    expect(parseRoute("#/projects/ab12/view/overview?full=1")).not.toHaveProperty("full");
  });
});

describe("the retired views redirect to the tabs that replace them", () => {
  it("send Findings and Source to Flow, keeping the scope", () => {
    expect(redirectFor(parseRoute("#/projects/p1/view/findings?scope=src"))).toBe("#/projects/p1/view/flow?scope=src");
    expect(redirectFor(parseRoute("#/projects/p1/view/findings"))).toBe("#/projects/p1/view/flow");
  });

  it("send the Source view to Flow, keeping the file scope and line", () => {
    expect(redirectFor(parseRoute("#/projects/p1/view/source?scope=src%2Fa.ts&line=7"))).toBe("#/projects/p1/view/flow?scope=src%2Fa.ts&line=7");
    expect(redirectFor(parseRoute("#/projects/p1/view/source"))).toBe("#/projects/p1/view/flow");
  });

  it("send the old files URLs to Flow with the file and line", () => {
    expect(redirectFor(parseRoute("#/projects/p1/files/src/app.ts?line=12"))).toBe("#/projects/p1/view/flow?scope=src%2Fapp.ts&line=12");
    expect(redirectFor(parseRoute("#/projects/p1/files"))).toBe("#/projects/p1/view/flow");
  });

  it("send the old review URL to Flow, keeping its scope", () => {
    expect(redirectFor(parseRoute("#/projects/p1/review"))).toBe("#/projects/p1/view/flow");
    expect(redirectFor(parseRoute("#/projects/p1/view/review?scope=src"))).toBe("#/projects/p1/view/flow?scope=src");
  });

  it("send a compare URL with base and head to Flow, dropping base and head", () => {
    expect(redirectFor(parseRoute("#/projects/p1/compare?base=aaa&head=bbb"))).toBe("#/projects/p1/view/flow");
    expect(redirectFor(parseRoute("#/projects/p1/view/compare?base=aaa&head=bbb"))).toBe("#/projects/p1/view/flow");
  });

  it("send Arch to Packages and every other retired view to Flow", () => {
    expect(redirectFor(parseRoute("#/projects/p1/view/arch?scope=packages%2Fcore"))).toBe("#/projects/p1/view/packages?scope=packages%2Fcore");
    expect(redirectFor(parseRoute("#/projects/p1/view/compare"))).toBe("#/projects/p1/view/flow");
    expect(redirectFor(parseRoute("#/projects/p1/view/triage?scope=packages%2Fcore"))).toBe("#/projects/p1/view/flow?scope=packages%2Fcore");
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
    expect(parseRoute(href)).toEqual({ name: "workspace", id: "p1", tab: "flow", scope: "src/a.ts", fn: "src/a.ts#run", kind: "unreachable" });
    expect(parseRoute(hrefView("p1", "flow"))).not.toHaveProperty("kind");
  });
});
