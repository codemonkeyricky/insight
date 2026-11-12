import { describe, expect, it } from "vitest";
import type { ArchFile, ArchFileImport, ArchModel } from "@insight/model";
import { aggregateFolderEdges, chooseFolderDepth, diagramModel, folderOf, folderView } from "../src/arch/folders";
import { ARCH_LOOP_ROOM, archLayout, arrowWidth } from "../src/arch/layout";

const span = (file: string, line: number) => ({ file, start: [line, 0] as [number, number], end: [line, 10] as [number, number] });
const f = (path: string, functions = 0): ArchFile => ({ path, functions });

describe("folderOf", () => {
  it("takes the first directories of a file, and the root for a file at the root", () => {
    expect(folderOf("src/parts/gear.ts", 1)).toBe("src");
    expect(folderOf("src/parts/gear.ts", 2)).toBe("src/parts");
    expect(folderOf("src/parts/gear.ts", 5)).toBe("src/parts");
    expect(folderOf("package.json", 1)).toBe(".");
  });
});

describe("chooseFolderDepth", () => {
  it("counts only folders that hold code", () => {
    // Depth 1: "src" and "scripts" hold code, "parts" and "samples" do not: two code folders, not enough.
    // Depth 2: "src/sub1", "src/sub2" and "scripts" hold code: three.
    const files = [f("src/sub1/a.ts", 2), f("src/sub2/b.ts", 1), f("scripts/s.ts", 1), f("parts/p.json"), f("samples/d.json")];
    expect(chooseFolderDepth(files)).toBe(2);
  });

  it("picks the shallowest depth with at least three code folders", () => {
    const files = [f("parts/a.ts", 1), f("src/x.ts", 1), f("scripts/y.ts", 1)];
    expect(chooseFolderDepth(files)).toBe(1);
  });

  it("falls back to the deepest depth when no depth gives three code folders", () => {
    expect(chooseFolderDepth([f("a/b/c/x.ts", 1), f("a/b/y.ts", 1)])).toBe(3);
  });

  it("counts every folder when the project has no code", () => {
    expect(chooseFolderDepth([f("a/x.json"), f("b/y.json"), f("c/z.json")])).toBe(1);
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
  // "src" holds code directly (its App file) and in three subfolders; "scripts" holds code; the rest hold none.
  const model: ArchModel = {
    layers: ["root"],
    packages: [{ id: ".", name: ".", path: ".", layer: "root", fileCount: 2 }],
    edges: [],
    unresolved: [{ fromPackage: ".", text: "../x.json", span: span("scripts/s.ts", 2) }],
    externals: [],
    violations: [],
    files: [
      f("package.json"),
      f("parts/a.json"),
      f("parts/b.json"),
      f("samples/d.json"),
      f("scripts/s.ts", 2),
      f("src/App.ts", 1),
      f("src/parts/p.ts", 3),
      f("src/physics/q.ts", 1),
      f("src/verify/v.ts", 2),
    ],
    fileImports: [
      { from: "scripts/s.ts", to: "src/App.ts", imports: 4, confidence: "exact", sites: [span("scripts/s.ts", 1)] },
      { from: "src/App.ts", to: "src/parts/p.ts", imports: 1, confidence: "exact", sites: [] },
      { from: "parts/a.json", to: "src/physics/q.ts", imports: 1, confidence: "exact", sites: [] },
    ],
  };

  it("makes one card per folder with code, at the depth where three such folders first appear", () => {
    const view = folderView(model);
    expect(view.depth).toBe(2);
    expect(view.model.packages.map((p) => [p.id, p.name, p.fileCount, p.functions])).toEqual([
      ["scripts", "scripts", 1, 2],
      ["src", "src (files)", 1, 1],
      ["src/parts", "src/parts", 1, 3],
      ["src/physics", "src/physics", 1, 1],
      ["src/verify", "src/verify", 1, 2],
    ]);
  });

  it("counts the folders without code under the diagram instead of drawing them", () => {
    expect(folderView(model).other).toBe(3);
  });

  it("aggregates the file imports between cards into folder edges, and drops the rest", () => {
    const { model: folders } = folderView(model);
    // The import from parts/a.json has no card at either end, so it is not an edge.
    expect(folders.edges.map((e) => [e.from, e.to, e.imports])).toEqual([
      ["scripts", "src", 4],
      ["src", "src/parts", 1],
    ]);
  });

  it("remaps unresolved imports to the folder of their file", () => {
    expect(folderView(model).model.unresolved[0]?.fromPackage).toBe("scripts");
  });

  it("draws folders when the project has one package, and the packages when it has enough", () => {
    const shown = diagramModel(model);
    expect(shown.depth).toBe(2);
    expect(shown.other).toBe(3);
    const many = { ...model, packages: [1, 2, 3].map((i) => ({ id: `p${i}`, name: `p${i}`, path: `p${i}`, layer: "other", fileCount: 1 })) };
    expect(diagramModel(many)).toEqual({ other: 0, model: many });
  });

  it("lays the folder cards out left to right in rows, with room for the loops", () => {
    const layout = archLayout(folderView(model).model, { grid: 4 });
    expect(layout.columns).toEqual([]);
    const [first, , , fourth, fifth] = layout.boxes;
    // Four cards in the first row, the fifth wraps to a second row under the first.
    expect(first?.y).toBe(fourth?.y);
    expect(fifth?.x).toBe(first?.x);
    expect((fifth?.y ?? 0) > (first?.y ?? 0)).toBe(true);
    const right = Math.max(...layout.boxes.map((b) => b.x + b.w));
    expect(layout.width - right).toBeGreaterThanOrEqual(ARCH_LOOP_ROOM);
    expect(layout.arrows.map((a) => a.key.split("\0").join(" -> "))).toEqual(["scripts -> src", "src -> src/parts"]);
  });
});
