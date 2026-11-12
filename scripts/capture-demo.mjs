#!/usr/bin/env node
// Indexes this repository with the real indexer and writes the result as static JSON for the demo build.
//
//   pnpm -r build && node scripts/capture-demo.mjs
//
// Output goes to apps/web/public/demo/. The web app reads it when built with VITE_STATIC=1
// (see apps/web/src/staticApi.ts). The indexed project is this checkout, so the demo always
// shows Insight analysing its own latest commit.
//
// The project's whole model (the IR document, serialized by @insight/model) is written once, as model.json. The
// browser builds each scope's call flow and execution model from it, the way the live server does, so the demo
// writes no per-scope flow or exec files. Every scope the explorer can reach (the project, each folder, each
// openable file) gets its lens listing under scope/<key>/lenses.json, and each lens result that has something to
// show gets scope/<key>/<lensId>.json. Those are read through the real server, so the demo matches the live app.
// A scope with at least one function also gets the execution canvas's layout of its execution model under
// scope/<key>/exec-layout.json, so the static demo does not lay it out on load (the layout is solved here, from the model).
// The project's package architecture is written once, under the root scope, as scope/@root/arch.json.
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildServer, loadSnapshot, resolveSnapshot } from "../apps/server/dist/index.js";
import { projectPaths } from "../packages/core/indexer/dist/index.js";
import { edgeTargets } from "../packages/core/sdk/dist/index.js";
import { buildExecScene, buildFileFlow, execDefaultOpen, layoutScene, summarizeFlows } from "../packages/core/flow/dist/index.js";
import { serializeModel } from "../packages/core/model/dist/index.js";
import { scopeKey } from "../apps/web/src/scopeKey.ts";
import { resultHasContent } from "../apps/web/src/scopeLenses.ts";
// The same functions the browser runs to answer /scope/flow and /scope/exec, so the layouts match what the page would solve.
import { scopeExecFor, scopeFlowFor } from "../apps/web/src/model/payloads.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "apps", "web", "public", "demo");
const REPO_URL = "https://github.com/codemonkeyricky/insight";
const MAX_FILE_BYTES = 256 * 1024;
/**
 * The size budget for the whole demo. Over it, file scopes keep only KEEP_FILE_LENSES; still over it, folder scopes do
 * too. The project scope always keeps every lens.
 */
const MAX_DEMO_BYTES = 40 * 1024 * 1024;
// lens-execution is not here: the execution canvas replaced its tab, and its links redirect to the flow tab.
const KEEP_FILE_LENSES = new Set(["lens-flow-complexity"]);
/** How far the budget trims: 0 keeps everything, 1 trims file scopes, 2 trims folder scopes too. */
const TRIM_LEVELS = ["none", "file scopes", "file and folder scopes"];
// The same elkjs the web app's worker runs, in its bundled form, which works under Node.
const ELK = createRequire(join(ROOT, "apps", "web", "package.json"))("elkjs/lib/elk.bundled.js");

/** Positions to a tenth of a unit: a layout's JSON is mostly numbers, and the page draws no finer than that. */
function roundLayout(layout) {
  const r = (n) => Math.round(n * 10) / 10;
  const containers = {};
  for (const [id, c] of Object.entries(layout.containers)) {
    containers[id] = { w: r(c.w), h: r(c.h), slots: c.slots.map((s) => ({ id: s.id, x: r(s.x), y: r(s.y), w: r(s.w), h: r(s.h) })) };
  }
  return { containers };
}

/** File count and bytes under a directory, or zeros when it does not exist. */
function dirStats(dir) {
  const stats = { files: 0, bytes: 0 };
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile()) {
        stats.files += 1;
        stats.bytes += statSync(p).size;
      }
    }
  };
  try {
    walk(dir);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  return stats;
}

const megabytes = (bytes) => `${(bytes / (1024 * 1024)).toFixed(2)} MB`;

/** "a/b/c.ts" gives the scopes "a", "a/b" and "a/b/c.ts". */
function scopesOf(path) {
  const parts = path.split("/");
  return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
}

/**
 * True when URI encoding leaves every segment alone. A static host decodes the request path, so a
 * name that encoding changes could not be found under its encoded name.
 */
function isPlain(path) {
  return path.split("/").every((segment) => encodeURIComponent(segment) === segment);
}

function totalBytes(files) {
  let bytes = 0;
  for (const text of files.values()) bytes += Buffer.byteLength(text);
  return bytes;
}

/** The demo's files must be distinct, and no file may sit where another file needs a folder. */
function checkPaths(files) {
  const folders = new Set();
  for (const rel of files.keys()) {
    const parts = rel.split("/");
    for (let i = 1; i < parts.length; i += 1) folders.add(parts.slice(0, i).join("/"));
  }
  for (const rel of files.keys()) {
    if (folders.has(rel)) throw new Error(`demo file ${rel} is also the folder of another demo file`);
  }
}

