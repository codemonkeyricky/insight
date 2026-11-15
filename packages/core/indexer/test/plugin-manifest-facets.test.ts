import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadPlugins } from "../src/loader.js";

describe("plugin manifest facets", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "insight-facets-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("accepts a manifest that provides the state facet", async () => {
    const builtin = join(root, "repo");
    const dir = join(builtin, "packages", "lens", "lens-states");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "insight-plugin.json"),
      JSON.stringify({ id: "lens-states", version: "0.1.0", irVersion: "^1.0", provides: ["structure", "state"], roles: { lens: "index.mjs" } }),
    );
    writeFileSync(
      join(dir, "index.mjs"),
      `export default { id: "lens-states", title: "lens-states", requires: [], async run() { return { findings: [], views: [], metrics: {} }; } };\n`,
    );
    const userPlugins = join(root, "user");
    mkdirSync(userPlugins);

    const loaded = await loadPlugins({ projectPath: root, builtinRoot: builtin, userPluginDir: userPlugins, projectPlugins: false });

    expect(loaded.disabled).toEqual([]);
    expect(loaded.lenses.map((l) => l.manifest.id)).toEqual(["lens-states"]);
  });
});
