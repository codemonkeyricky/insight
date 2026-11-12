import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "../src/paths.js";

/**
 * The folder layout rules (see docs/layout.md). They are checked on the declared `dependencies` and `peerDependencies`
 * only; devDependencies may reach anywhere a test needs, and are reported separately by the "devDependencies" test.
 */

type Category = "core" | "frontend" | "lens" | "app";

interface Workspace {
  name: string;
  dir: string; // repo-relative, forward slashes
  category: Category;
  manifest: PackageManifest;
}

interface PackageManifest {
  name?: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

const ROOT = repoRoot();
if (ROOT === undefined) throw new Error("workspace-layout.test: no pnpm-workspace.yaml above this file");

/** The kernel packages a frontend or a lens may depend on. */
const PLUGIN_ALLOWED = new Set(["@insight/ir", "@insight/sdk", "@insight/model", "@insight/flow"]);

/**
 * Rule 4 exceptions: files that may import node: builtins although they sit in a browser-safe package.
 * ir/src/node.ts is the Node-only entry, and ir/src/schemas.ts reads the bundled schema files from disk.
 * sdk/src/testing.ts and sdk/src/conformance.ts are the test-only subpaths.
 */
const NODE_IMPORT_EXCEPTIONS = new Set([
  "packages/core/ir/src/node.ts",
  "packages/core/ir/src/schemas.ts",
  "packages/core/sdk/src/testing.ts",
  "packages/core/sdk/src/conformance.ts",
]);

/** Packages whose src must stay free of node: builtins (rule 4). */
const BROWSER_SAFE = ["packages/core/ir", "packages/core/sdk", "packages/core/model", "packages/core/flow"];

function readManifest(dir: string): PackageManifest | undefined {
  const file = join(ROOT as string, dir, "package.json");
  if (!existsSync(file)) return undefined;
  return JSON.parse(readFileSync(file, "utf8")) as PackageManifest;
}

function subfolders(dir: string): string[] {
  const abs = join(ROOT as string, dir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs)
    .filter((name) => statSync(join(abs, name)).isDirectory())
    .sort()
    .map((name) => `${dir}/${name}`);
}

function categoryOf(dir: string): Category {
  if (dir.startsWith("packages/core/")) return "core";
  if (dir.startsWith("packages/frontend/")) return "frontend";
  if (dir.startsWith("packages/lens/")) return "lens";
  return "app";
}

/** Every workspace package under the four layout roots. Folders without a package.json (group folders) are skipped. */
function loadWorkspaces(): Workspace[] {
  const dirs = [
    ...subfolders("packages/core"),
    ...subfolders("packages/frontend"),
    ...subfolders("packages/lens"),
    ...subfolders("apps"),
  ];
  const out: Workspace[] = [];
  for (const dir of dirs) {
    const manifest = readManifest(dir);
    if (manifest === undefined || manifest.name === undefined) continue;
    out.push({ name: manifest.name, dir, category: categoryOf(dir), manifest });
  }
  return out;
}

const workspaces = loadWorkspaces();
const byName = new Map(workspaces.map((w) => [w.name, w]));

/** Declared runtime dependencies of a package, with the field each came from. */
function declared(w: Workspace): Array<{ dep: string; field: "dependencies" | "peerDependencies" }> {
  const out: Array<{ dep: string; field: "dependencies" | "peerDependencies" }> = [];
  for (const dep of Object.keys(w.manifest.dependencies ?? {})) out.push({ dep, field: "dependencies" });
  for (const dep of Object.keys(w.manifest.peerDependencies ?? {})) out.push({ dep, field: "peerDependencies" });
  return out.filter((d) => d.dep.startsWith("@insight/"));
}

describe("workspace layout", () => {
  it("finds the workspace packages it checks", () => {
    expect(workspaces.length).toBeGreaterThan(20);
    expect(byName.has("@insight/indexer")).toBe(true);
    expect(byName.has("@insight/hosted")).toBe(true);
  });

  it("rule 1: packages/core/* never depends on a frontend, a lens or an app", () => {
    const violations: string[] = [];
    for (const w of workspaces.filter((x) => x.category === "core")) {
      for (const { dep, field } of declared(w)) {
        const target = byName.get(dep);
        if (target && target.category !== "core") {
          violations.push(`${w.name} (${w.dir}) ${field} ${dep} (${target.category} ${target.dir})`);
        }
      }
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });

  it("rule 2: frontends and lenses depend only on ir, sdk, model and flow", () => {
    const violations: string[] = [];
    for (const w of workspaces.filter((x) => x.category === "frontend" || x.category === "lens")) {
      for (const { dep, field } of declared(w)) {
        if (!PLUGIN_ALLOWED.has(dep)) {
          violations.push(`${w.name} (${w.dir}) ${field} ${dep} is not one of ir, sdk, model, flow`);
        }
      }
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });

  it("rule 3: apps/hosted lists every frontend and lens package", () => {
    const hosted = byName.get("@insight/hosted");
    expect(hosted, "@insight/hosted not found under apps/").toBeDefined();
    const listed = new Set(Object.keys(hosted?.manifest.dependencies ?? {}).filter((d) => d.startsWith("@insight/")));
    const plugins = workspaces.filter((w) => w.category === "frontend" || w.category === "lens").map((w) => w.name);
    // The rule is about the plugin entries: every frontend and lens package is listed. Other @insight/* entries
    // (apps such as @insight/export) are not plugins and are not checked here.
    const missing = plugins.filter((p) => !listed.has(p));
    const unknown = [...listed].filter((d) => !byName.has(d));
    const problems = [
      ...missing.map((p) => `@insight/hosted is missing dependency ${p}`),
      ...unknown.map((d) => `@insight/hosted lists ${d}, which is not a workspace package`),
    ];
    expect(problems, problems.join("\n")).toEqual([]);
  });

  it("rule 5: nothing under packages/** depends on anything under apps/**", () => {
    const violations: string[] = [];
    for (const w of workspaces.filter((x) => x.category !== "app")) {
      for (const { dep, field } of declared(w)) {
        const target = byName.get(dep);
        if (target?.category === "app") {
          violations.push(`${w.name} (${w.dir}) ${field} ${dep} (${target.dir})`);
        }
      }
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });

  it("rule 4: ir, sdk, model and flow source does not import node: builtins, except the listed files", () => {
    const violations: string[] = [];
    const pattern = /\b(?:from|import|require)\s*\(?\s*["']node:/;
    for (const pkgDir of BROWSER_SAFE) {
      for (const file of listTs(join(ROOT as string, pkgDir, "src"))) {
        const rel = relative(ROOT as string, file).split(sep).join("/");
        if (NODE_IMPORT_EXCEPTIONS.has(rel)) continue;
        const lines = readFileSync(file, "utf8").split("\n");
        lines.forEach((line, i) => {
          if (pattern.test(line)) violations.push(`${rel}:${i + 1} imports a node: builtin`);
        });
      }
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });

  it("reports devDependencies that cross a layer rule (informational, not asserted)", () => {
    const crossing: string[] = [];
    for (const w of workspaces) {
      for (const dep of Object.keys(w.manifest.devDependencies ?? {})) {
        if (!dep.startsWith("@insight/")) continue;
        const target = byName.get(dep);
        if (!target) continue;
        const bad =
          (w.category === "core" && target.category !== "core") ||
          ((w.category === "frontend" || w.category === "lens") && !PLUGIN_ALLOWED.has(dep)) ||
          (w.category !== "app" && target.category === "app");
        if (bad) crossing.push(`${w.name} (${w.dir}) devDependencies ${dep} (${target.dir})`);
      }
    }
    // Printed so the report shows them; a devDependency is allowed by the rules, so this does not fail.
    console.log(crossing.length === 0 ? "devDependency crossings: none" : `devDependency crossings:\n${crossing.join("\n")}`);
    expect(Array.isArray(crossing)).toBe(true);
  });
});

function listTs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) out.push(...listTs(abs));
    else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) out.push(abs);
  }
  return out;
}
