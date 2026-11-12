import { describe, expect, it } from "vitest";
import { irFixtures as fx } from "@insight/sdk";
import { archModel, defaultLayerOf } from "../src/index.js";

const sp = (file: string) => fx.span(file, 0, 0, 0, 20);
const file = (path: string) => fx.node(path, "structure", "structure.file");
const pkg = (dir: string) => file(`${dir}/package.json`);

describe("archModel", () => {
  it("assigns each package a layer from its path, and puts unknown packages in other", () => {
    const view = fx.view({
      nodes: [
        pkg("packages/frontend-typescript"),
        file("packages/frontend-typescript/src/a.ts"),
        pkg("packages/lens-calls"),
        file("packages/lens-calls/src/a.ts"),
        file("packages/lens-calls/src/b.ts"),
        pkg("packages/core/ir"),
        file("packages/core/ir/src/a.ts"),
        pkg("apps/web"),
        file("apps/web/src/a.ts"),
        pkg("apps/cli"),
        file("apps/cli/src/a.ts"),
      ],
    });
    const model = archModel(view);
    const layerOf = Object.fromEntries(model.packages.map((p) => [p.path, p.layer]));
    expect(layerOf).toEqual({
      "apps/web": "app",
      "apps/cli": "app",
      "packages/frontend-typescript": "frontend",
      "packages/core/ir": "ir",
      "packages/lens-calls": "lens",
    });
    expect(model.layers).toEqual(["project", "frontend", "ir", "lens", "app"]);
    expect(model.packages.find((p) => p.path === "packages/lens-calls")?.fileCount).toBe(3);
    expect(() => JSON.parse(JSON.stringify(model))).not.toThrow();
  });

  it("puts frontends grouped under packages/frontend/ in the frontend layer", () => {
    const view = fx.view({
      nodes: [
        pkg("packages/frontend/typescript"),
        file("packages/frontend/typescript/src/a.ts"),
        pkg("packages/frontend/cpp"),
        file("packages/frontend/cpp/src/a.ts"),
      ],
    });
    const layerOf = Object.fromEntries(archModel(view).packages.map((p) => [p.path, p.layer]));
    expect(layerOf).toEqual({
      "packages/frontend/typescript": "frontend",
      "packages/frontend/cpp": "frontend",
    });
  });

  it("layers packages/lens/* as lenses and the packages/core/* kernel group as ir", () => {
    expect(defaultLayerOf("packages/core/flow")).toBe("ir");
    expect(defaultLayerOf("packages/core/indexer")).toBe("ir");
    expect(defaultLayerOf("packages/core")).toBe("ir");
    expect(defaultLayerOf("packages/lens/calls")).toBe("lens");
    expect(defaultLayerOf("packages/lens-calls")).toBe("lens");
  });

  it("reports a lens importing a frontend as one violation with its site", () => {
    const site = fx.span("packages/lens-calls/src/a.ts", 3, 0, 3, 40);
    const view = fx.view({
      nodes: [
        pkg("packages/lens-calls"),
        file("packages/lens-calls/src/a.ts"),
        pkg("packages/frontend-typescript"),
        file("packages/frontend-typescript/src/b.ts"),
      ],
      edges: [
        fx.edge("packages/lens-calls/src/a.ts", "packages/frontend-typescript/src/b.ts", "packaging", "packaging.import", { span: site }),
      ],
    });
    const model = archModel(view);
    expect(model.violations).toHaveLength(1);
    expect(model.violations[0]).toEqual({
      from: "packages/lens-calls",
      to: "packages/frontend-typescript",
      rule: "frontends and lenses never import each other",
      sites: [site],
    });
  });

  it("reports no violation for a frontend importing the ir package", () => {
    const view = fx.view({
      nodes: [
        pkg("packages/frontend-typescript"),
        file("packages/frontend-typescript/src/a.ts"),
        pkg("packages/core/ir"),
        file("packages/core/ir/src/b.ts"),
      ],
      edges: [fx.edge("packages/frontend-typescript/src/a.ts", "packages/core/ir/src/b.ts", "packaging", "packaging.import", { span: sp("packages/frontend-typescript/src/a.ts") })],
    });
    const model = archModel(view);
    expect(model.edges).toHaveLength(1);
    expect(model.edges[0]).toMatchObject({ from: "packages/frontend-typescript", to: "packages/core/ir", imports: 1 });
    expect(model.violations).toEqual([]);
  });
});

