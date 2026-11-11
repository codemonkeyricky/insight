import { describe, expect, it } from "vitest";
import type { ArchEdge, ArchFile, ArchFileImport, ArchModel, ArchPackage } from "@insight/lens-dependencies";
import { bandPerRow, IMPORTED_BY, IMPORTS, scopedView } from "../src/arch/scoped.js";

const span = (file: string, line: number) => ({ file, start: [line, 0] as [number, number], end: [line, 10] as [number, number] });
const pkg = (id: string, layer: string, fileCount: number): ArchPackage => ({ id, name: id.split("/").pop() ?? id, path: id, layer, fileCount });
const imp = (from: string, to: string, imports: number, confidence: ArchFileImport["confidence"], sites: ReturnType<typeof span>[]): ArchFileImport => ({
  from,
  to,
  imports,
  confidence,
  sites,
});
const edge = (from: string, to: string, imports: number, confidence: ArchEdge["confidence"], sites: ReturnType<typeof span>[], calls = 0): ArchEdge => ({
  from,
  to,
  imports,
  calls,
  confidence,
  sites,
});

const LENS = "packages/lens-dependencies";
const CORE = "packages/core";
const MODEL = "packages/model";
const WEB = "apps/web";

const files: ArchFile[] = [
  { path: "README.md", functions: 0 },
  { path: `${CORE}/src/index.ts`, functions: 0 },
  { path: `${CORE}/src/types.ts`, functions: 1 },
  { path: `${LENS}/src/a.ts`, functions: 2 },
  { path: `${LENS}/src/index.ts`, functions: 0 },
  { path: `${LENS}/src/sub/b.ts`, functions: 1 },
  { path: `${LENS}/src/sub2/c.ts`, functions: 1 },
  { path: `${LENS}/test/t.ts`, functions: 0 },
  { path: `${MODEL}/src/index.ts`, functions: 1 },
  { path: `${MODEL}/src/m.ts`, functions: 1 },
  { path: `${WEB}/src/main.ts`, functions: 0 },
  { path: `${WEB}/src/view.ts`, functions: 1 },
];

/** A project of four packages: lens-dependencies has folders with code, the others are the packages around it. */
const model: ArchModel = {
  layers: ["ir", "lens", "app"],
  packages: [pkg(CORE, "ir", 2), pkg(LENS, "lens", 6), pkg(MODEL, "ir", 2), pkg(WEB, "app", 2)],
  edges: [
    // Not an import site of any file: calls only, so it cannot be drawn.
    edge(LENS, WEB, 0, "exact", [], 1),
    // A workspace import from lens-dependencies to model, with a site no file import has.
    edge(LENS, MODEL, 1, "inferred", [span(`${LENS}/src/sub/b.ts`, 9)]),
    // Both sites are file imports already: nothing is added for this edge.
    edge(LENS, CORE, 3, "inferred", [span(`${LENS}/src/a.ts`, 4), span(`${LENS}/src/a.ts`, 6)]),
    // An import into lens-dependencies from model: one site is a file import (skipped), one is not.
    edge(MODEL, LENS, 2, "exact", [span(`${MODEL}/src/index.ts`, 1), span(`${MODEL}/src/m.ts`, 2)]),
    edge(WEB, CORE, 1, "exact", [span(`${WEB}/src/view.ts`, 3)]),
  ],
  unresolved: [
    { fromPackage: LENS, text: "../gone", span: span(`${LENS}/src/a.ts`, 3) },
    { fromPackage: WEB, text: "./nope", span: span(`${WEB}/src/view.ts`, 5) },
  ],
  externals: [
    { fromPackage: LENS, name: "zod", imports: 2 },
    { fromPackage: WEB, name: "react", imports: 9 },
  ],
  violations: [
    { from: LENS, to: WEB, rule: "lenses never import frontends", sites: [] },
    { from: WEB, to: CORE, rule: "unrelated", sites: [] },
  ],
  files,
  fileImports: [
    imp(`${LENS}/src/sub/b.ts`, `${LENS}/src/a.ts`, 2, "exact", [span(`${LENS}/src/sub/b.ts`, 1)]),
    imp(`${LENS}/src/sub2/c.ts`, `${LENS}/src/sub/b.ts`, 1, "exact", [span(`${LENS}/src/sub2/c.ts`, 2)]),
    imp(`${LENS}/src/a.ts`, `${CORE}/src/types.ts`, 3, "inferred", [span(`${LENS}/src/a.ts`, 4), span(`${LENS}/src/a.ts`, 6)]),
    imp(`${MODEL}/src/m.ts`, `${LENS}/src/sub2/c.ts`, 1, "exact", [span(`${MODEL}/src/m.ts`, 2)]),
    // Outside to outside: not part of the lens-dependencies diagram.
    imp(`${WEB}/src/view.ts`, `${CORE}/src/types.ts`, 1, "exact", [span(`${WEB}/src/view.ts`, 3)]),
  ],
};

