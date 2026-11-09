import { describe, expect, it } from "vitest";
import type { ArchFileImport, ArchModel } from "@insight/lens-dependencies";
import { aggregateFolderEdges, chooseFolderDepth, diagramModel, folderOf, folderView } from "../src/arch/folders";
import { ARCH_LOOP_ROOM, archLayout, arrowWidth } from "../src/arch/layout";

const span = (file: string, line: number) => ({ file, start: [line, 0] as [number, number], end: [line, 10] as [number, number] });

describe("folderOf", () => {
  it("takes the first directories of a file, and the root for a file at the root", () => {
    expect(folderOf("src/parts/gear.ts", 1)).toBe("src");
    expect(folderOf("src/parts/gear.ts", 2)).toBe("src/parts");
    expect(folderOf("src/parts/gear.ts", 5)).toBe("src/parts");
    expect(folderOf("package.json", 1)).toBe(".");
  });
});

describe("chooseFolderDepth", () => {
  it("picks the shallowest depth with at least three folders", () => {
    const files = ["parts/a/x.ts", "parts/b/x.ts", "src/x.ts", "scripts/x.ts"];
    expect(chooseFolderDepth(files)).toBe(1);
  });

  it("descends until three folders appear", () => {
    // Depth 1 gives only "src" and "lib": two folders, so depth 2 gives three.
    const files = ["src/parts/a.ts", "src/physics/b.ts", "src/verify/c.ts", "lib/d.ts"];
    expect(chooseFolderDepth(files)).toBe(2);
  });

  it("falls back to the deepest depth when no depth gives three folders", () => {
    expect(chooseFolderDepth(["a/b/c/x.ts", "a/b/y.ts"])).toBe(3);
  });
});

describe("aggregateFolderEdges", () => {
  const imports: ArchFileImport[] = [
    { from: "src/a.ts", to: "parts/p.ts", imports: 2, confidence: "exact", sites: [span("src/a.ts", 1)] },
    { from: "src/b.ts", to: "parts/q.ts", imports: 3, confidence: "inferred", sites: [span("src/b.ts", 4), span("src/b.ts", 4)] },
    { from: "src/a.ts", to: "src/b.ts", imports: 1, confidence: "exact", sites: [] },
  ];
  const folder = (file: string) => folderOf(file, 1);

  it("gives one edge per folder pair, summing imports and dropping imports inside a folder", () => {
    const edges = aggregateFolderEdges(imports, folder);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ from: "src", to: "parts", imports: 5, calls: 0, confidence: "inferred" });
  });

  it("keeps each site once, sorted", () => {
    const [edge] = aggregateFolderEdges(imports, folder);
    expect(edge?.sites).toEqual([span("src/a.ts", 1), span("src/b.ts", 4)]);
  });

  it("draws an edge's width on the log scale of its count", () => {
    const [edge] = aggregateFolderEdges(imports, folder);
    expect(arrowWidth(edge?.imports ?? 0)).toBeCloseTo(1 + Math.log2(5), 5);
  });
});

describe("folderView and diagramModel", () => {
  const model: ArchModel = {
    layers: ["root"],
    packages: [{ id: ".", name: ".", path: ".", layer: "root", fileCount: 6 }],
    edges: [],
    unresolved: [{ fromPackage: ".", text: "../x.json", span: span("scripts/s.ts", 2) }],
    externals: [],
    violations: [],
    files: [
      { path: "package.json", functions: 0 },
      { path: "parts/a.ts", functions: 2 },
      { path: "parts/b.ts", functions: 1 },
      { path: "src/c.ts", functions: 4 },
      { path: "scripts/s.ts", functions: 0 },
      { path: "samples/d.json", functions: 0 },
    ],
    fileImports: [
      { from: "scripts/s.ts", to: "src/c.ts", imports: 4, confidence: "exact", sites: [span("scripts/s.ts", 1)] },
      { from: "src/c.ts", to: "parts/a.ts", imports: 1, confidence: "exact", sites: [] },
    ],
  };

  it("makes one card per top-level folder with its file and function counts", () => {
    const view = folderView(model);
    expect(view.depth).toBe(1);
    expect(view.model.packages.map((p) => [p.id, p.fileCount, p.functions])).toEqual([
      [".", 1, 0],
      ["parts", 2, 3],
      ["samples", 1, 0],
      ["scripts", 1, 0],
      ["src", 1, 4],
    ]);
  });

  it("aggregates the file imports into folder edges and remaps unresolved imports to their folder", () => {
    const { model: folders } = folderView(model);
    expect(folders.edges.map((e) => [e.from, e.to, e.imports])).toEqual([
      ["scripts", "src", 4],
      ["src", "parts", 1],
    ]);
    expect(folders.unresolved[0]?.fromPackage).toBe("scripts");
  });

  it("draws folders when the project has one package, and the packages when it has enough", () => {
    const shown = diagramModel(model);
    expect(shown.depth).toBe(1);
    expect(shown.model.packages).toHaveLength(5);
    const many = { ...model, packages: [1, 2, 3].map((i) => ({ id: `p${i}`, name: `p${i}`, path: `p${i}`, layer: "other", fileCount: 1 })) };
    expect(diagramModel(many)).toEqual({ model: many });
  });

  it("stacks the folder cards in one column, with the imports between them as arrows", () => {
    const layout = archLayout(folderView(model).model);
    expect(layout.columns.map((c) => c.layer)).toEqual(["folders"]);
    expect(layout.boxes.map((b) => b.pkg.name)).toEqual(["(root)", "parts", "samples", "scripts", "src"]);
    expect(layout.arrows.map((a) => a.key.split("\0").join(" -> "))).toEqual(["scripts -> src", "src -> parts"]);
    // The loops of the arrows between cards in one column fit inside the diagram.
    const right = Math.max(...layout.boxes.map((b) => b.x + b.w));
    expect(layout.width - right).toBeGreaterThanOrEqual(ARCH_LOOP_ROOM);
  });
});
