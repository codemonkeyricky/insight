import { appendFileSync, cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { projectPaths, readSnapshot, runIndex } from "../src/index.js";

// The CMake frontend's inputs include the CMakeLists files and its inputListing covers every file, so adding a header
// under a target's include directory, or a source that a file(GLOB) matches, must re-extract the CMake shards and link
// the new file to the target, and an unchanged project must reuse them.
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..", "..");
const SCRATCH = join(here, "..", ".insight-test", `cmake-freshness-${process.pid}`);
const project = join(SCRATCH, "cmake-packages");
const fixture = join(here, "fixtures", "cmake-packages");

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

describe("frontend-cmake freshness", () => {
  it("re-extracts the CMake shards when a header is added under an include directory, and reuses them when nothing changed", async () => {
    const first = await runIndex(options(true));
    expect(first.extracted).toContainEqual({ frontend: "frontend-cmake", file: "lib/CMakeLists.txt" });

    writeFileSync(join(project, "lib", "include", "shapes", "new.h"), "#pragma once\n");
    const second = await runIndex(options(false));
    expect(second.extracted).toContainEqual({ frontend: "frontend-cmake", file: "lib/CMakeLists.txt" });

    const records = readSnapshot(projectPaths(project), second.snapshot);
    const edges = records.flatMap((r) => ("edge" in r ? [r.edge] : []));
    expect(edges).toContainEqual(
      expect.objectContaining({ kind: "packaging.target-contains", from: "cmake://lib:shapes", to: "lib/include/shapes/new.h" }),
    );

    // Nothing changed since the last run: no frontend-cmake file is extracted again, and shards are reused.
    const third = await runIndex(options(false));
    expect(third.extracted.filter((e) => e.frontend === "frontend-cmake")).toEqual([]);
    expect(third.reused).toBeGreaterThan(0);
  }, 120_000);

  it("links a new source that a file(GLOB) matches to its target after an incremental re-index", async () => {
    const globProject = join(SCRATCH, "cmake-glob");
    cpSync(fixture, globProject, { recursive: true });
    appendFileSync(
      join(globProject, "lib", "CMakeLists.txt"),
      'file(GLOB GLOBBED "src/*.cc")\ntarget_sources(shapes PRIVATE ${GLOBBED})\n',
    );
    const globOptions = (full: boolean) => ({ ...options(full), projectPath: globProject });

    const first = await runIndex(globOptions(true));
    expect(first.extracted).toContainEqual({ frontend: "frontend-cmake", file: "lib/CMakeLists.txt" });

    // A new .cc file is not in the frontend's contents inputs, only in its listing, so the file list alone must
    // re-extract the CMake shards.
    writeFileSync(join(globProject, "lib", "src", "b.cc"), "int b() { return 2; }\n");
    const second = await runIndex(globOptions(false));
    expect(second.extracted).toContainEqual({ frontend: "frontend-cmake", file: "lib/CMakeLists.txt" });

    const records = readSnapshot(projectPaths(globProject), second.snapshot);
    const edges = records.flatMap((r) => ("edge" in r ? [r.edge] : []));
    expect(edges).toContainEqual(
      expect.objectContaining({ kind: "packaging.target-contains", from: "cmake://lib:shapes", to: "lib/src/b.cc" }),
    );
  }, 120_000);
});
