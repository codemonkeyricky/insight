#!/usr/bin/env node
// Indexes this repository with the real indexer and writes the result as static JSON for the demo build.
//
//   pnpm -r build && node scripts/capture-demo.mjs
//
// Output goes to apps/web/public/demo/. The web app reads it when built with VITE_STATIC=1
// (see apps/web/src/staticApi.ts). The indexed project is this checkout, so the demo always
// shows Insight analysing its own latest commit.
//
// Every scope the explorer can reach (the project, each folder, each openable file) also gets its
// lens listing under scope/<key>/lenses.json, and each lens result that has something to show gets
// scope/<key>/<lensId>.json. Those are read through the real server, so the demo matches the live app.
// A scope with at least one function also gets its call flow under scope/<key>/flow.json and its
// execution model (threads, coroutines, reach) under scope/<key>/exec.json.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildServer, loadSnapshot, resolveSnapshot } from "../apps/server/dist/index.js";
import { edgeTargets } from "../packages/sdk/dist/index.js";
import { buildFileFlow, summarizeFlows } from "../packages/flow/dist/index.js";
import { scopeKey } from "../apps/web/src/scopeKey.ts";
import { resultHasContent } from "../apps/web/src/scopeLenses.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "apps", "web", "public", "demo");
const REPO_URL = "https://github.com/codemonkeyricky/insight";
const MAX_FILE_BYTES = 256 * 1024;
/** The size budget for the whole demo. Over it, file scopes keep only KEEP_FILE_LENSES. */
const MAX_DEMO_BYTES = 40 * 1024 * 1024;
const KEEP_FILE_LENSES = new Set(["lens-execution", "lens-flow-complexity"]);

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

  const root = server.registry.rootOf(record);
  const snap = loadSnapshot(root, resolveSnapshot(root, undefined));
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
    // The call flow and execution model of the scope. A scope with no functions has nothing to draw,
    // so it writes neither file. The exec model is fetched only for those scopes, since each one
    // walks the whole graph once per thread and coroutine.
    const flow = await get(`${base}/scope/flow${q}`);
    const hasFunctions = flow.stats.functions > 0;
    const exec = hasFunctions ? await get(`${base}/scope/exec${q}`) : undefined;
    return { scope, kind: listing.kind, listing, runs, flow: hasFunctions ? flow : undefined, exec };
  };

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

  /** The scope files. Over the size budget, file scopes keep only KEEP_FILE_LENSES; the rest read as not captured. */
  const scopeFiles = (dropFileLenses) => {
    const out = new Map();
    for (const c of captured) {
      const dir = `scope/${scopeKey(c.scope)}`;
      const dropping = dropFileLenses && c.kind === "file";
      const rows = c.listing.lenses.map((row) => {
        const run = c.runs.get(row.id);
        const captures = row.status === "ok" && row.hasContent === true && run !== undefined;
        const dropped = captures && dropping && !KEEP_FILE_LENSES.has(row.id);
        if (captures && !dropped) out.set(`${dir}/${row.id}.json`, JSON.stringify(run));
        return dropped ? { id: row.id, title: row.title, status: "not-run", findings: null } : row;
      });
      out.set(`${dir}/lenses.json`, JSON.stringify({ ...c.listing, lenses: rows }));
      if (c.flow) out.set(`${dir}/flow.json`, JSON.stringify(c.flow));
      if (c.exec) out.set(`${dir}/exec.json`, JSON.stringify(c.exec));
    }
    return out;
  };

  const assemble = (dropFileLenses) => {
    const all = new Map(staticFiles);
    for (const [rel, text] of scopeFiles(dropFileLenses)) {
      if (all.has(rel)) throw new Error(`two demo files share the path ${rel}`);
      all.set(rel, text);
    }
    checkPaths(all);
    return all;
  };

  let out = assemble(false);
  const fullBytes = totalBytes(out);
  let capped = false;
  if (fullBytes > MAX_DEMO_BYTES) {
    out = assemble(true);
    capped = true;
  }
  const scopeEntries = [...out].filter(([rel]) => rel.startsWith("scope/"));
  const scopeBytes = scopeEntries.reduce((sum, [, text]) => sum + Buffer.byteLength(text), 0);
  // What the exec models add to the demo, measured on the final file set so a budget cap is reflected.
  const execEntries = [...out].filter(([rel]) => rel.startsWith("scope/") && rel.endsWith("/exec.json"));
  const execBytes = execEntries.reduce((sum, [, text]) => sum + Buffer.byteLength(text), 0);
  const execLargest = execEntries.reduce((max, [rel, text]) => (Buffer.byteLength(text) > max.bytes ? { rel, bytes: Buffer.byteLength(text) } : max), { rel: "", bytes: 0 });

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
  console.log(
    `exec models: ${execEntries.length} files, ${megabytes(execBytes)}, largest ${execLargest.rel} ${megabytes(execLargest.bytes)}; ` +
      `demo without them: ${out.size - execEntries.length} files, ${megabytes(totalBytes(out) - execBytes)}`,
  );
  if (capped) {
    console.log(
      `over ${megabytes(MAX_DEMO_BYTES)} with every scope capture (${megabytes(fullBytes)}): file scopes keep only ${[...KEEP_FILE_LENSES].join(", ")}`,
    );
  }
  console.log(`demo files: ${before.files} files, ${megabytes(before.bytes)} before -> ${after.files} files, ${megabytes(after.bytes)} after`);
} finally {
  await server.close();
  rmSync(home, { recursive: true, force: true });
}
