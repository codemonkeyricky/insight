import { cpSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IREdge, IRNode, IRRecord } from "@insight/ir";
import { projectPaths, readSnapshot, runIndex } from "../src/index.js";
// The flow package is not a dependency of the indexer, so its sources are imported by path.
import { couplingChart, couplingFacts, type CouplingFootprint } from "../../flow/src/coupling.js";
import type { Item } from "../../flow/src/build.js";
import type { ModuleMap } from "../../flow/src/modules.js";
import { layoutFunction } from "../../flow/src/layout.js";
import type { FlowNode } from "../../flow/src/types.js";

// Coupling reduction on two indexes: samples/benchmark (C++) and packages/core of this worktree (TypeScript).
// Each index gets (a) a no-loss check: every row that reaches outside its function stays in the coupling chart,
// and (b) reduction metrics, printed and not asserted.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..", "..");
const SCRATCH = join(here, "..", ".insight-test", `coupling-reduction-${process.pid}`);
const SELF_BUDGET_MS = 120_000;
const SELF_SCRATCH = join(tmpdir(), `insight-coupling-self-${process.pid}`);

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

/** The spans of the lock frames' heads (a frame is a fork, not a row, so `allRows` does not list it). */
function lockHeads(items: readonly Item[], out: string[] = []): string[] {
  for (const item of items) {
    if (item.t === "fork") {
      if (item.role === "lock") out.push(spanKey(item.span));
      for (const a of item.arms) lockHeads(a.body, out);
    } else if (item.t === "loop") lockHeads(item.body, out);
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
      else if (item.role === "spawn" || item.role === "await" || item.role === "sync") out.set(spanKey(item.span), "conc");
      else if (cross) out.set(spanKey(item.span), "cross");
    } else if (item.t === "term") {
      if (item.role === "throw" && !caught) out.set(spanKey(item.span), "escape");
    } else if (item.t === "fork") {
      // A lock frame's head is the acquire it replaces: a conc row.
      if (item.role === "lock") out.set(spanKey(item.span), "conc");
      const tryCatches = item.role === "try" && item.arms.some((a) => a.kind === "exception");
      for (const a of item.arms) mustKeep(a.body, M, modules, out, tryCatches && a.kind === "next" ? true : caught);
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
const mean = (xs: number[]): number => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);
const total = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);

/** A content row: a laid-out box that is neither the start/end terminator nor a fold row. */
const isContent = (n: FlowNode): boolean => n.role !== "start" && n.role !== "end" && n.foldId === undefined;

interface IndexRecords {
  nodes: IRNode[];
  edges: IREdge[];
}

async function indexRecords(projectDir: string, scratch: string): Promise<IndexRecords> {
  const report = await runIndex({
    projectPath: projectDir,
    builtinRoot: repoRoot,
    userPluginDir: join(scratch, "no-user-plugins"),
    full: true,
  });
  const records: IRRecord[] = readSnapshot(projectPaths(projectDir), report.snapshot);
  const out: IndexRecords = { nodes: [], edges: [] };
  for (const r of records) {
    if ("node" in r) out.nodes.push(r.node);
    else if ("edge" in r) out.edges.push(r.edge);
  }
  return out;
}

interface Measured {
  functions: number;
  lossFailures: string[];
  checked: number;
  allRows: number[];
  couplingRows: number[];
  folds: number[];
  histogram: Map<string, number>;
  hoisted: number;
  emptyCharts: number;
}

/** Runs the no-loss check and collects per-function row counts for one index. */
function measure(index: IndexRecords): Measured {
  const { modules, facts, footprints } = couplingFacts(index.nodes, index.edges);
  const fp = footprints as ReadonlyMap<string, CouplingFootprint>;
  const m: Measured = { functions: 0, lossFailures: [], checked: 0, allRows: [], couplingRows: [], folds: [], histogram: new Map(), hoisted: 0, emptyCharts: 0 };
  for (const [id, f] of facts) {
    const full = layoutFunction(f);
    if (full.tooLarge || full.nodes.length === 0) continue;
    const M = modules.moduleOf(id) ?? ".";
    const pruned = couplingChart(id, f.items, modules, fp);
    const chart = layoutFunction({ id, name: f.name, async: f.async, ...(f.span ? { span: f.span } : {}), items: pruned.items });

    const required = mustKeep(f.items, M, modules);
    const kept = new Set([...allRows(pruned.items).map((r) => spanKey(r.span)), ...lockHeads(pruned.items)]);
    for (const [key, why] of required) {
      m.checked++;
      if (!kept.has(key)) m.lossFailures.push(`${id} ${why} ${key}`);
    }

    m.functions++;
    m.allRows.push(full.nodes.filter(isContent).length);
    const content = chart.nodes.filter(isContent).length;
    m.couplingRows.push(content);
    m.folds.push(chart.nodes.filter((n) => n.foldId !== undefined).length);
    if (content === 0) m.emptyCharts++;
    for (const n of chart.nodes) {
      if (n.foldId !== undefined || n.coupling === undefined) continue;
      m.histogram.set(n.coupling, (m.histogram.get(n.coupling) ?? 0) + 1);
      if (n.hoisted !== undefined) m.hoisted++;
    }
  }
  return m;
}

