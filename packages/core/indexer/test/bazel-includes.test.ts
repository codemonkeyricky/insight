import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { projectPaths, readSnapshot, runIndex } from "../src/index.js";

// A C++ include that a Bazel target reaches through an external repository resolves to that repository,
// even when a vendored copy of the same header sits in the project and no target of the file depends on it.
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..", "..");
const SCRATCH = join(here, "..", ".insight-test", `bazel-includes-${process.pid}`);
const project = join(SCRATCH, "sample-bazel");
const fixture = join(repoRoot, "packages", "frontend", "bazel", "test", "fixtures", "sample-bazel");

const options = {
  projectPath: project,
  builtinRoot: repoRoot,
  userPluginDir: join(SCRATCH, "no-user-plugins"),
  full: true,
};

beforeAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(SCRATCH, { recursive: true });
  cpSync(fixture, project, { recursive: true });
}, 60_000);

afterAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
});

describe("frontend-bazel external includes", () => {
  it("resolves absl and gtest includes of a macro target to their external repositories, not to the vendored copy", async () => {
    const report = await runIndex(options);
    const records = readSnapshot(projectPaths(project), report.snapshot);
    const edges = records.flatMap((r) => ("edge" in r ? [r.edge] : []));
    const includeOf = (text: string) =>
      edges.find((e) => e.kind === "packaging.include" && e.from === "ext/consumer.cc" && e.attrs?.text === text);

    expect(includeOf("absl/strings/str_cat.h")?.to).toBe("@abseil-cpp");
    expect(includeOf("absl/strings/str_cat.h")?.to).not.toBe("third_party/absl/strings/str_cat.h");
    expect(includeOf("gtest/gtest.h")?.to).toBe("@com_google_googletest");
  }, 120_000);
});
