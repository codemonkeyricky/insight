import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { projectPaths, readSnapshot, runIndex } from "../src/index.js";

// The Bazel frontend's inputs include the C/C++ sources, so adding a source that a glob matches must
// re-extract the BUILD file that owns it, and an unchanged project must reuse every shard.
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..", "..");
const SCRATCH = join(here, "..", ".insight-test", `bazel-freshness-${process.pid}`);
const project = join(SCRATCH, "sample-bazel");
const fixture = join(repoRoot, "packages", "frontend", "bazel", "test", "fixtures", "sample-bazel");

const options = (full: boolean) => ({
  projectPath: project,
  builtinRoot: repoRoot,
  userPluginDir: join(SCRATCH, "no-user-plugins"),
  full,
});

beforeAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(SCRATCH, { recursive: true });
  cpSync(fixture, project, { recursive: true });
}, 60_000);

afterAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
});

describe("frontend-bazel freshness", () => {
  it("re-extracts the owning BUILD file when a matching source is added, and reuses shards when nothing changed", async () => {
    const first = await runIndex(options(true));
    expect(first.extracted.some((e) => e.frontend === "frontend-bazel" && e.file === "lib/BUILD")).toBe(true);

    writeFileSync(join(project, "lib", "src", "extra.cc"), "int extra() { return 1; }\n");
    const second = await runIndex(options(false));
    expect(second.extracted).toContainEqual({ frontend: "frontend-bazel", file: "lib/BUILD" });

    const records = readSnapshot(projectPaths(project), second.snapshot);
    const edges = records.flatMap((r) => ("edge" in r ? [r.edge] : []));
    expect(edges).toContainEqual(
      expect.objectContaining({ kind: "packaging.target-contains", from: "//lib:core", to: "lib/src/extra.cc" }),
    );

    // Nothing changed since the last run: no frontend-bazel file is extracted again, and shards are reused.
    const third = await runIndex(options(false));
    expect(third.extracted.filter((e) => e.frontend === "frontend-bazel")).toEqual([]);
    expect(third.reused).toBeGreaterThan(0);
  }, 120_000);

  it("re-extracts the Bazel BUILD files when a header in .inl or a .py file is added, which the inputs cover", async () => {
    await runIndex(options(false));
    writeFileSync(join(project, "lib", "src", "extra.inl"), "inline int extra_inl() { return 2; }\n");
    const inl = await runIndex(options(false));
    expect(inl.extracted).toContainEqual({ frontend: "frontend-bazel", file: "lib/BUILD" });

    mkdirSync(join(project, "tools"), { recursive: true });
    writeFileSync(join(project, "tools", "gen.py"), "print('gen')\n");
    const py = await runIndex(options(false));
    expect(py.extracted).toContainEqual({ frontend: "frontend-bazel", file: "lib/BUILD" });
  }, 120_000);
});
