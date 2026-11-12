import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadPlugins } from "../src/loader.js";

/** A manifest with a lens role, and the lens module it points at. */
function writePlugin(dir: string, id: string, withModule = true): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "insight-plugin.json"), JSON.stringify({ id, version: "0.1.0", irVersion: "^1.0", roles: { lens: "index.mjs" } }));
  if (withModule) {
    writeFileSync(join(dir, "index.mjs"), `export default { id: ${JSON.stringify(id)}, title: ${JSON.stringify(id)}, requires: [], async run() { return { findings: [], views: [], metrics: {} }; } };\n`);
  }
}

describe("loadPlugins group folders", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "insight-groups-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("finds the plugin in a real group folder and skips stale folders and node_modules", async () => {
    const builtin = join(root, "repo");
    const packages = join(builtin, "packages");

    // A real group folder: packages/lens/ holds a package with a manifest.
    writePlugin(join(packages, "lens", "real-plugin"), "real-plugin");

    // A stale folder left by an old build: only dist/ and node_modules/, with manifests inside that must not load.
    writePlugin(join(packages, "lens-calls", "dist"), "stale-dist", false);
    writePlugin(join(packages, "lens-calls", "node_modules", "ghost"), "stale-ghost", false);

    // A node_modules folder directly under packages/, holding a package with a manifest.
    writePlugin(join(packages, "node_modules", "installed"), "installed", false);

    // A dot-directory directly under packages/, holding a package with a manifest.
    writePlugin(join(packages, ".cache", "hidden"), "hidden-cache", false);

    const userPlugins = join(root, "user");
    mkdirSync(userPlugins);

    const loaded = await loadPlugins({ projectPath: root, builtinRoot: builtin, userPluginDir: userPlugins, projectPlugins: false });

    expect(loaded.lenses.map((l) => l.manifest.id)).toEqual(["real-plugin"]);
    expect(loaded.disabled).toEqual([]);
  });
});
