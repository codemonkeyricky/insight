import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IREdge, IRNode, IRRecord } from "@insight/ir";
import { projectPaths, readSnapshot, runIndex } from "../src/index.js";
// The flow package is not a dependency of the indexer, so its sources are imported by path.
import { couplingChart, couplingFacts, type CouplingFootprint } from "../../flow/src/coupling.js";
import type { Item } from "../../flow/src/build.js";
import type { ModuleMap } from "../../flow/src/modules.js";
import { layoutFunction } from "../../flow/src/layout.js";

// Coupling reduction on samples/benchmark (same static index as benchmark.test.ts). Two checks:
// (a) no loss: every row that reaches outside its function stays in the coupling chart;
// (b) reduction numbers, printed for the report and not asserted.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..", "..");
const SCRATCH = join(here, "..", ".insight-test", `coupling-reduction-${process.pid}`);
const project = join(SCRATCH, "benchmark");

type Step = Extract<Item, { t: "step" }>;
type Term = Extract<Item, { t: "term" }>;

const spanKey = (s: { file: string; start: readonly number[]; end: readonly number[] } | undefined): string =>
  s === undefined ? "" : `${s.file}:${s.start.join(",")}-${s.end.join(",")}`;

/** Every row of a chart, including the rows inside forks and loops. Fold rows are not walked. */
function allRows(items: readonly Item[], out: (Step | Term)[] = []): (Step | Term)[] {
  for (const item of items) {
    if (item.t === "step" || item.t === "term") out.push(item);
    else if (item.t === "fork") for (const a of item.arms) allRows(a.body, out);
    else if (item.t === "loop") allRows(item.body, out);
  }
  return out;
}

/** Rows whose span should survive pruning, with the reason. Throws count only when no enclosing try catches them. */
function mustKeep(items: readonly Item[], M: string, modules: ModuleMap, out: Map<string, string> = new Map(), caught = false): Map<string, string> {
  for (const item of items) {
    if (item.t === "step") {
      const targets = item.targets ?? (item.target ? [item.target] : []);
      const cross = targets.some((t) => {
        const m = modules.moduleOf(t);
        return m !== undefined && m !== M;
      });
      if (item.role === "effect") out.set(spanKey(item.span), "io");
      else if (item.role === "spawn" || item.role === "await") out.set(spanKey(item.span), "conc");
      else if (cross) out.set(spanKey(item.span), "cross");
    } else if (item.t === "term") {
      if (item.role === "throw" && !caught) out.set(spanKey(item.span), "escape");
    } else if (item.t === "fork") {
      const tryCatches = item.role === "try" && item.arms.some((a) => a.kind === "exception");
      for (const a of item.arms) {
        const armCaught = tryCatches && a.kind === "next" ? true : caught;
        mustKeep(a.body, M, modules, out, armCaught);
      }
    } else if (item.t === "loop") {
      mustKeep(item.body, M, modules, out, caught);
    }
  }
  return out;
}

const pick = (xs: number[], q: number): number => {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
};
const median = (xs: number[]): number => pick(xs, 0.5);

let nodes: IRNode[] = [];
let edges: IREdge[] = [];
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
  records = readSnapshot(projectPaths(project), report.snapshot);
  for (const r of records) {
    if ("node" in r) nodes.push(r.node);
    else if ("edge" in r) edges.push(r.edge);
  }
}, 120_000);

afterAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
});

describe("coupling pass on google/benchmark", () => {
  it("keeps every cross, io, conc and escape row in the coupling chart", () => {
    const { modules, facts, footprints } = couplingFacts(nodes, edges);
    const failures: string[] = [];
    let checked = 0;
    for (const [id, f] of facts) {
      const M = modules.moduleOf(id) ?? ".";
      const required = mustKeep(f.items, M, modules);
      if (required.size === 0) continue;
      const pruned = couplingChart(id, f.items, modules, footprints as ReadonlyMap<string, CouplingFootprint>);
      const kept = new Set(allRows(pruned.items).map((r) => spanKey(r.span)));
      for (const [key, why] of required) {
        checked++;
        if (!kept.has(key)) failures.push(`${id} ${why} ${key}`);
      }
    }
    expect(checked).toBeGreaterThan(0);
    expect(failures.slice(0, 20)).toEqual([]);
  });

  it("reports rows per function, All against Coupling", () => {
    const { modules, facts, footprints } = couplingFacts(nodes, edges);
    const all: number[] = [];
    const coupling: number[] = [];
    const ratios: number[] = [];
    for (const [id, f] of facts) {
      const full = layoutFunction(f);
      if (full.tooLarge || full.nodes.length === 0) continue;
      const pruned = couplingChart(id, f.items, modules, footprints as ReadonlyMap<string, CouplingFootprint>);
      const chart = layoutFunction({ id, name: f.name, async: f.async, ...(f.span ? { span: f.span } : {}), items: pruned.items });
      all.push(full.nodes.length);
      coupling.push(chart.nodes.length);
      ratios.push(chart.nodes.length / full.nodes.length);
    }
    console.log(
      `coupling reduction over ${all.length} functions: All median ${median(all)} p90 ${pick(all, 0.9)}; ` +
        `Coupling median ${median(coupling)} p90 ${pick(coupling, 0.9)}; median(coupling/all) ${median(ratios).toFixed(3)}`,
    );
    expect(all.length).toBeGreaterThan(0);
  });
});
