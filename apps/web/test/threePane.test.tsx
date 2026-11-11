import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { FileEntry } from "../src/api";
import { CodeTargetContext, fileTarget, scopeCodeTarget, targetPath, type CodeTarget } from "../src/codeTarget";
import { Explorer } from "../src/components/Explorer";
import { CodePane } from "../src/components/sheet/CodePane";
import { LayerTabs, LensPopover, type LayerLink } from "../src/components/sheet/LayerTabs";
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
    { id: "overview", title: "Overview", href: "#/o", current: true, group: "page" },
    { id: "findings", title: "Findings", href: "#/f", current: false, group: "page", count: 7 },
    { id: "lens-a", title: "Lens A", href: "#/l", current: false, group: "lens" },
    { id: "lens-b", title: "Lens B", href: "#/m", current: false, group: "lens", dim: true, reason: "Not run yet" },
  ];

  it("renders a tablist with the page tabs and one Lenses tab that opens the menu", () => {
    const html = renderToStaticMarkup(<LayerTabs links={links} />);
    expect(html).toContain('role="tablist"');
    // Two page tabs and the Lenses trigger; the lens tabs themselves are in the menu, not the strip.
    expect(html.match(/role="tab"/g)?.length).toBe(3);
    expect(html).toMatch(/aria-selected="true"[^>]*>Overview/);
    expect(html).toMatch(/aria-selected="false"[^>]*>Findings/);
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toMatch(/>Lenses<svg/);
    expect(html).not.toContain('role="menu"');
  });

  it("shows a count only when it is above zero, and a separator before the Lenses tab", () => {
    const html = renderToStaticMarkup(<LayerTabs links={links} />);
    expect(html).toContain('class="badge-count"');
    expect(html).toContain(">7</span>");
    expect(html).toContain("sh-tab-sep");
    const zero = renderToStaticMarkup(<LayerTabs links={[{ ...links[1]!, count: 0 }]} />);
    expect(zero).not.toContain("badge-count");
    // Without any lens there is no Lenses tab and no separator.
    const pagesOnly = renderToStaticMarkup(<LayerTabs links={links.slice(0, 2)} />);
    expect(pagesOnly).not.toContain("Lenses");
    expect(pagesOnly).not.toContain("sh-tab-sep");
  });

  it("names the Lenses tab after the open lens, and selects it while a lens is open", () => {
    const lensOpen = links.map((l) => ({ ...l, current: l.id === "lens-a" }));
    const html = renderToStaticMarkup(<LayerTabs links={lensOpen} />);
    expect(html).toMatch(/>Lenses: Lens A<svg/);
    expect(html).toMatch(/aria-selected="true"[^>]*aria-haspopup="menu"/);
    expect(html).toMatch(/aria-selected="false"[^>]*>Overview/);
  });

  it("renders one menu item per lens with its link, dim state and reason", () => {
    const lensOnly = links.filter((l) => l.group === "lens");
    const html = renderToStaticMarkup(<LensPopover lenses={lensOnly} />);
    expect(html.match(/role="menuitem"/g)?.length).toBe(2);
    expect(html).toContain('href="#/l"');
    expect(html).toContain('href="#/m"');
    expect(html).toMatch(/href="#\/l" class="sh-menu-item"/);
    expect(html).toContain('class="sh-menu-item dim"');
    expect(html).toContain('title="Not run yet"');
  });

  it("marks the current lens in the menu with aria-current", () => {
    const lensOnly = links.filter((l) => l.group === "lens").map((l) => ({ ...l, current: l.id === "lens-b" }));
    const html = renderToStaticMarkup(<LensPopover lenses={lensOnly} />);
    expect(html).toMatch(/aria-current="page"[^>]*href="#\/m"|href="#\/m"[^>]*aria-current="page"/);
    expect(html).not.toMatch(/aria-current="page"[^>]*href="#\/l"|href="#\/l"[^>]*aria-current="page"/);
  });
});

describe("CodePane", () => {
  const common = { id: "p", roots: false, store: {} as ZoomStore, open: true, docked: true, onClose: () => {}, onSlot: () => {} };

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
    const html = renderToStaticMarkup(<Explorer id="p" tab="source" scope="src/a.ts" files={files} />);
    expect(html).toContain('href="#/projects/p/view/source?scope=src%2Fa.ts"');
    expect(html).toMatch(/class="file on"/);
    expect(html).toContain('class="file"');
  });

  it("shows the file the code pane holds as shown, when it is not the scope", () => {
    const html = renderToStaticMarkup(
      <CodeTargetContext.Provider value={{ target: fileTarget("src/b.ts"), showCode: () => {} }}>
        <Explorer id="p" tab="source" scope="" files={files} />
      </CodeTargetContext.Provider>,
    );
    expect(html).toMatch(/class="file shown"[^>]*title="src\/b\.ts"/);
  });

  it("shows the findings count on a file that has findings", () => {
    const html = renderToStaticMarkup(<Explorer id="p" tab="source" scope="" files={files} />);
    expect(html).toContain('title="2 findings"');
  });
});
