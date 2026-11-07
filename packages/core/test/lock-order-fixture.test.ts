import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { projectPaths, readAnalysis, runIndex } from "../src/index.js";

// Hand-written fixture (samples/lock-order-fixture) for the lock-order lens only. It is not a project sample,
// so the test checks the lens's cycle finding and nothing else.
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const SCRATCH = join(here, "..", ".insight-test", `lock-order-${process.pid}`);
const project = join(SCRATCH, "lock-order-fixture");

let lockOrder: { findings: { id: string; severity: string; nodes: string[] }[]; metrics: Record<string, number> } | undefined;

beforeAll(async () => {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(SCRATCH, { recursive: true });
  cpSync(join(repoRoot, "samples", "lock-order-fixture"), project, { recursive: true });
  const report = await runIndex({
    projectPath: project,
    builtinRoot: repoRoot,
    userPluginDir: join(SCRATCH, "no-user-plugins"),
    full: true,
  });
  const analysis = readAnalysis(projectPaths(project), report.snapshot);
  const result = analysis?.lenses.find((l) => l.id === "lens-lock-order")?.result;
  lockOrder = result as typeof lockOrder;
});

afterAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
});

describe("lock-order fixture (hand-written)", () => {
  it("reports one cycle between accounts_mu and audit_mu", () => {
    const cycles = lockOrder?.findings.filter((f) => f.id.startsWith("cycle:")) ?? [];
    expect(cycles.map((f) => f.id)).toEqual(["cycle:accounts_mu|audit_mu"]);
    expect(cycles[0]?.severity).toBe("error");
    expect(cycles[0]?.nodes.sort()).toEqual(["src/ledger.cc#reconcile", "src/ledger.cc#transfer"]);
  });

  it("sees both held-before orders", () => {
    expect(lockOrder?.metrics).toMatchObject({ locks: 2, cycles: 1 });
    expect((lockOrder?.metrics.orderEdges ?? 0) >= 2).toBe(true);
  });
});
