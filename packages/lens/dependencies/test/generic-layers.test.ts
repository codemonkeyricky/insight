import { describe, expect, it } from "vitest";
import { irFixtures as fx } from "@insight/sdk";
import { archModel, DEFAULT_LAYERS, topDirLayerOf } from "../src/index.js";

const file = (path: string) => fx.node(path, "structure", "structure.file");
const pkg = (dir: string) => file(dir === "." ? "package.json" : `${dir}/package.json`);

/** A project laid out by its own team, with none of Insight's directory names. */
const foreign = fx.view({
  nodes: [
    pkg("."),
    file("src/index.ts"),
    pkg("services/api"),
    file("services/api/src/server.ts"),
    pkg("libs/core"),
    file("libs/core/src/a.ts"),
    pkg("libs/util"),
    file("libs/util/src/b.ts"),
    pkg("tools/gen"),
    file("tools/gen/src/c.ts"),
  ],
});

describe("archModel layers for a project that is not Insight", () => {
  it("gives one layer per top-level directory, and the root package its own layer", () => {
    const model = archModel(foreign);
    const layerOf = Object.fromEntries(model.packages.map((p) => [p.path, p.layer]));
    expect(layerOf).toEqual({
      ".": "root",
      "libs/core": "libs",
      "libs/util": "libs",
      "services/api": "services",
      "tools/gen": "tools",
    });
    expect(model.layers).toEqual(["root", "libs", "services", "tools"]);
    expect(model.layers).not.toContain("project");
    expect(model.violations).toEqual([]);
  });

  it("names layers from the top-level directory of a path", () => {
    expect(topDirLayerOf("packages/lens-calls")).toBe("packages");
    expect(topDirLayerOf("src")).toBe("src");
    expect(topDirLayerOf(".")).toBe("root");
  });

  it("keeps the default layers when at least a fifth of the packages match them", () => {
    const view = fx.view({
      nodes: [
        pkg("packages/lens-calls"),
        file("packages/lens-calls/src/a.ts"),
        pkg("lib/a"),
        file("lib/a/src/a.ts"),
        pkg("svc/b"),
        file("svc/b/src/b.ts"),
        pkg("tool/c"),
        file("tool/c/src/c.ts"),
        pkg("x/d"),
        file("x/d/src/d.ts"),
      ],
    });
    const model = archModel(view);
    expect(model.packages.find((p) => p.path === "packages/lens-calls")?.layer).toBe("lens");
    expect(model.packages.find((p) => p.path === "lib/a")?.layer).toBe("other");
    expect(model.layers).toEqual([...DEFAULT_LAYERS, "other"]);
  });

  it("does not replace layers when the caller supplies its own layerOf", () => {
    const model = archModel(foreign, { layerOf: () => "mine" });
    expect(model.layers).toEqual([...DEFAULT_LAYERS, "mine"]);
    expect(new Set(model.packages.map((p) => p.layer))).toEqual(new Set(["mine"]));
  });
});
