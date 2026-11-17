import { describe, expect, it } from "vitest";
import { fileTarget, opensCodePane, scopeCodeTarget } from "../src/codeTarget.js";
import { contentOf, layerLinks } from "../src/components/sheet/shell.js";
import { hrefFile, hrefView, parseRoute, redirectFor } from "../src/router.js";

const tabs = (tab: string, scope = "src") => layerLinks({ id: "p1", tab, scope });

describe("the tab bar", () => {
  it("is exactly Flow, Symbols, System, Pipeline and Packages, in that order", () => {
    expect(tabs("flow").map((l) => l.title)).toEqual(["Flow", "Symbols", "System", "Pipeline", "Packages"]);
    expect(tabs("flow").map((l) => l.id)).toEqual(["flow", "symbols", "system", "pipeline", "packages"]);
  });

  it("marks only the current tab, for each of the four", () => {
    for (const t of ["flow", "symbols", "system", "pipeline", "packages"]) {
      expect(tabs(t).filter((l) => l.current).map((l) => l.id)).toEqual([t]);
    }
  });

  it("links each tab to its view, keeping the scope", () => {
    expect(tabs("flow", "packages/core").map((l) => l.href)).toEqual([
      "#/projects/p1/view/flow?scope=packages%2Fcore",
      "#/projects/p1/view/symbols?scope=packages%2Fcore",
      "#/projects/p1/view/system?scope=packages%2Fcore",
      "#/projects/p1/view/pipeline?scope=packages%2Fcore",
      "#/projects/p1/view/packages?scope=packages%2Fcore",
    ]);
  });

  it("opens Flow for the bare project, and the page of each tab draws its own content", () => {
    expect(parseRoute("#/projects/p1")).toMatchObject({ tab: "flow", scope: "" });
    expect(contentOf("flow")).toBe("flow");
    expect(contentOf("symbols")).toBe("symbols");
    expect(contentOf("system")).toBe("system");
    expect(contentOf("pipeline")).toBe("pipeline");
    expect(contentOf("packages")).toBe("packages");
  });
});

describe("old tab URLs redirect, keeping the scope", () => {
  it("view/arch goes to Packages", () => {
    expect(redirectFor(parseRoute("#/projects/p1/view/arch?scope=packages%2Fcore"))).toBe("#/projects/p1/view/packages?scope=packages%2Fcore");
    expect(redirectFor(parseRoute("#/projects/p1/view/arch"))).toBe("#/projects/p1/view/packages");
  });

  it("view/triage (and the older review link) goes to Flow", () => {
    expect(redirectFor(parseRoute("#/projects/p1/view/triage?scope=packages%2Fcore"))).toBe("#/projects/p1/view/flow?scope=packages%2Fcore");
    expect(redirectFor(parseRoute("#/projects/p1/review"))).toBe("#/projects/p1/view/flow");
  });

  it("view/overview goes to Flow and drops the full flag", () => {
    expect(redirectFor(parseRoute("#/projects/p1/view/overview?scope=src&full=1"))).toBe("#/projects/p1/view/flow?scope=src");
  });

  it("compare goes to Flow and drops its base and head, which Flow ignores", () => {
    expect(redirectFor(parseRoute("#/projects/p1/compare?base=aaa&head=bbb"))).toBe("#/projects/p1/view/flow");
    expect(redirectFor(parseRoute("#/projects/p1/view/compare?scope=src&base=aaa&head=bbb"))).toBe("#/projects/p1/view/flow?scope=src");
  });

  it("every lens view goes to Flow with the same scope", () => {
    expect(redirectFor(parseRoute("#/projects/p1/view/lens-dependencies?scope=src%2Fcore"))).toBe("#/projects/p1/view/flow?scope=src%2Fcore");
    expect(redirectFor(parseRoute("#/projects/p1/lenses/lock-order"))).toBe("#/projects/p1/view/flow");
  });

  it("keeps the line and function of a link through the redirect", () => {
    const route = parseRoute("#/projects/p1/view/triage?scope=src%2Fa.ts&line=7&fn=src%2Fa.ts%23run");
    expect(redirectFor(route)).toBe("#/projects/p1/view/flow?scope=src%2Fa.ts&line=7&fn=src%2Fa.ts%23run");
  });

  it("the findings and source views go to Flow, and a file:line opens the code pane there", () => {
    const route = parseRoute("#/projects/p1/view/source?scope=src%2Fa.ts&line=7");
    const target = parseRoute(redirectFor(route) as string);
    expect(target).toMatchObject({ name: "workspace", tab: "flow", scope: "src/a.ts", line: 7 });
    expect(opensCodePane(route.name === "workspace" ? route.line : undefined)).toBe(true);
    expect(redirectFor(parseRoute("#/projects/p1/view/findings?scope=src"))).toBe("#/projects/p1/view/flow?scope=src");
  });

  it("the four tabs are not redirected", () => {
    for (const t of ["flow", "system", "pipeline", "packages"]) {
      expect(redirectFor(parseRoute(`#/projects/p1/view/${t}?scope=src`))).toBeUndefined();
    }
  });
});

describe("a file:line link opens the code pane", () => {
  it("a Packages import site keeps the Packages tab and shows the file at its line", () => {
    const href = hrefFile("p1", "src/core/run.ts", 42, "packages");
    const route = parseRoute(href);
    expect(route).toMatchObject({ name: "workspace", tab: "packages", scope: "src/core/run.ts", line: 42 });
    if (route.name !== "workspace") throw new Error("not a workspace route");
    expect(opensCodePane(route.line)).toBe(true);
    expect(scopeCodeTarget(route.scope, true, route.line)).toEqual(fileTarget("src/core/run.ts", 42));
  });

  it("a flow file link defaults to the flow tab on the file", () => {
    const route = parseRoute(hrefFile("p1", "src/a.ts", 3));
    expect(route).toMatchObject({ tab: "flow", scope: "src/a.ts", line: 3 });
  });

  it("a file with no line sets the code without opening a closed pane", () => {
    const route = parseRoute(hrefFile("p1", "src/a.ts"));
    if (route.name !== "workspace") throw new Error("not a workspace route");
    expect(opensCodePane(route.line)).toBe(false);
    expect(scopeCodeTarget(route.scope, true, route.line)).toEqual(fileTarget("src/a.ts"));
  });

  it("the system view link keeps its scope", () => {
    expect(hrefView("p1", "system", { scope: "src" })).toBe("#/projects/p1/view/system?scope=src");
  });
});
