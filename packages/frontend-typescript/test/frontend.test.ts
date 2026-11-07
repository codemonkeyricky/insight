import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createCoreRegistry } from "@insight/ir";
import { runFrontendConformance, type IRBatch, type ProjectRoot } from "@insight/sdk";
import frontend from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(here, "fixtures", "sample-ts");
const goldenFile = join(here, "golden", "sample-ts.ndjson");
const files = ["src/app/main.ts", "src/lib/io.ts", "src/lib/math.ts"];

const root: ProjectRoot = { path: fixtureRoot, name: "sample-ts", allowBuildTools: false };
const readFile = async (rel: string) => readFileSync(join(fixtureRoot, rel), "utf8");

async function extractAll(): Promise<IRBatch[]> {
  const batches: IRBatch[] = [];
  const ctx = {
    root,
    files,
    listFiles: () => [...files],
    readFile,
    log: () => undefined,
  };
  for await (const batch of frontend.extract(ctx)) batches.push(batch);
  return batches;
}

/** One sorted line per record, so the golden file diffs cleanly. */
function toGolden(batches: IRBatch[]): string {
  const lines: string[] = [];
  for (const batch of batches) {
    for (const record of batch.records) lines.push(JSON.stringify(record));
  }
  return lines.sort().join("\n") + "\n";
}

describe("frontend-typescript", () => {
  it("passes the SDK conformance kit", async () => {
    const report = await runFrontendConformance({
      frontend,
      root,
      files,
      readFile,
      registry: createCoreRegistry(),
    });
    const failed = report.checks.filter((c) => !c.ok);
    expect(failed).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.checks.length).toBeGreaterThanOrEqual(6);
  });

  it("detects the sample project", async () => {
    const detection = await frontend.detect(root);
    expect(detection).not.toBeNull();
  });

  it("matches the golden IR for the sample project", async () => {
    const actual = toGolden(await extractAll());
    if (process.env.UPDATE_GOLDEN === "1") {
      writeFileSync(goldenFile, actual);
    }
    expect(actual).toBe(readFileSync(goldenFile, "utf8"));
  });
});
