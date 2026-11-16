#!/usr/bin/env node
// Self-check of Tiers mode on Insight itself. Indexes the committed tree (git archive HEAD) into a temp folder, builds
// the System model and the Tiers model at the root scope, prints them as tables, and compares them with the expected
// Insight topology. Prints MISSING for an expected node or edge that is not drawn, and EXTRA for a drawn edge the
// expectation does not list. Exits 1 when anything is MISSING. Slow (a full index): run by hand, not from `pnpm test`.
//
// Usage: node scripts/check-tiers.mjs            (needs `pnpm -r build` first: it imports packages/*/dist)

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildProjectModel, systemModel, tierModel } from "../packages/core/model/dist/index.js";
import { projectPaths, readSnapshot, runIndex } from "../packages/core/indexer/dist/index.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Expected Insight topology (docs/system-view.md, "Tiers mode"). Nodes match by component path or by label pattern.
const EXPECTED_NODES = [
  { name: "apps/web", tier: "frontend", role: "spa", match: (n) => n.path === "apps/web" },
  { name: "apps/cli", tier: "frontend", role: "client", match: (n) => n.path === "apps/cli" },
  { name: "apps/server", tier: "backend", role: "server", platform: "node", match: (n) => n.path === "apps/server" },
  { name: "apps/hosted", tier: "backend", role: "function", platform: "vercel", match: (n) => n.path === "apps/hosted" },
  { name: "apps/storage-worker", tier: "backend", role: "worker", platform: "cloudflare", match: (n) => n.label === "insight-storage" || n.path === "apps/storage-worker" },
  { name: "Cloudflare KV", tier: "storage", match: (n) => /cloudflare.*kv|kv/i.test(n.label) && n.tier === "storage" },
  { name: "SQLite", tier: "storage", match: (n) => /sqlite/i.test(n.label) && n.tier === "storage" },
  { name: "Local disk", tier: "storage", match: (n) => /local disk/i.test(n.label) && n.tier === "storage" },
  { name: "GitHub API", tier: "external", match: (n) => /github api/i.test(n.label) },
  { name: "codeload", tier: "external", match: (n) => /codeload/i.test(n.label) },
  { name: "GitHub raw", tier: "external", match: (n) => /raw/i.test(n.label) },
  { name: "github.com", tier: "external", match: (n) => /^github\.com$/i.test(n.label) },
];

// Expected edges: from and to are expected node names, verb is the drawn verb. `confidence` is optional.
const EXPECTED_EDGES = [
  { from: "apps/web", to: "apps/server", verb: "requests" },
  { from: "apps/web", to: "apps/hosted", verb: "requests" },
  { from: "apps/web", to: "apps/storage-worker", verb: "reads", confidence: "inferred" },
  { from: "apps/web", to: "GitHub raw", verb: "reads" },
  { from: "apps/hosted", to: "Cloudflare KV", verb: "writes" },
  { from: "apps/hosted", to: "Cloudflare KV", verb: "reads" },
  { from: "apps/hosted", to: "GitHub API", verb: "reads" },
  { from: "apps/hosted", to: "codeload", verb: "reads" },
  // A POST to github.com (the OAuth token exchange in apps/hosted/src/auth.ts), so the verb is requests, not reads.
  { from: "apps/hosted", to: "github.com", verb: "requests" },
  { from: "apps/storage-worker", to: "Cloudflare KV", verb: "reads" },
  { from: "apps/server", to: "SQLite", verb: "opens" },
  { from: "apps/server", to: "Local disk" },
  { from: "apps/cli", to: "apps/server", verb: "spawns" },
  { from: "apps/cli", to: "apps/server", verb: "requests" },
];

function pad(s, n) {
  const t = String(s ?? "");
  return t.length >= n ? t.slice(0, n - 1) + (t.length > n ? "~" : "") : t + " ".repeat(n - t.length);
}

