import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, cpSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IRRecord } from "@insight/ir";
import { projectPaths, readAnalysis, readSnapshot, runIndex } from "../src/index.js";

// Static-mode index of the vendored google/benchmark sample (samples/benchmark, see samples/README.md).
// The copy runs in scratch so the vendored tree never gets an .insight/ directory. The golden summary
// pins what the pipeline reports today. Regenerate with UPDATE_GOLDEN=1 and review the diff.
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const SCRATCH = join(here, "..", ".insight-test", `benchmark-${process.pid}`);
const project = join(SCRATCH, "benchmark");
const golden = join(here, "golden", "benchmark-summary.json");

interface Summary {
  frontends: { id: string; files: number }[];
  problems: unknown[];
  coverage: { facet: string; providers: string[]; filesScanned: number; filesWithRecords: number; filesWithErrors: number; nodes: number; edges: number }[];
  lenses: { id: string; status: string; findings: number }[];
  lockOrder: Record<string, number>;
  concurrency: Record<string, number>;
  recordsByKind: Record<string, number>;
}

let summary: Summary;
let records: IRRecord[] = [];

beforeAll(async () => {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(SCRATCH, { recursive: true });
  cpSync(join(repoRoot, "samples", "benchmark"), project, {
    recursive: true,
    filter: (src) => !/[\\/]\.insight([\\/]|$)/.test(src),
  });
  const report = await runIndex({
    projectPath: project,
    builtinRoot: repoRoot,
    userPluginDir: join(SCRATCH, "no-user-plugins"),
    full: true,
  });
  const paths = projectPaths(project);
  records = readSnapshot(paths, report.snapshot);
  const analysis = readAnalysis(paths, report.snapshot);
  const lens = (id: string) => analysis?.lenses.find((l) => l.id === id)?.result;

  const recordsByKind: Record<string, number> = {};
  for (const r of records) {
    const kind = "node" in r ? r.node.kind : "edge" in r ? r.edge.kind : "finding";
    recordsByKind[kind] = (recordsByKind[kind] ?? 0) + 1;
  }
  summary = {
    frontends: report.frontends.map((f) => ({ id: f.id, files: f.files })).sort((a, b) => a.id.localeCompare(b.id)),
    problems: report.problems,
    coverage: report.coverage
      .map((c) => ({ ...c, providers: [...c.providers].sort() }))
      .sort((a, b) => a.facet.localeCompare(b.facet)),
    lenses: (analysis?.lenses ?? []).map((l) => ({ id: l.id, status: l.status, findings: l.result?.findings.length ?? 0 })),
    lockOrder: (lens("lens-lock-order")?.metrics ?? {}) as Record<string, number>,
    concurrency: (lens("lens-concurrency-map")?.metrics ?? {}) as Record<string, number>,
    recordsByKind: Object.fromEntries(Object.entries(recordsByKind).sort(([a], [b]) => a.localeCompare(b))),
  };
  if (process.env.UPDATE_GOLDEN === "1") writeFileSync(golden, JSON.stringify(summary, null, 2) + "\n");
});

afterAll(() => {
  // Remove only this suite's scratch, since the other core suites run in parallel workers.
  rmSync(SCRATCH, { recursive: true, force: true });
});

describe("google/benchmark sample, static mode", () => {
  it("indexes every C/C++ and build file without problems", () => {
    expect(summary.problems).toEqual([]);
    const cpp = summary.coverage.find((c) => c.facet === "structure");
    expect(cpp?.filesScanned).toBe(225);
    expect(summary.frontends.find((f) => f.id === "frontend-cpp")?.files).toBe(121);
    expect(summary.frontends.find((f) => f.id === "frontend-bazel")?.files).toBe(4);
    expect(summary.frontends.find((f) => f.id === "frontend-cmake")?.files).toBe(3);
  });

  it("reports the lock usage the lock-order lens saw, and no cycle", () => {
    // Benchmark wraps its locks in benchmark::Mutex / MutexLock, which the frontend does not recognize,
    // so this is near-empty. The lens does not find anything on benchmark.
    expect(summary.lockOrder.cycles).toBe(0);
    expect(summary.lockOrder.orderEdges).toBe(0);
  });

  it("matches the reviewed golden summary", () => {
    if (!existsSync(golden)) throw new Error("golden missing: run UPDATE_GOLDEN=1 pnpm vitest run test/benchmark.test.ts");
    expect(summary).toEqual(JSON.parse(readFileSync(golden, "utf8")));
  });

  it("keeps the frontend parse-error findings in the IR", () => {
    // Tree-sitter error recovery in these files is reported as IR findings, not as shard errors.
    const parseFindings = records.filter((r) => "finding" in r && r.finding.message.startsWith("parse errors"));
    expect(parseFindings.length).toBe(summary.recordsByKind.finding);
    expect(summary.recordsByKind.finding).toBeGreaterThan(0);
  });

  it("has records for every facet the frontends provide", () => {
    expect(records.length).toBeGreaterThan(0);
    expect(new Set(summary.coverage.map((c) => c.facet))).toEqual(
      new Set(["calls", "concurrency", "effects", "flow", "packaging", "structure", "sync"]),
    );
  });
});
