#!/usr/bin/env node
// Indexes this repository with the real indexer and writes the result as static JSON for the demo build.
//
//   pnpm -r build && node scripts/capture-demo.mjs
//
// Output goes to apps/web/public/demo/. The web app reads it when built with VITE_STATIC=1
// (see apps/web/src/staticApi.ts). The indexed project is this checkout, so the demo always
// shows Insight analysing its own latest commit.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildServer, loadSnapshot, resolveSnapshot } from "../apps/server/dist/index.js";
import { edgeTargets } from "../packages/sdk/dist/index.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "apps", "web", "public", "demo");
const REPO_URL = "https://github.com/codemonkeyricky/insight";
const MAX_FILE_BYTES = 256 * 1024;

const home = mkdtempSync(join(tmpdir(), "insight-demo-"));
const server = await buildServer({ home, intervalMs: 0, webDist: null, autostart: false });
try {
  const record = server.registry.add({ path: ROOT, name: "insight", allowBuildTools: false });
  server.jobs.trigger(record.id, { full: true });
  await server.jobs.whenIdle(record.id);

  const get = async (url) => {
    const res = await server.app.inject({ url });
    if (res.statusCode !== 200) throw new Error(`${url} -> ${res.statusCode} ${res.body}`);
    return res.json();
  };
  const base = `/api/projects/${record.id}`;
  const { project } = await get(base);
  if (project.status === "error") throw new Error(`indexing failed: ${project.error}`);
  const overview = await get(`${base}/overview`);
  if (!overview.snapshot) throw new Error("indexing produced no snapshot");

  // The demo shows the public repository, not the machine it was captured on.
  const shown = { ...project, source: { kind: "git", url: REPO_URL }, status: "idle", queued: false, error: undefined };
  overview.project = shown;
  overview.snapshots = overview.snapshots.filter((s) => s.id === overview.snapshot.id);

  const lenses = {};
  for (const l of overview.lenses) lenses[l.id] = (await get(`${base}/lenses/${l.id}`)).lens;
  const { findings } = await get(`${base}/findings`);

  const root = server.registry.rootOf(record);
  const snap = loadSnapshot(root, resolveSnapshot(root, undefined));
  const nodes = [...snap.nodes.values()];
  const incoming = {};
  snap.edges.forEach((e, i) => {
    for (const t of edgeTargets(e).nodes) (incoming[t] ??= []).push(i);
  });

  // Source text for every file a span points at, so the source panel works without a server.
  const files = new Set();
  const spanFile = (s) => {
    if (s && typeof s.file === "string") files.add(s.file);
  };
  for (const n of nodes) spanFile(n.span);
  for (const e of snap.edges) spanFile(e.span);
  for (const f of findings) spanFile(f.span);
  for (const l of Object.values(lenses)) {
    for (const v of l.result?.views ?? []) {
      for (const n of v.nodes ?? []) spanFile(n.span);
      for (const e of v.edges ?? []) spanFile(e.span);
    }
  }
  const sources = {};
  for (const rel of [...files].sort()) {
    try {
      const text = readFileSync(join(ROOT, rel), "utf8");
      if (Buffer.byteLength(text) <= MAX_FILE_BYTES) sources[rel] = text;
    } catch {
      /* a span can name a file that is gone; the source panel then says so */
    }
  }

  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  const put = (name, value) => writeFileSync(join(OUT, name), JSON.stringify(value));
  put("project.json", { project: shown, overview });
  put("lenses.json", lenses);
  put("findings.json", findings);
  put("graph.json", { snapshot: overview.snapshot.id, nodes, edges: snap.edges, incoming });
  put("sources.json", sources);

  let commit = overview.snapshot.commit ?? "unknown";
  try {
    commit = execFileSync("git", ["-C", ROOT, "log", "-1", "--format=%h %cs %s"], { encoding: "utf8" }).trim();
  } catch {
    /* no git history available */
  }
  put("meta.json", { capturedAt: new Date().toISOString(), commit, nodes: nodes.length, edges: snap.edges.length, files: Object.keys(sources).length });
  console.log(`captured ${nodes.length} nodes, ${snap.edges.length} edges, ${findings.length} findings, ${Object.keys(sources).length} files -> ${OUT}`);
} finally {
  await server.close();
  rmSync(home, { recursive: true, force: true });
}
