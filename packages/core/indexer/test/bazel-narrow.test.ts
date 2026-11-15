import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IRRecord } from "@insight/ir";
import { projectPaths, readSnapshot, runIndex } from "../src/index.js";

// Runs the real plugins (C++ and Bazel) over the bazel-narrow fixture. Each binary's main() calls Init(), which is
// defined in both binaries. The build graph must keep only the Init that the caller's binary links.
const here = dirname(fileURLToPath(import.meta.url));
const SCRATCH = join(here, "..", ".insight-test", `bazel-narrow-${process.pid}`);
const project = join(SCRATCH, "bazel-narrow");
const repoRoot = resolve(here, "..", "..", "..", "..");

let records: IRRecord[] = [];
let narrowed = 0;

beforeAll(async () => {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(SCRATCH, { recursive: true });
  cpSync(join(here, "fixtures", "bazel-narrow"), project, { recursive: true });
  const report = await runIndex({
    projectPath: project,
    builtinRoot: repoRoot,
    userPluginDir: join(SCRATCH, "no-user-plugins"),
  });
  narrowed = report.narrowed;
  records = readSnapshot(projectPaths(project), report.snapshot);
});

afterAll(() => {
  // Remove only this suite's scratch, since the other core suites run in parallel workers.
  rmSync(SCRATCH, { recursive: true, force: true });
});

/** The calls.call edges whose caller sits in the given file. */
function callsFrom(file: string) {
  return records.flatMap((r) => ("edge" in r && r.edge.kind === "calls.call" && r.edge.span?.file === file ? [r.edge] : []));
}

describe("build-graph narrowing on a Bazel project", () => {
  it("narrows main() in a/main.cc to a/init.cc's Init", () => {
    const calls = callsFrom("a/main.cc");
    const init = calls.find((e) => typeof e.to === "string" && e.to.includes("init"));
    expect(calls.some((e) => typeof e.to === "object" && "candidates" in e.to)).toBe(false);
    expect(init?.to).toEqual(expect.stringContaining("a/init.cc"));
    expect(init?.provenance.resolvedBy).toContain("build-graph");
  });

  it("narrows main() in b/main.cc to b/init.cc's Init", () => {
    const calls = callsFrom("b/main.cc");
    const init = calls.find((e) => typeof e.to === "string" && e.to.includes("init"));
    expect(init?.to).toEqual(expect.stringContaining("b/init.cc"));
    expect(init?.provenance.resolvedBy).toContain("build-graph");
  });

  it("reports at least two narrowed calls", () => {
    expect(narrowed).toBeGreaterThanOrEqual(2);
  });
});