describe("archModel: bare specifiers", () => {
  const unresolved = (from: string, text: string) =>
    fx.edge(from, { unresolved: { scheme: "module", text } }, "packaging", "packaging.import", { span: sp(from) });

  it("turns a scoped import of a workspace package into an inferred import edge, and the rest into externals", () => {
    const view = fx.view({
      nodes: [pkg("apps/server"), file("apps/server/src/a.ts"), pkg("packages/core/indexer"), file("packages/core/indexer/src/a.ts")],
      edges: [
        unresolved("apps/server/src/a.ts", "@insight/indexer"),
        unresolved("apps/server/src/a.ts", "@insight/indexer/sub"),
        unresolved("apps/server/src/a.ts", "fastify"),
        unresolved("apps/server/src/a.ts", "node:fs"),
        unresolved("apps/server/src/a.ts", "@fastify/static/x"),
        unresolved("apps/server/src/a.ts", "./gone.js"),
      ],
    });
    const model = archModel(view);
    expect(model.edges).toHaveLength(1);
    expect(model.edges[0]).toMatchObject({ from: "apps/server", to: "packages/core/indexer", imports: 2, confidence: "inferred" });
    expect(model.unresolved.map((u) => u.text)).toEqual(["./gone.js"]);
    expect(model.externals.map((x) => [x.name, x.imports]).sort()).toEqual([["@fastify/static", 1], ["fastify", 1], ["node:fs", 1]]);
  });

  it("leaves fixture package.json files out of the package list", () => {
    const view = fx.view({
      nodes: [pkg("packages/a"), file("packages/a/src/x.ts"), pkg("packages/a/test/fixtures/p"), file("packages/a/test/fixtures/p/y.ts")],
    });
    const model = archModel(view);
    expect(model.packages.map((p) => p.path)).toEqual(["packages/a"]);
    expect(model.packages[0]?.fileCount).toBe(4);
  });

  it("lists every source file with its function count, and the import pairs between local files", () => {
    const site = fx.span("src/a.ts", 1, 0, 1, 30);
    const view = fx.view({
      nodes: [
        file("src/a.ts"),
        fx.node("src/a.ts#f", "structure", "structure.function", { parent: "src/a.ts" }),
        fx.node("src/a.ts#g", "structure", "structure.function", { parent: "src/a.ts" }),
        file("src/b.ts"),
      ],
      edges: [fx.edge("src/a.ts", "src/b.ts", "packaging", "packaging.import", { span: site })],
    });
    const model = archModel(view);
    expect(model.files).toEqual([
      { path: "src/a.ts", functions: 2 },
      { path: "src/b.ts", functions: 0 },
    ]);
    expect(model.fileImports).toEqual([{ from: "src/a.ts", to: "src/b.ts", imports: 1, confidence: "exact", sites: [site] }]);
  });
});

describe("archModel with lenses under packages/lens/", () => {
  it("gives packages/lens/<name> the lens layer, and reports a lens importing a frontend", () => {
    const site = fx.span("packages/lens/calls/src/a.ts", 3, 0, 3, 40);
    const view = fx.view({
      nodes: [
        pkg("packages/lens/calls"),
        file("packages/lens/calls/src/a.ts"),
        pkg("packages/frontend-typescript"),
        file("packages/frontend-typescript/src/b.ts"),
      ],
      edges: [
        fx.edge("packages/lens/calls/src/a.ts", "packages/frontend-typescript/src/b.ts", "packaging", "packaging.import", { span: site }),
      ],
    });
    const model = archModel(view);
    expect(model.packages.find((p) => p.path === "packages/lens/calls")?.layer).toBe("lens");
    expect(model.violations).toEqual([
      {
        from: "packages/lens/calls",
        to: "packages/frontend-typescript",
        rule: "frontends and lenses never import each other",
        sites: [site],
      },
    ]);
  });
});