const before = dirStats(OUT);
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
  const { files: fileList } = await get(`${base}/files`);

  const paths = projectPaths(server.registry.rootOf(record), server.registry.stateOf(record));
  const snap = loadSnapshot(paths, resolveSnapshot(paths, undefined));
  const model = snap.model;
  const snapshotId = overview.snapshot.id;
  const nodes = [...snap.nodes.values()];
  const incoming = {};
  snap.edges.forEach((e, i) => {
    for (const t of edgeTargets(e).nodes) (incoming[t] ??= []).push(i);
  });

  // Source text for every indexed file and every file a span points at, so the source panel and
  // the explorer work without a server.
  const files = new Set(fileList.map((f) => f.path));
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

  // Only files whose text was captured can be opened in the browser, so only those are listed as openable.
  const openableEntries = fileList.filter((f) => sources[f.path] !== undefined);
  const skipped = [];

  // Scopes: the project, then every folder and openable file. The explorer lists only those.
  const named = [...new Set(openableEntries.flatMap((f) => scopesOf(f.path)))].sort();
  const scopes = ["", ...named].filter((scope) => {
    if (isPlain(scope)) return true;
    skipped.push(scope);
    return false;
  });

  /**
   * One scope's listing and lens results. Every lens runs on the scope first, so each stored result
   * the listing reports is the one the server would answer with.
   */
  const captureScope = async (scope) => {
    const q = `?path=${encodeURIComponent(scope)}`;
    const initial = await get(`${base}/scope/lenses${q}`);
    const runs = new Map();
    for (const row of initial.lenses) {
      runs.set(row.id, await get(`${base}/scope/lenses/${encodeURIComponent(row.id)}${q}`));
    }
    const listing = await get(`${base}/scope/lenses${q}`);
    for (const row of listing.lenses) {
      const run = runs.get(row.id);
      if (row.status === "ok" && run) row.hasContent = resultHasContent(run.lens.result ?? { findings: [], views: [] });
    }
    // The call flow and execution model come from the model, as the browser computes them. A scope with no
    // functions has nothing to lay out. The exec model is built only for the others.
    const hasFunctions = scopeFlowFor(snapshotId, model, scope).stats.functions > 0;
    // The canvas lays the whole scene out once; zoom only changes what is drawn open, so this one layout serves it.
    let execLayout;
    if (hasFunctions) {
      const exec = scopeExecFor(snapshotId, model, scope);
      const t0 = performance.now();
      // Laid out with the containers the first view opens (execDefaultOpen); the canvas opens more from this one.
      const scene = buildExecScene(exec);
      execLayout = roundLayout(await layoutScene(scene, (g) => elk.layout(g), { open: execDefaultOpen(scene) }));
      layoutTimes.push({ scope, ms: performance.now() - t0 });
    }
    // The architecture covers the whole project, so only the root scope asks for it and writes it.
    const arch = scope === "" ? await get(`${base}/scope/arch${q}`) : undefined;
    return { scope, kind: listing.kind, listing, runs, execLayout, arch };
  };

  const elk = new ELK();
  const layoutTimes = [];
  const captured = [];
  for (const scope of scopes) {
    captured.push(await captureScope(scope));
    if (captured.length % 100 === 0) console.log(`  captured ${captured.length} of ${scopes.length} scopes`);
  }

  // Everything the demo serves except the scope captures, built once.
  const staticFiles = new Map();
  const put = (rel, value) => staticFiles.set(rel, JSON.stringify(value));
  put("project.json", { project: shown, overview });
  put("lenses.json", lenses);
  put("findings.json", findings);
  put("graph.json", { snapshot: overview.snapshot.id, nodes, edges: snap.edges, incoming });
  put("model.json", serializeModel(model, snapshotId));
  put("sources.json", sources);
  put("files.json", openableEntries);

  // The flow views: a summary for folders and the project, and one chart per captured file. Charts
  // are rebuilt from the same IR the server reads, so the demo draws what the live app would.
  put("flow-summary.json", { snapshot: overview.snapshot.id, files: summarizeFlows(nodes, snap.edges) });
  const nodesByFile = new Map();
  for (const n of nodes) {
    if (!n.span) continue;
    const list = nodesByFile.get(n.span.file) ?? [];
    list.push(n);
    nodesByFile.set(n.span.file, list);
  }
  const edgesByFile = new Map();
  for (const e of snap.edges) {
    if (!e.span) continue;
    const list = edgesByFile.get(e.span.file) ?? [];
    list.push(e);
    edgesByFile.set(e.span.file, list);
  }
  for (const file of Object.keys(sources)) {
    if (!isPlain(file)) {
      skipped.push(file);
      continue;
    }
    const chart = buildFileFlow(file, nodesByFile.get(file) ?? [], edgesByFile.get(file) ?? []);
    // A file with no functions has no chart; staticApi answers that case with an empty one.
    if (chart.functions.length === 0) continue;
    staticFiles.set(`flow/${file}.json`, JSON.stringify(chart));
  }

  let commit = overview.snapshot.commit ?? "unknown";
  try {
    commit = execFileSync("git", ["-C", ROOT, "log", "-1", "--format=%h %cs %s"], { encoding: "utf8" }).trim();
  } catch {
    /* no git history available */
  }
  put("meta.json", { capturedAt: new Date().toISOString(), commit, nodes: nodes.length, edges: snap.edges.length, files: Object.keys(sources).length });

  /** The scope files. Over the size budget, trimmed scopes keep only KEEP_FILE_LENSES; the rest read as not captured. */
  const scopeFiles = (trim) => {
    const out = new Map();
    for (const c of captured) {
      const dir = `scope/${scopeKey(c.scope)}`;
      const dropping = (trim >= 1 && c.kind === "file") || (trim >= 2 && c.kind === "folder");
      const rows = c.listing.lenses.map((row) => {
        const run = c.runs.get(row.id);
        const captures = row.status === "ok" && row.hasContent === true && run !== undefined;
        const dropped = captures && dropping && !KEEP_FILE_LENSES.has(row.id);
        if (captures && !dropped) out.set(`${dir}/${row.id}.json`, JSON.stringify(run));
        return dropped ? { id: row.id, title: row.title, status: "not-run", findings: null } : row;
      });
      out.set(`${dir}/lenses.json`, JSON.stringify({ ...c.listing, lenses: rows }));
      if (c.execLayout) out.set(`${dir}/exec-layout.json`, JSON.stringify(c.execLayout));
      if (c.arch) out.set(`${dir}/arch.json`, JSON.stringify(c.arch));
    }
    return out;
  };

  const assemble = (trim) => {
    const all = new Map(staticFiles);
    for (const [rel, text] of scopeFiles(trim)) {
      if (all.has(rel)) throw new Error(`two demo files share the path ${rel}`);
      all.set(rel, text);
    }
    checkPaths(all);
    return all;
  };

  let out = assemble(0);
  const fullBytes = totalBytes(out);
  let trimmed = 0;
  while (totalBytes(out) > MAX_DEMO_BYTES && trimmed < TRIM_LEVELS.length - 1) {
    trimmed += 1;
    out = assemble(trimmed);
  }
  const scopeEntries = [...out].filter(([rel]) => rel.startsWith("scope/"));
  const scopeBytes = scopeEntries.reduce((sum, [, text]) => sum + Buffer.byteLength(text), 0);

  const layoutEntries = [...out].filter(([rel]) => rel.startsWith("scope/") && rel.endsWith("/exec-layout.json"));
  const layoutBytes = layoutEntries.reduce((sum, [, text]) => sum + Buffer.byteLength(text), 0);
  const layoutMs = layoutTimes.reduce((sum, t) => sum + t.ms, 0);
  const slowest = layoutTimes.reduce((max, t) => (t.ms > max.ms ? t : max), { scope: "", ms: 0 });

  rmSync(OUT, { recursive: true, force: true });
  for (const [rel, text] of out) {
    const target = join(OUT, ...rel.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
  }
  const after = dirStats(OUT);

  if (skipped.length > 0) {
    console.warn(`skipped ${skipped.length} names that URI encoding would change, so a static host could not find them: ${skipped.slice(0, 5).join(", ")}`);
  }
  console.log(`captured ${nodes.length} nodes, ${snap.edges.length} edges, ${findings.length} findings, ${Object.keys(sources).length} files -> ${OUT}`);
  console.log(`scope captures: ${captured.length} scopes, ${scopeEntries.length} files, ${megabytes(scopeBytes)}`);
  const modelBytes = Buffer.byteLength(out.get("model.json") ?? "");
  console.log(`model: model.json ${megabytes(modelBytes)}; scope flows and exec models are computed in the browser, not captured`);
  console.log(
    `exec layouts: ${layoutEntries.length} files, ${megabytes(layoutBytes)}, ${(layoutMs / 1000).toFixed(1)} s to lay out, ` +
      `slowest ${slowest.scope === "" ? "(project)" : slowest.scope} ${slowest.ms.toFixed(0)} ms`,
  );
  if (trimmed > 0) {
    console.log(
      `over ${megabytes(MAX_DEMO_BYTES)} with every scope capture (${megabytes(fullBytes)}): ` +
        `${TRIM_LEVELS[trimmed]} keep only ${[...KEEP_FILE_LENSES].join(", ")}; now ${megabytes(totalBytes(out))}` +
        (totalBytes(out) > MAX_DEMO_BYTES ? " (still over the budget)" : ""),
    );
  }
  console.log(`demo files: ${before.files} files, ${megabytes(before.bytes)} before -> ${after.files} files, ${megabytes(after.bytes)} after`);
} finally {
  await server.close();
  rmSync(home, { recursive: true, force: true });
}