describe("scopedView", () => {
  it("returns null for the root scope, and for a file at the root", () => {
    expect(scopedView(model, "")).toBeNull();
    expect(scopedView(model, "README.md")).toBeNull();
  });

  it("draws a package with subfolders as folder cards, with the edges between them", () => {
    const view = scopedView(model, LENS);
    expect(view).not.toBeNull();
    if (!view) return;
    expect(view.cards).toBe("folders");
    expect(view.depth).toBe(2);
    expect(view.inner).toBe("Inside lens-dependencies");
    expect(view.pkg?.id).toBe(LENS);
    // The folders with code: src (its own files, beside its subfolders), src/sub and src/sub2. test has no code.
    const inner = view.model.packages.filter((p) => p.layer === view.inner);
    expect(inner.map((p) => [p.id, p.name, p.functions])).toEqual([
      [`${LENS}/src`, "src (files)", 2],
      [`${LENS}/src/sub`, "src/sub", 1],
      [`${LENS}/src/sub2`, "src/sub2", 1],
    ]);
    expect(view.other).toBe(1);
    const inside = view.model.edges.filter((e) => !e.from.startsWith("in:") && !e.from.startsWith("out:") && !e.to.startsWith("out:"));
    expect(inside.map((e) => [e.from, e.to, e.imports])).toEqual([
      [`${LENS}/src/sub`, `${LENS}/src`, 2],
      [`${LENS}/src/sub2`, `${LENS}/src/sub`, 1],
    ]);
  });

  it("gives a flat package one card per file, with the edges between the files", () => {
    const flat: ArchModel = {
      ...model,
      files: [
        { path: "packages/small/s/a.ts", functions: 1 },
        { path: "packages/small/s/b.ts", functions: 1 },
      ],
      packages: [pkg("packages/small", "lens", 2)],
      edges: [],
      unresolved: [],
      externals: [],
      violations: [],
      fileImports: [imp("packages/small/s/b.ts", "packages/small/s/a.ts", 4, "exact", [span("packages/small/s/b.ts", 1)])],
    };
    const view = scopedView(flat, "packages/small/s");
    expect(view?.cards).toBe("files");
    expect(view?.depth).toBeUndefined();
    expect(view?.model.packages.map((p) => [p.id, p.name, p.fileCount, p.functions])).toEqual([
      ["packages/small/s/a.ts", "a.ts", 1, 1],
      ["packages/small/s/b.ts", "b.ts", 1, 1],
    ]);
    expect(view?.model.edges.map((e) => [e.from, e.to, e.imports])).toEqual([["packages/small/s/b.ts", "packages/small/s/a.ts", 4]]);
  });

  it("draws an outgoing workspace edge with sites as card -> out:package", () => {
    const view = scopedView(model, LENS);
    const out = view?.model.edges.find((e) => e.to === `out:${MODEL}`);
    expect(out).toMatchObject({ from: `${LENS}/src/sub`, to: `out:${MODEL}`, imports: 1, confidence: "inferred", calls: 0 });
    expect(view?.model.packages.find((p) => p.id === `out:${MODEL}`)).toMatchObject({ layer: IMPORTS, name: "model", fileCount: 2 });
  });

  it("does not count a site twice when it is also a file import", () => {
    const view = scopedView(model, LENS);
    // a.ts imports two sites in core as file imports (3 imports). The package edge to core repeats both sites: nothing added.
    const core = view?.model.edges.find((e) => e.to === `out:${CORE}`);
    expect(core).toMatchObject({ from: `${LENS}/src`, imports: 3, confidence: "inferred" });
  });

  it("lands an incoming edge on the entry file's card, and counts only the sites that are not file imports", () => {
    const view = scopedView(model, LENS);
    const incoming = view?.model.edges.filter((e) => e.from === `in:${MODEL}`);
    // Two edges from model: its file import into sub2 (1), and its package edge into the entry index.ts, which is the src card (1 site).
    expect(incoming?.map((e) => [e.to, e.imports]).sort()).toEqual(
      [
        [`${LENS}/src`, 1],
        [`${LENS}/src/sub2`, 1],
      ].sort(),
    );
    expect(view?.model.packages.find((p) => p.id === `in:${MODEL}`)).toMatchObject({ layer: IMPORTED_BY, name: "model" });
  });

  it("names a sibling folder on the other side when the scope is a subfolder of its package", () => {
    const view = scopedView(model, `${LENS}/src/sub`);
    expect(view?.pkg?.id).toBe(LENS);
    expect(view?.cards).toBe("files");
    // out:model is the workspace import in b.ts (line 9). out:core is not here: a.ts is not in this scope.
    expect(view?.model.packages.map((p) => p.id)).toEqual([
      `in:${LENS}/src/sub2`,
      `out:${LENS}/src`,
      `out:${MODEL}`,
      `${LENS}/src/sub/b.ts`,
    ]);
    expect(view?.model.layers).toEqual([IMPORTED_BY, "Inside sub", IMPORTS]);
    const outward = view?.model.edges.find((e) => e.to === `out:${LENS}/src`);
    expect(outward).toMatchObject({ from: `${LENS}/src/sub/b.ts`, imports: 2 });
    const inward = view?.model.edges.find((e) => e.from === `in:${LENS}/src/sub2`);
    expect(inward).toMatchObject({ to: `${LENS}/src/sub/b.ts`, imports: 1 });
  });

  it("scopes a file to its folder, and says so", () => {
    const view = scopedView(model, `${LENS}/src/a.ts`);
    expect(view?.scope).toBe(`${LENS}/src`);
    expect(view?.fromFile).toBe(`${LENS}/src/a.ts`);
  });

  it("keeps only the unresolved imports inside the scope", () => {
    const view = scopedView(model, LENS);
    expect(view?.model.unresolved).toEqual([{ fromPackage: LENS, text: "../gone", span: span(`${LENS}/src/a.ts`, 3) }]);
  });

  it("keeps the package's own externals and the violations that touch it", () => {
    const view = scopedView(model, LENS);
    expect(view?.model.externals).toEqual([{ fromPackage: LENS, name: "zod", imports: 2 }]);
    expect(view?.model.violations.map((v) => `${v.from}->${v.to}`)).toEqual([`${LENS}->${WEB}`]);
  });

  it("counts the package edges with no import site as not drawn", () => {
    expect(scopedView(model, LENS)?.notDrawn).toBe(1);
  });

  it("gives a scope with no source files no inner cards", () => {
    const view = scopedView(model, "apps/nothing");
    expect(view).not.toBeNull();
    expect(view?.scope).toBe("apps/nothing");
    expect(view?.model.packages).toEqual([]);
    expect(view?.model.edges).toEqual([]);
    expect(view?.pkg).toBeUndefined();
  });

  it("sorts the cards by id and the edges by from then to", () => {
    const view = scopedView(model, LENS);
    const ids = view?.model.packages.map((p) => p.id) ?? [];
    expect(ids).toEqual([...ids].sort((a, b) => a.localeCompare(b)));
    const edges = view?.model.edges ?? [];
    const sorted = [...edges].sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
    expect(edges.map((e) => [e.from, e.to])).toEqual(sorted.map((e) => [e.from, e.to]));
  });
});

