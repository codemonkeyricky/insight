import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { FileEntry } from "../src/api";
import { CodeTargetContext, fileTarget, scopeCodeTarget, targetPath, type CodeTarget } from "../src/codeTarget";
import { Explorer } from "../src/components/Explorer";
import { CodePane } from "../src/components/sheet/CodePane";
import { LayerTabs, type LayerLink } from "../src/components/sheet/LayerTabs";
import type { ZoomStore } from "../src/zoom/scene";

// Static markup only: the vitest setup has no DOM, so effects and click handlers are not run here. The explorer's click
// (which shows the file in the code pane) is checked in the browser run, not in these tests.

const file = (path: string, findings = 0): FileEntry => ({ path, findings, lines: 10, functions: 0 } as unknown as FileEntry);

describe("code target", () => {
  it("a file target keeps a positive line and drops a zero or missing one", () => {
    expect(fileTarget("a.ts", 12)).toEqual({ kind: "file", path: "a.ts", line: 12 });
    expect(fileTarget("a.ts", 0)).toEqual({ kind: "file", path: "a.ts" });
    expect(fileTarget("a.ts")).toEqual({ kind: "file", path: "a.ts" });
  });

  it("a function target shows the file of its definition, or nothing when the IR has none", () => {
    const sel = (file: string | null) => ({ selected: { id: "x#f", name: "f", file, line: 3 } }) as never;
    expect(targetPath({ kind: "function", sel: sel("src/a.ts") })).toBe("src/a.ts");
    expect(targetPath({ kind: "function", sel: sel(null) })).toBe("");
  });

  it("a file scope sets the target, a folder or the project sets none", () => {
    expect(scopeCodeTarget("src/a.ts", true, 4)).toEqual({ kind: "file", path: "src/a.ts", line: 4 });
    expect(scopeCodeTarget("src", false)).toBeUndefined();
    expect(scopeCodeTarget("", true)).toBeUndefined();
  });
});

describe("LayerTabs", () => {
  const links: LayerLink[] = [
    { id: "flow", title: "Flow", href: "#/fl", current: true },
    { id: "system", title: "System", href: "#/sy", current: false },
    { id: "pipeline", title: "Pipeline", href: "#/pi", current: false },
    { id: "packages", title: "Packages", href: "#/pa", current: false },
  ];

  it("renders one tab per page, in one tablist, with no Lenses menu", () => {
    const html = renderToStaticMarkup(<LayerTabs links={links} />);
    expect(html).toContain('role="tablist"');
    expect(html.match(/role="tab"/g)?.length).toBe(4);
    expect(html).toMatch(/aria-selected="true"[^>]*>Flow</);
    expect(html).toMatch(/href="#\/sy"[^>]*class="sh-tab"[^>]*>System</);
    expect(html).not.toContain("aria-haspopup");
    expect(html).not.toContain('role="menu"');
    expect(html).not.toContain("Lenses");
    expect(html).not.toContain("sh-tab-sep");
  });

  it("selects the current tab and keeps the order it was given", () => {
    const packagesOpen = links.map((l) => ({ ...l, current: l.id === "packages" }));
    const html = renderToStaticMarkup(<LayerTabs links={packagesOpen} />);
    expect(html).toMatch(/aria-selected="true"[^>]*>Packages</);
    expect(html).toMatch(/aria-selected="false"[^>]*>Flow</);
    expect(html.indexOf(">Flow<")).toBeLessThan(html.indexOf(">Packages<"));
  });
});

describe("CodePane", () => {
  const common = { id: "p", store: {} as ZoomStore, open: true, docked: true, onClose: () => {}, onSlot: () => {} };

  it("shows the empty state before anything is picked", () => {
    const html = renderToStaticMarkup(<CodePane {...common} target={undefined} />);
    expect(html).toContain("Click a file or function to see its code.");
    expect(html).toContain('id="sh-code"');
    expect(html).toContain("is-docked");
    expect(html).toContain('class="sh-slot"');
  });

  it("names a picked function and its location in the header row", () => {
    const sel = { build: { path: "src/a.ts" }, selected: { ref: "src/a.ts#f", name: "f", file: "src/a.ts", line: 3 } } as never;
    const html = renderToStaticMarkup(<CodePane {...common} target={{ kind: "function", sel }} />);
    expect(html).toContain("sh-dock-head");
    expect(html).toContain("src/a.ts:3");
    expect(html).not.toContain("Click a file or function");
  });

  it("does not render the empty state once a file is picked", () => {
    const html = renderToStaticMarkup(<CodePane {...common} target={fileTarget("src/a.ts", 3)} />);
    expect(html).not.toContain("Click a file or function");
  });
});

describe("Explorer", () => {
  const files = [file("src/a.ts"), file("src/b.ts", 2), file("README.md")];

  it("renders each file as a link to its scope, with the scope's file marked on", () => {
    const html = renderToStaticMarkup(<Explorer id="p" tab="flow" scope="src/a.ts" files={files} />);
    expect(html).toContain('href="#/projects/p/view/flow?scope=src%2Fa.ts"');
    expect(html).toMatch(/class="file on"/);
    expect(html).toContain('class="file"');
  });

  it("shows the file the code pane holds as shown, when it is not the scope", () => {
    const html = renderToStaticMarkup(
      <CodeTargetContext.Provider value={{ target: fileTarget("src/b.ts"), showCode: () => {} }}>
        <Explorer id="p" tab="flow" scope="" files={files} />
      </CodeTargetContext.Provider>,
    );
    expect(html).toMatch(/class="file shown"[^>]*title="src\/b\.ts"/);
  });

  it("shows the findings count on a file that has findings", () => {
    const html = renderToStaticMarkup(<Explorer id="p" tab="flow" scope="" files={files} />);
    expect(html).toContain('title="2 findings"');
  });

  // The filter's typing and keys run in the browser; with no filter typed, the static markup is the tree and no result list.
  it("shows the tree, the filter placeholder and no result list when nothing is typed", () => {
    const html = renderToStaticMarkup(<Explorer id="p" tab="flow" scope="" files={files} />);
    expect(html).toContain('placeholder="Filter 3 files"');
    expect(html).toContain('class="dir"');
    expect(html).not.toContain("fuzzy-results");
    expect(html).not.toContain("Showing top");
  });
});
