import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { RevRow, splitFile } from "../src/components/views/FindingsView";
import type { FindingGroup } from "../src/findingGroups";

// The Findings table renders to static markup. A file's basename is its own span so it is never truncated, the examples
// sit in a list inside their cell, and Show in Flow is a ghost link rather than a filled primary button.

const group: FindingGroup = {
  kind: "dead-code",
  lens: "lens-dependencies",
  severity: "warn",
  count: 4,
  template: "{subject} is unused",
  message: "parseLine is unused",
  topFiles: [{ file: "packages/core/src/physics/Simulation.ts", count: 3 }],
  examples: [
    { file: "packages/core/src/physics/Simulation.ts", line: 12, fn: "packages/core/src/physics/Simulation.ts#parseLine", message: "parseLine is unused" },
    { file: "src/index.ts", message: "index is unused" },
  ],
  flowFile: "packages/core/src/physics/Simulation.ts",
  flowFn: undefined,
};

describe("splitFile", () => {
  it("splits a path at its last slash, keeping the slash with the directory", () => {
    expect(splitFile("packages/core/src/physics/Simulation.ts")).toEqual({
      dir: "packages/core/src/physics/",
      base: "Simulation.ts",
    });
  });

  it("gives an empty directory for a bare file name", () => {
    expect(splitFile("README.md")).toEqual({ dir: "", base: "README.md" });
  });
});

describe("RevRow", () => {
  const html = renderToStaticMarkup(<RevRow id="p1" group={group} />);

  it("renders the top file's directory and basename as separate spans, keeping the full path as the title", () => {
    expect(html).toContain('<span class="rv-dir">packages/core/src/physics/</span>');
    expect(html).toContain('<span class="rv-base">Simulation.ts</span>');
    expect(html).toContain('title="packages/core/src/physics/Simulation.ts"');
  });

  it("puts the examples in a list inside the examples cell", () => {
    expect(html).toContain('<div class="rv-examples" role="cell" data-label="Examples"><ul class="rv-ex-list">');
    expect(html.match(/<li>/g)).toHaveLength(2);
    expect(html).not.toMatch(/<ul[^>]*role="cell"/);
  });

  it("gives each example link the single-line class and the full location as its title", () => {
    expect(html).toContain('class="mono small rv-ex"');
    expect(html).toContain('title="packages/core/src/physics/Simulation.ts:12 · parseLine is unused"');
  });

  it("renders Show in Flow as a ghost button, not a primary one", () => {
    expect(html).toContain('class="btn rv-show"');
    expect(html).not.toContain("primary");
  });
});