describe("scopedView names and non-code files", () => {
  const flat: ArchModel = {
    layers: ["lens"],
    packages: [pkg("packages/flat", "lens", 5)],
    edges: [],
    unresolved: [],
    externals: [],
    violations: [],
    files: [
      { path: "packages/flat/package.json", functions: 0 },
      { path: "packages/flat/tsconfig.json", functions: 0 },
      { path: "packages/flat/src/a.ts", functions: 1 },
      { path: "packages/flat/src/b.ts", functions: 1 },
      { path: "packages/flat/src/index.ts", functions: 0 },
    ],
    // index.ts has no functions but imports a.ts, so it is drawn.
    fileImports: [imp("packages/flat/src/index.ts", "packages/flat/src/a.ts", 1, "exact", [span("packages/flat/src/index.ts", 1)])],
  };

  it("draws no card for a file without code that no import reaches, and counts it", () => {
    const view = scopedView(flat, "packages/flat");
    expect(view?.cards).toBe("files");
    expect(view?.model.packages.map((p) => p.id)).toEqual([
      "packages/flat/src/a.ts",
      "packages/flat/src/b.ts",
      "packages/flat/src/index.ts",
    ]);
    expect(view?.other).toBe(2);
  });

  it("keeps a file without code that has an import edge", () => {
    const view = scopedView(flat, "packages/flat");
    expect(view?.model.edges.map((e) => [e.from, e.to])).toEqual([["packages/flat/src/index.ts", "packages/flat/src/a.ts"]]);
  });

  it("names the root package's boundary card 'project root'", () => {
    const root: ArchModel = {
      layers: ["app", "lens"],
      packages: [
        { id: ".", name: ".", path: ".", layer: "app", fileCount: 1 },
        { id: "packages/x", name: "x", path: "packages/x", layer: "lens", fileCount: 2 },
      ],
      edges: [],
      unresolved: [],
      externals: [],
      violations: [],
      files: [
        { path: "scripts/s.ts", functions: 1 },
        { path: "packages/x/src/a.ts", functions: 1 },
      ],
      fileImports: [imp("scripts/s.ts", "packages/x/src/a.ts", 1, "exact", [span("scripts/s.ts", 1)])],
    };
    const view = scopedView(root, "packages/x");
    expect(view?.model.packages.find((p) => p.id === "in:.")).toMatchObject({ name: "project root", layer: IMPORTED_BY });
  });

  it("names a sibling folder by its path inside the package, with the full path as its id", () => {
    const view = scopedView(model, `${LENS}/src/sub`);
    expect(view?.model.packages.find((p) => p.id === `out:${LENS}/src`)).toMatchObject({ name: "src", path: `${LENS}/src` });
    expect(view?.model.packages.find((p) => p.id === `in:${LENS}/src/sub2`)).toMatchObject({ name: "src/sub2" });
  });

  it("names a boundary package by its name", () => {
    const view = scopedView(model, LENS);
    expect(view?.model.packages.find((p) => p.id === `out:${CORE}`)).toMatchObject({ name: "core" });
  });
});

describe("bandPerRow", () => {
  it("is two cards wide from 1400 px, one below it", () => {
    expect(bandPerRow(1399)).toBe(1);
    expect(bandPerRow(1400)).toBe(2);
    expect(bandPerRow(846)).toBe(1);
    expect(bandPerRow(0)).toBe(1);
  });
});
