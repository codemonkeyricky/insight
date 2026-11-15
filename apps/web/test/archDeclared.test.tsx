import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ArchModel } from "@insight/model";
import { archLayout, arrowKey, declaredNote } from "../src/arch/layout.js";
import { Panel } from "../src/components/views/ArchView";

const pkg = (id: string, layer: string) => ({ id, name: id, path: id, layer, fileCount: 1 });

/** Three arrows: declared-only (dotted), used but undeclared (warning), and no build deps at all (unset). */
const declaredModel = (): ArchModel => ({
  layers: ["app", "ir"],
  packages: [pkg("app", "app"), pkg("lib", "ir"), pkg("util", "ir")],
  edges: [
    { from: "app", to: "lib", imports: 0, calls: 0, confidence: "exact", sites: [], declared: true },
    { from: "app", to: "util", imports: 3, calls: 0, confidence: "exact", sites: [], declared: false },
    { from: "lib", to: "util", imports: 2, calls: 0, confidence: "exact", sites: [] },
  ],
  unresolved: [],
  externals: [],
  externalPackages: [],
  violations: [],
  files: [],
  fileImports: [],
});

const plainModel = (): ArchModel => ({ ...declaredModel(), edges: declaredModel().edges.map(({ declared: _d, ...e }) => e) });

const arrowOf = (model: ArchModel, from: string, to: string) => {
  const arrow = archLayout(model).arrows.find((a) => a.key === arrowKey(from, to));
  if (!arrow) throw new Error(`no arrow ${from} -> ${to}`);
  return arrow;
};

describe("arch arrows for declared and undeclared edges", () => {
  it("flags a declared-only edge (declared, no imports or calls) as dotted", () => {
    const a = arrowOf(declaredModel(), "app", "lib");
    expect(a.declaredOnly).toBe(true);
    expect(a.undeclared).toBe(false);
  });

  it("flags a used edge that no build target declares as undeclared, and not declared-only", () => {
    const a = arrowOf(declaredModel(), "app", "util");
    expect(a.undeclared).toBe(true);
    expect(a.declaredOnly).toBe(false);
  });

  it("leaves both flags off an edge whose declared field is unset", () => {
    const a = arrowOf(plainModel(), "lib", "util");
    expect(a.declaredOnly).toBe(false);
    expect(a.undeclared).toBe(false);
  });

  it("adds a declared or not-declared note to the arrow's title only when the field is set", () => {
    expect(declaredNote({ declared: true })).toBe(", declared");
    expect(declaredNote({ declared: false })).toBe(", not declared in the build");
    expect(declaredNote({})).toBe("");
  });
});

describe("Panel legend and externals", () => {
  const panel = (model: ArchModel, externalsOf?: string) =>
    renderToStaticMarkup(<Panel id="p" model={model} sel={null} externalsOf={externalsOf} />);

  it("describes the declared styles in the legend only when the model has declared edges", () => {
    expect(panel(declaredModel())).toContain("Dotted arrows are declared in the build");
    expect(panel(declaredModel())).toContain("orange arrows are used but not declared");
    const plain = panel(plainModel());
    expect(plain).toContain("Dashed arrows are inferred");
    expect(plain).not.toContain("Dotted arrows");
  });

  it("shows a version chip and a declared mark on externals that carry them", () => {
    const model: ArchModel = {
      ...plainModel(),
      externals: [{ fromPackage: "lib", name: "abseil-cpp", imports: 0, id: "@abseil-cpp", version: "20240116.2", declared: true }],
    };
    const html = panel(model, "lib");
    expect(html).toContain('<span class="arch-chip mono small">20240116.2</span>');
    expect(html).toContain('<span class="arch-badge small">declared</span>');
  });

  it("draws the externals of a model with no declared fields with no chips or marks", () => {
    const model: ArchModel = { ...plainModel(), externals: [{ fromPackage: "lib", name: "zlib", imports: 2 }] };
    const html = panel(model, "lib");
    expect(html).toContain('<span class="mono small">zlib</span> 2 imports');
    expect(html).not.toContain("arch-chip");
    expect(html).not.toContain("arch-badge");
  });
});

describe("External packages section", () => {
  const withPackages = (): ArchModel => ({
    ...plainModel(),
    externalPackages: [
      { id: "@zlib", name: "zlib", source: "bzlmod", manager: "bzlmod", version: "1.3", dev: true },
      { id: "@abseil-cpp", name: "abseil-cpp", source: "bzlmod", manager: "bzlmod", override: "local_path" },
      { id: "react", name: "react", source: "npm", manager: "npm", version: "19.3.1" },
    ],
  });

  it("is shown only when the project declares external packages", () => {
    const html = renderToStaticMarkup(<Panel id="p" model={plainModel()} sel={null} />);
    expect(html).not.toContain("External packages (");
  });

  it("groups the packages by manager, sorted by name, with version, dev, override and source badges", () => {
    const html = renderToStaticMarkup(<Panel id="p" model={withPackages()} sel={null} />);
    expect(html).toContain("External packages (3)");
    const bzlmod = html.indexOf(">bzlmod<");
    const npm = html.indexOf(">npm<");
    expect(bzlmod).toBeGreaterThan(-1);
    expect(npm).toBeGreaterThan(bzlmod);
    const abseil = html.indexOf(">abseil-cpp<");
    const zlib = html.indexOf(">zlib<");
    expect(abseil).toBeGreaterThan(bzlmod);
    expect(zlib).toBeGreaterThan(abseil);
    expect(html).toContain('<span class="arch-badge small">dev</span>');
    expect(html).toContain('<span class="arch-badge small">override: local_path</span>');
    expect(html).toContain('<span class="arch-badge small">bzlmod</span>');
    expect(html).toContain('<span class="arch-chip mono small">19.3.1</span>');
  });
});