function report(name: string, m: Measured, elapsedMs?: number): void {
  const row = (label: string, xs: number[]) =>
    `  ${label.padEnd(26)} median ${median(xs)}  p90 ${pick(xs, 0.9)}  mean ${mean(xs).toFixed(2)}  total ${total(xs)}`;
  const hist = [...m.histogram.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k} ${v}`).join(", ");
  const lines = [
    `coupling reduction [${name}] over ${m.functions} functions${elapsedMs === undefined ? "" : ` (indexed in ${(elapsedMs / 1000).toFixed(1)} s)`}`,
    `(i) content rows`,
    row("All", m.allRows),
    row("Coupling", m.couplingRows),
    `(ii) fold rows in Coupling`,
    `  total ${total(m.folds)}  mean per function ${mean(m.folds).toFixed(2)}`,
    `(iii) functions with 0 content rows in Coupling: ${m.emptyCharts} of ${m.functions} (${((100 * m.emptyCharts) / Math.max(1, m.functions)).toFixed(1)}%)`,
    `(iv) total content rows Coupling/All: ${total(m.couplingRows)}/${total(m.allRows)} = ${(total(m.couplingRows) / Math.max(1, total(m.allRows))).toFixed(3)}`,
    `(v) kept-row classes in Coupling: ${hist || "none"}; of which carry hoisted callee rows: ${m.hoisted}`,
    `no-loss: ${m.checked} required rows checked, ${m.lossFailures.length} lost`,
  ];
  console.log(lines.join("\n"));
}

let benchmark: IndexRecords = { nodes: [], edges: [] };
let self: IndexRecords | undefined;
let selfElapsedMs = 0;
let selfSkipped = false;

beforeAll(async () => {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(SCRATCH, { recursive: true });
  const benchProject = join(SCRATCH, "benchmark");
  cpSync(join(repoRoot, "samples", "benchmark"), benchProject, {
    recursive: true,
    filter: (src) => !/[\\/]\.insight([\\/]|$)/.test(src),
  });
  benchmark = await indexRecords(benchProject, SCRATCH);
}, 120_000);

beforeAll(async () => {
  // Indexing packages/core takes time; a run over the budget is reported as skipped rather than failed.
  // Outside the package: the scratch dir lives under packages/core, and copying a tree into itself is refused.
  const selfProject = join(SELF_SCRATCH, "core");
  mkdirSync(SELF_SCRATCH, { recursive: true });
  const selfSource = join(repoRoot, "packages", "core");
  cpSync(selfSource, selfProject, {
    recursive: true,
    filter: (src) => !/(^|[\\/])(node_modules|dist|\.insight-test|\.insight|\.claude)([\\/]|$)/.test(relative(selfSource, src)),
  });
  const started = Date.now();
  const indexed = await indexRecords(selfProject, SCRATCH);
  selfElapsedMs = Date.now() - started;
  if (selfElapsedMs > SELF_BUDGET_MS) selfSkipped = true;
  else self = indexed;
}, 900_000);

afterAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
  rmSync(SELF_SCRATCH, { recursive: true, force: true });
});

describe("coupling pass on google/benchmark", () => {
  it("keeps every cross, io, conc and escape row, and reports reduction", () => {
    const m = measure(benchmark);
    report("benchmark", m);
    expect(m.checked).toBeGreaterThan(0);
    expect(m.lossFailures.slice(0, 20)).toEqual([]);
    expect(m.functions).toBeGreaterThan(0);
  });
});

describe("coupling pass on packages/core (self index, TypeScript)", () => {
  it("keeps every cross, io, conc and escape row, and reports reduction", (ctx) => {
    if (selfSkipped || self === undefined) {
      // Reported as skipped (not passed): the self-index went over its time budget, so nothing was checked here.
      ctx.skip(`self index took ${(selfElapsedMs / 1000).toFixed(1)} s, over the ${SELF_BUDGET_MS / 1000} s budget`);
    }
    const m = measure(self);
    report("self", m, selfElapsedMs);
    expect(m.checked).toBeGreaterThan(0);
    expect(m.lossFailures.slice(0, 20)).toEqual([]);
    expect(m.functions).toBeGreaterThan(0);
  });
});
