import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IRNode } from "@insight/ir";
import { projectPaths, readSnapshot, runIndex } from "../src/index.js";

// A project that writes globalThis.x must index with no Validator problem: a global variable has no parent node.
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..", "..");
let scratch: string;
let projectDir: string;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "insight-global-parent-"));
  projectDir = join(scratch, "globals-app");
  mkdirSync(join(projectDir, "src"), { recursive: true });
  writeFileSync(join(projectDir, "package.json"), JSON.stringify({ name: "globals-app", private: true }));
  writeFileSync(
    join(projectDir, "src", "index.ts"),
    `export function setFlag(): void {
  globalThis.flag = true;
}
export function readFlag(): boolean {
  return globalThis.flag === true;
}
`,
  );
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("global variables in the indexer", () => {
  it("indexes a globalThis write with zero validator problems and no parent on the global", async () => {
    const report = await runIndex({
      projectPath: projectDir,
      builtinRoot: repoRoot,
      userPluginDir: join(scratch, "no-user-plugins"),
      full: true,
    });
    expect(report.problems).toEqual([]);
    const records = readSnapshot(projectPaths(projectDir), report.snapshot);
    const global = records.flatMap((r) => ("node" in r && r.node.id === "<global>#global:flag" ? [r.node as IRNode] : []));
    expect(global).toHaveLength(1);
    expect(global[0]).toMatchObject({ kind: "data.variable", attrs: { storage: "global" } });
    expect(global[0]!.parent).toBeUndefined();
  }, 240_000);
});
