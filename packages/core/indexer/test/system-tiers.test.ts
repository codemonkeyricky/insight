import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IRDocument } from "@insight/ir";
import { buildProjectModel, systemModel, tierModel, type SystemModel, type TierModel } from "@insight/model";
import { projectPaths, readSnapshot, runIndex } from "../src/index.js";

// Tiers mode (frontend -> backend -> storage) over the tiers-app golden fixture: a Vite SPA, a fastify server with a
// better-sqlite3 store, a Vercel function that writes Cloudflare KV and reads the GitHub API, and a Cloudflare Worker
// that reads its KV binding. The copy runs in scratch, so the fixture never gets an .insight/ directory.
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..", "..");
const SCRATCH = join(here, "..", ".insight-test", `system-tiers-${process.pid}`);
const project = join(SCRATCH, "tiers-app");
const stateDir = join(SCRATCH, "state");

let sys: SystemModel;
let tiers: TierModel;

beforeAll(async () => {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(SCRATCH, { recursive: true });
  cpSync(join(here, "fixtures", "tiers-app"), project, { recursive: true });
  const report = await runIndex({
    projectPath: project,
    builtinRoot: repoRoot,
    userPluginDir: join(SCRATCH, "no-user-plugins"),
    stateDir,
    full: true,
  });
  const records = readSnapshot(projectPaths(project, stateDir), report.snapshot);
  const doc: IRDocument = {
    nodes: records.flatMap((r) => ("node" in r ? [r.node] : [])),
    edges: records.flatMap((r) => ("edge" in r ? [r.edge] : [])),
    findings: records.flatMap((r) => ("finding" in r ? [r.finding] : [])),
  };
  const model = buildProjectModel(doc);
  sys = systemModel(model, "");
  tiers = tierModel(model, sys);
}, 120_000);

afterAll(() => {
  // Remove only this suite's scratch, since the other core suites run in parallel workers.
  rmSync(SCRATCH, { recursive: true, force: true });
});

/** One line per node: tier/role/platform/label. */
const nodeLine = (n: TierModel["nodes"][number]) => `${n.tier}/${n.role ?? "-"}/${n.platform ?? "-"}/${n.label}`;

describe("tiers-app golden fixture, Tiers mode", () => {
  it("draws exactly the expected nodes", () => {
    expect(tiers.nodes.map(nodeLine).sort()).toEqual(
      [
        "frontend/spa/browser/web",
        "backend/server/node/server",
        "backend/function/vercel/fn",
        "backend/worker/cloudflare/fixture-storage",
        "storage/-/-/Cloudflare KV",
        "storage/-/-/SQLite",
        "external/-/-/GitHub API",
        "external/-/-/GitHub raw",
      ].sort(),
    );
  });

  it("draws exactly the expected edges", () => {
    const label = new Map(tiers.nodes.map((n) => [n.id, n.label]));
    const edgeLine = (e: TierModel["edges"][number]) =>
      `${label.get(e.from)} -${e.verb}-> ${label.get(e.to)} [${e.confidence}]`;
    expect(tiers.edges.map(edgeLine).sort()).toEqual(
      [
        "web -requests-> server [exact]",
        "web -requests-> fn [exact]",
        "web -reads-> fixture-storage [inferred]",
        "web -reads-> GitHub raw [exact]",
        "fn -writes-> Cloudflare KV [exact]",
        "fn -reads-> GitHub API [exact]",
        "fixture-storage -reads-> Cloudflare KV [exact]",
        "server -opens-> SQLite [exact]",
      ].sort(),
    );
  });

  it("puts each tier in its column, left to right", () => {
    expect(tiers.reason).toBeUndefined();
    expect(tiers.columns.map((c) => c.tier)).toEqual(["frontend", "backend", "storage", "external"]);
  });

  it("draws nothing from scripts/ or test folders", () => {
    expect(tiers.nodes.some((n) => /(^|\/)(scripts|tests?)(\/|$)/.test(n.path ?? ""))).toBe(false);
    for (const e of tiers.edges) {
      expect(e.sites.some((s) => /(^|\/)(scripts|tests?)\//.test(s.file))).toBe(false);
    }
  });

  it("reads the Worker's wrangler.toml, so the Worker is a Cloudflare backend", () => {
    const worker = tiers.nodes.find((n) => n.tier === "backend" && n.role === "worker");
    expect(worker).toMatchObject({ platform: "cloudflare", label: "fixture-storage" });
  });

  it("keeps the system model's component list free of tests and fixtures", () => {
    // scripts/ stays in the System model (Runtime view); tierModel is what drops it from Tiers.
    expect(sys.components.some((c) => /(^|\/)(test|tests|fixtures)(\/|$)/.test(c.path))).toBe(false);
  });
});
