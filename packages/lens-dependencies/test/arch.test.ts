import { describe, expect, it } from "vitest";
import { irFixtures as fx } from "@insight/sdk";
import { archModel } from "../src/index.js";

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
        pkg("packages/ir"),
        file("packages/ir/src/a.ts"),
        pkg("apps/web"),
        file("apps/web/src/a.ts"),
        pkg("packages/cli"),
        file("packages/cli/src/a.ts"),
      ],
    });
    const model = archModel(view);
    const layerOf = Object.fromEntries(model.packages.map((p) => [p.path, p.layer]));
    expect(layerOf).toEqual({
      "apps/web": "app",
      "packages/cli": "other",
      "packages/frontend-typescript": "frontend",
      "packages/ir": "ir",
      "packages/lens-calls": "lens",
    });
    expect(model.layers).toEqual(["project", "frontend", "ir", "lens", "app", "other"]);
    expect(model.packages.find((p) => p.path === "packages/lens-calls")?.fileCount).toBe(3);
    expect(() => JSON.parse(JSON.stringify(model))).not.toThrow();
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
        pkg("packages/ir"),
        file("packages/ir/src/b.ts"),
      ],
      edges: [fx.edge("packages/frontend-typescript/src/a.ts", "packages/ir/src/b.ts", "packaging", "packaging.import", { span: sp("packages/frontend-typescript/src/a.ts") })],
    });
    const model = archModel(view);
    expect(model.edges).toHaveLength(1);
    expect(model.edges[0]).toMatchObject({ from: "packages/frontend-typescript", to: "packages/ir", imports: 1 });
    expect(model.violations).toEqual([]);
  });
});
