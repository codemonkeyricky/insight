import { describe, expect, it } from "vitest";
import { fileTarget, opensCodePane, scopeCodeTarget } from "../src/codeTarget.js";
import { layerLinks } from "../src/components/sheet/shell.js";
import { hrefFile, hrefView, parseRoute, redirectFor } from "../src/router.js";
import type { LensTab } from "../src/scopeLenses.js";

const lenses: LensTab[] = [
  { id: "lens-dependencies", title: "Dependencies", dim: false },
  { id: "lens-lock-order", title: "Lock order", dim: true, reason: "Nothing to show for this scope." },
];

const tabs = (tab: string, noServer: boolean, content: Parameters<typeof layerLinks>[0]["content"] = "lens") =>
  layerLinks({ id: "p1", tab, scope: "src", content, noServer, lenses });

describe("the tab list", () => {
  it("is Overview, Flow, Arch, then one tab per lens, in the order given", () => {
    const links = tabs("overview", true, "flow");
    expect(links.map((l) => l.title)).toEqual(["Overview", "Flow", "Arch", "Dependencies", "Lock order"]);
    expect(links.map((l) => l.group)).toEqual(["page", "page", "page", "lens", "lens"]);
  });

  it("has no Source or Findings tab, in any build", () => {
    for (const noServer of [true, false]) {
      const ids = tabs("overview", noServer, "flow").map((l) => l.id);
      expect(ids).not.toContain("source");
      expect(ids).not.toContain("findings");
    }
  });

  it("adds Compare and Triage only where there is a server, before the lenses", () => {
    expect(tabs("overview", false, "flow").map((l) => l.title)).toEqual([
      "Overview",
      "Flow",
      "Arch",
      "Compare",
      "Triage",
      "Dependencies",
      "Lock order",
    ]);
  });

  it("gives each lens the view URL of its id, so a deep link round-trips", () => {
    const dep = tabs("lens-dependencies", true).find((l) => l.id === "lens-dependencies")!;
    expect(dep.href).toBe("#/projects/p1/view/lens-dependencies?scope=src");
    expect(parseRoute(dep.href)).toEqual({ name: "workspace", id: "p1", tab: "lens-dependencies", scope: "src" });
    expect(dep.current).toBe(true);
    expect(tabs("lens-dependencies", true).filter((l) => l.current).map((l) => l.id)).toEqual(["lens-dependencies"]);
  });

  it("keeps the dim state and reason of a lens with nothing to show", () => {
    const lock = tabs("overview", true, "flow").find((l) => l.id === "lens-lock-order")!;
    expect(lock).toMatchObject({ dim: true, reason: "Nothing to show for this scope.", group: "lens" });
  });

  it("selects Overview on the overview route, full or not, and Flow on the flow route", () => {
    expect(tabs("overview", true, "flow").find((l) => l.id === "overview")!.current).toBe(true);
    expect(tabs("overview", true, "flow").find((l) => l.id === "flow")!.current).toBe(false);
    expect(tabs("flow", true, "flow").find((l) => l.id === "flow")!.current).toBe(true);
    expect(tabs("overview", true, "overview").find((l) => l.id === "overview")!.current).toBe(true);
  });
});

describe("old URLs land safely", () => {
  it("view/findings lands on Overview", () => {
    expect(redirectFor(parseRoute("#/projects/p1/view/findings"))).toBe(hrefView("p1", "overview"));
    expect(redirectFor(parseRoute("#/projects/p1/view/findings?scope=src"))).toBe(hrefView("p1", "overview", { scope: "src" }));
  });

  it("view/source lands on Overview, and a file:line on the code pane at that line", () => {
    const route = parseRoute("#/projects/p1/view/source?scope=src%2Fa.ts&line=7");
    const target = parseRoute(redirectFor(route) as string);
    expect(target).toMatchObject({ name: "workspace", tab: "overview", scope: "src/a.ts", line: 7 });
    expect(opensCodePane(route.name === "workspace" ? route.line : undefined)).toBe(true);
  });
});

describe("a file:line link opens the code pane", () => {
  it("an Arch import site keeps the Arch tab and shows the file at its line", () => {
    const href = hrefFile("p1", "src/core/run.ts", 42, "arch");
    const route = parseRoute(href);
    expect(route).toMatchObject({ name: "workspace", tab: "arch", scope: "src/core/run.ts", line: 42 });
    if (route.name !== "workspace") throw new Error("not a workspace route");
    expect(opensCodePane(route.line)).toBe(true);
    expect(scopeCodeTarget(route.scope, true, route.line)).toEqual(fileTarget("src/core/run.ts", 42));
  });

  it("a flow or lens file link defaults to the flow tab on the file", () => {
    const route = parseRoute(hrefFile("p1", "src/a.ts", 3));
    expect(route).toMatchObject({ tab: "flow", scope: "src/a.ts", line: 3 });
  });

  it("a file with no line sets the code without opening a closed pane", () => {
    const route = parseRoute(hrefFile("p1", "src/a.ts"));
    if (route.name !== "workspace") throw new Error("not a workspace route");
    expect(opensCodePane(route.line)).toBe(false);
    expect(scopeCodeTarget(route.scope, true, route.line)).toEqual(fileTarget("src/a.ts"));
  });
});