const stateDir = mkdtempSync(join(tmpdir(), "insight-check-tiers-state-"));
const src = mkdtempSync(join(tmpdir(), "insight-check-tiers-src-"));
let failed = false;
try {
  // The committed tree only: no worktrees, no node_modules, no dirty files.
  execFileSync("sh", ["-c", `git -C "${repoRoot}" archive --format=tar HEAD | tar -x -C "${src}"`], { stdio: "inherit" });
  const report = await runIndex({
    projectPath: src,
    builtinRoot: repoRoot,
    userPluginDir: join(stateDir, "no-user-plugins"),
    stateDir,
    full: true,
  });
  const records = readSnapshot(projectPaths(src, stateDir), report.snapshot);
  const model = buildProjectModel({
    nodes: records.flatMap((r) => ("node" in r ? [r.node] : [])),
    edges: records.flatMap((r) => ("edge" in r ? [r.edge] : [])),
    findings: records.flatMap((r) => ("finding" in r ? [r.finding] : [])),
  });
  const sys = systemModel(model, "");
  const tiers = tierModel(model, sys);

  console.log(`Tiers mode self-check: git archive HEAD of ${repoRoot}`);
  console.log(`scope "" (root), ${sys.components.length} components, ${tiers.nodes.length} tier nodes, ${tiers.edges.length} tier edges`);
  if (tiers.reason) console.log(`reason: ${tiers.reason}`);
  console.log("");
  console.log("Columns");
  for (const col of tiers.columns) console.log(`  ${pad(col.title, 12)} ${col.nodes.length} nodes`);
  console.log("");
  console.log(`${pad("TIER", 10)}${pad("NODE", 28)}${pad("ROLE", 10)}${pad("PLATFORM", 12)}${pad("PATH", 26)}ROUTES`);
  for (const n of tiers.nodes) {
    console.log(`${pad(n.tier, 10)}${pad(n.label, 28)}${pad(n.role ?? "-", 10)}${pad(n.platform ?? "-", 12)}${pad(n.path ?? "-", 26)}${n.routes}`);
  }
  console.log("");
  const label = new Map(tiers.nodes.map((n) => [n.id, n]));
  console.log(`${pad("FROM", 26)}${pad("VERB", 10)}${pad("TO", 26)}${pad("LABEL", 40)}${pad("CONF", 10)}${pad("COUNT", 7)}`);
  for (const e of tiers.edges) {
    console.log(
      `${pad(label.get(e.from)?.label ?? e.from, 26)}${pad(e.verb, 10)}${pad(label.get(e.to)?.label ?? e.to, 26)}${pad(e.label, 40)}${pad(e.confidence, 10)}${pad(e.count, 7)}`,
    );
  }
  console.log("");
  if (tiers.hidden) {
    console.log(`hidden: libraries=${tiers.hidden.libraries.length} unmatchedApi=${tiers.hidden.unmatchedApi} dev=${tiers.hidden.dev}`);
    console.log("");
  }

  // Compare with the expectation.
  const actualOf = new Map();
  for (const exp of EXPECTED_NODES) {
    const found = tiers.nodes.find((n) => exp.match(n));
    actualOf.set(exp.name, found);
    const detail = [exp.tier, exp.role, exp.platform].filter(Boolean).join(",");
    if (!found) {
      console.log(`MISSING node ${exp.name} (${detail})`);
      failed = true;
    } else if (found.tier !== exp.tier || (exp.role && found.role !== exp.role) || (exp.platform && found.platform !== exp.platform)) {
      console.log(`MISMATCH node ${exp.name}: expected ${detail}, drawn ${found.tier},${found.role ?? "-"},${found.platform ?? "-"}`);
      failed = true;
    }
  }
  const drawnEdge = (fromNode, toNode, verb, confidence) =>
    tiers.edges.filter(
      (e) =>
        fromNode && toNode &&
        e.from === fromNode.id &&
        e.to === toNode.id &&
        (verb === undefined || e.verb === verb) &&
        (confidence === undefined || e.confidence === confidence),
    );
  const matchedEdgeIds = new Set();
  for (const exp of EXPECTED_EDGES) {
    const f = actualOf.get(exp.from);
    const t = actualOf.get(exp.to);
    const hits = drawnEdge(f, t, exp.verb, exp.confidence);
    const what = `${exp.from} -${exp.verb ?? "any"}-> ${exp.to}${exp.confidence ? ` [${exp.confidence}]` : ""}`;
    if (hits.length === 0) {
      console.log(`MISSING edge ${what}`);
      failed = true;
    } else {
      for (const h of hits) matchedEdgeIds.add(h.id);
    }
  }
  for (const e of tiers.edges) {
    if (matchedEdgeIds.has(e.id)) continue;
    const f = label.get(e.from)?.label ?? e.from;
    const t = label.get(e.to)?.label ?? e.to;
    console.log(`EXTRA edge ${f} -${e.verb}-> ${t} [${e.confidence}] label="${e.label}" count=${e.count}`);
  }
  console.log("");
  console.log(failed ? "RESULT: FAIL (MISSING or MISMATCH above)" : "RESULT: PASS (every expected node and edge is drawn)");
} finally {
  rmSync(src, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
}
process.exitCode = failed ? 1 : 0;
