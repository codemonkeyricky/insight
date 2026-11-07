import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import picomatch from "picomatch";
import { CORE_FACETS, validateIR, type IRRecord } from "@insight/ir";
import type { Frontend, IRBatch, ProjectRoot } from "@insight/sdk";
import { link, type LinkShard } from "./linker.js";
import { loadPlugins, type DisabledPlugin, type LoadOptions } from "./loader.js";
import { diffTrees, scanProject, type StatCache, type TreeDiff, type TreeNode } from "./merkle.js";
import { projectPaths, type ProjectPaths } from "./paths.js";
import { computeCoverage, type CoverageRow, type CoverageShard } from "./coverage.js";
import { writeIndex, readIndexedSnapshot } from "./indexdb.js";
import { KEEP_SNAPSHOTS, loadState, saveState, type FrontendState, type IndexState, type ShardEntry } from "./state.js";
import { gcShards, readShard, shardKey, shardName, writeShard } from "./shards.js";
import { deleteSnapshot, serializeDocument, snapshotExists, snapshotId, writeSnapshot } from "./snapshots.js";
import { canonicalJson, readJsonFile, sha256, writeFileAtomic } from "./util.js";

export interface IndexOptions extends LoadOptions {
  /** Ignore every cached shard and re-extract everything. */
  full?: boolean;
  /** Whether build tools (bazel, cmake) may run. Off by default. */
  allowBuildTools?: boolean;
  /** Receives progress lines as they happen. */
  onProgress?: (line: string) => void;
}

export interface IndexReport {
  projectPath: string;
  durationMs: number;
  snapshot: string;
  snapshotChanged: boolean;
  nodes: number;
  edges: number;
  findings: number;
  resolved: number;
  unresolved: number;
  /** Frontends that ran, with the number of files they cover. */
  frontends: { id: string; version: string; files: number }[];
  /** Frontends that did not run, and why. */
  skipped: { id: string; reason: string }[];
  disabled: DisabledPlugin[];
  /** Files re-extracted in this run. */
  extracted: { frontend: string; file: string }[];
  /** Files whose cached shard was reused. */
  reused: number;
  /** Files whose extraction failed, with the reason. An error finding records each in the snapshot. */
  failed: { frontend: string; file: string; message: string }[];
  /** Files no longer produced by any frontend. */
  removed: { frontend: string; file: string }[];
  changes: TreeDiff;
  /** Files whose content was read because the stat cache did not match. */
  rehashed: number;
  coverage: CoverageRow[];
  /** Problems the validator found in the linked IR. Empty for a healthy run. */
  problems: string[];
  logs: string[];
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function errorRecord(file: string, message: string): IRRecord {
  return { finding: { severity: "error", message, span: { file, start: [0, 0], end: [0, 0] } } };
}

/** Candidate paths a relative import could resolve to. Used as dependencies, so creating one re-extracts the importer. */
export function importCandidates(fromFile: string, specifier: string): string[] {
  const base = join(fromFile, "..", specifier).split("\\").join("/");
  const normal = base.replace(/^\.\//, "");
  const exts = [".ts", ".tsx", ".d.ts", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"];
  const out = new Set<string>([normal]);
  for (const e of exts) {
    out.add(`${normal}${e}`);
    out.add(`${normal}/index${e}`);
  }
  return [...out];
}

/**
 * Indexes a project. Each frontend's files are extracted only when their shard is stale, so an
 * unchanged project does no extraction. The linked graph is rebuilt from the shards every run.
 */
export async function runIndex(opts: IndexOptions): Promise<IndexReport> {
  const started = Date.now();
  const root = resolve(opts.projectPath);
  if (!existsSync(root)) throw new Error(`project path does not exist: ${root}`);
  const paths: ProjectPaths = projectPaths(root);
  mkdirSync(paths.shards, { recursive: true });
  mkdirSync(paths.snapshots, { recursive: true });

  const logs: string[] = [];
  const say = (line: string) => {
    logs.push(line);
    opts.onProgress?.(line);
  };

  const plugins = await loadPlugins({ ...opts, projectPath: root });
  for (const d of plugins.disabled) say(`plugin ${d.id} disabled: ${d.reason}`);
  const projectRoot: ProjectRoot = {
    path: root,
    name: basename(root),
    allowBuildTools: opts.allowBuildTools ?? false,
  };

  const previousTree = readJsonFile<TreeNode | undefined>(paths.treeFile, undefined);
  const previousStats = readJsonFile<StatCache>(paths.statCache, {});
  const scan = scanProject(root, previousStats);
  const changes = diffTrees(previousTree, scan.tree);
  const allFiles = [...scan.files.keys()];

  const prior: IndexState = loadState(paths);
  const state: IndexState = opts.full ? { ...prior, frontends: {} } : prior;

  const textCache = new Map<string, string>();
  const readText = async (rel: string): Promise<string> => {
    let text = textCache.get(rel);
    if (text === undefined) {
      text = readFileSync(join(root, rel), "utf8");
      textCache.set(rel, text);
    }
    return text;
  };

  const digestCache = new Map<string, string>();
  /** The digest a dependent sees for one file. Uses the dependent frontend's apiDigest when it has one. */
  const digestFor = async (frontend: Frontend, rel: string): Promise<string> => {
    if (!scan.files.has(rel)) return "missing";
    const cacheKey = `${frontend.id}\0${rel}`;
    const cached = digestCache.get(cacheKey);
    if (cached !== undefined) return cached;
    const digest = frontend.apiDigest
      ? `api:${frontend.apiDigest(rel, await readText(rel))}`
      : `hash:${scan.files.get(rel)}`;
    digestCache.set(cacheKey, digest);
    return digest;
  };

  const depsCurrent = async (deps: Record<string, string>, frontend: Frontend): Promise<boolean> => {
    for (const [path, digest] of Object.entries(deps)) {
      if ((await digestFor(frontend, path)) !== digest) return false;
    }
    return true;
  };

  const extracted: { frontend: string; file: string }[] = [];
  const failed: { frontend: string; file: string; message: string }[] = [];
  const removed: { frontend: string; file: string }[] = [];
  const skipped: { id: string; reason: string }[] = [];
  const frontendReports: { id: string; version: string; files: number }[] = [];
  const nextFrontends: Record<string, FrontendState> = {};
  const ran: { id: string; frontend: Frontend; files: string[] }[] = [];
  let reused = 0;

  for (const lf of plugins.frontends) {
    const { manifest, frontend } = lf;
    let detection: { reason: string } | null;
    try {
      detection = await frontend.detect(projectRoot);
    } catch (err) {
      skipped.push({ id: manifest.id, reason: `detect failed: ${errorText(err)}` });
      say(`${manifest.id}: detect failed, skipped`);
      continue;
    }
    if (!detection) {
      skipped.push({ id: manifest.id, reason: "not detected in this project" });
      continue;
    }

    const fileMatch = picomatch(manifest.files ?? manifest.detect ?? ["**/*"]);
    const inputGlobs = manifest.inputs ?? [];
    const inputMatch = inputGlobs.length > 0 ? picomatch(inputGlobs) : () => false;
    const files = allFiles.filter((f) => fileMatch(f));
    const inputFiles = allFiles.filter((f) => inputMatch(f));
    const inputsHash = sha256(canonicalJson(inputFiles.map((p) => [p, scan.files.get(p)])));

    const previous = state.frontends[manifest.id];
    const reusable = previous && previous.version === frontend.version && previous.inputsHash === inputsHash ? previous : undefined;
    const entries: Record<string, ShardEntry> = {};
    const toExtract: string[] = [];

    for (const f of files) {
      const key = shardKey({
        frontend: manifest.id,
        version: frontend.version,
        file: f,
        hash: scan.files.get(f),
        inputsHash,
      });
      const old = reusable?.files[f];
      if (
        old &&
        old.key === key &&
        existsSync(join(paths.shards, shardName(old.key))) &&
        (await depsCurrent(old.deps, frontend))
      ) {
        entries[f] = old;
        reused++;
      } else {
        toExtract.push(f);
      }
    }
    for (const f of Object.keys(previous?.files ?? {})) {
      if (!files.includes(f)) removed.push({ frontend: manifest.id, file: f });
    }

    if (toExtract.length > 0) {
      say(`${manifest.id}: extracting ${toExtract.length} of ${files.length} files`);
      const batches = new Map<string, IRBatch>();
      const failures = new Map<string, string>();
      // Runs the frontend over some files. A throw is recorded against the files it had not yet yielded.
      const runOver = async (targets: string[]): Promise<void> => {
        try {
          for await (const batch of frontend.extract({
            root: projectRoot,
            files: targets,
            listFiles: () => allFiles,
            readFile: readText,
            log: (m) => say(`${manifest.id}: ${m}`),
          })) {
            batches.set(batch.file, batch);
          }
        } catch (err) {
          const failure = errorText(err);
          say(`${manifest.id}: extraction failed: ${failure}`);
          for (const t of targets) if (!batches.has(t)) failures.set(t, failure);
        }
      };
      await runOver(toExtract);
      // A throw ends the frontend's generator, so the files after it were never tried. Retry each of
      // those alone, so one bad file cannot fail its neighbours.
      const retry = toExtract.filter((f) => failures.has(f) && !batches.has(f));
      failures.clear();
      for (const f of retry) await runOver([f]);

      for (const f of toExtract) {
        const batch = batches.get(f);
        const failure = failures.get(f);
        const records: IRRecord[] = batch ? [...batch.records] : [];
        if (!batch) {
          const message = failure ? `extraction failed: ${failure}` : "frontend produced no batch for this file";
          records.push(errorRecord(f, message));
          failed.push({ frontend: manifest.id, file: f, message });
        }
        const deps: Record<string, string> = {};
        const depPaths = [...new Set(batch?.dependsOn ?? [])].filter((d) => d !== f).sort();
        for (const d of depPaths) deps[d] = await digestFor(frontend, d);
        const key = shardKey({
          frontend: manifest.id,
          version: frontend.version,
          file: f,
          hash: scan.files.get(f),
          inputsHash,
        });
        writeShard(paths.shards, key, records);
        entries[f] = {
          key,
          deps,
          errors: records.filter((r) => "finding" in r && r.finding.severity === "error").length,
        };
        extracted.push({ frontend: manifest.id, file: f });
      }
    }

    nextFrontends[manifest.id] = { version: frontend.version, inputsHash, files: entries };
    frontendReports.push({ id: manifest.id, version: frontend.version, files: files.length });
    ran.push({ id: manifest.id, frontend, files });
  }

  // Shards no current entry refers to are deleted.
  const keep = new Set<string>();
  for (const st of Object.values(nextFrontends)) {
    for (const e of Object.values(st.files)) keep.add(shardName(e.key));
  }
  gcShards(paths.shards, keep);

  const shards: LinkShard[] = [];
  const coverageShards: CoverageShard[] = [];
  for (const { id, files } of ran) {
    const st = nextFrontends[id];
    for (const f of files) {
      const entry = st?.files[f];
      const records = entry ? (readShard(paths.shards, entry.key) ?? []) : [];
      shards.push({ frontend: id, file: f, records });
      const facets = new Map<string, { nodes: number; edges: number }>();
      let errors = 0;
      for (const r of records) {
        if ("node" in r) {
          const c = facets.get(r.node.facet) ?? { nodes: 0, edges: 0 };
          c.nodes++;
          facets.set(r.node.facet, c);
        } else if ("edge" in r) {
          const c = facets.get(r.edge.facet) ?? { nodes: 0, edges: 0 };
          c.edges++;
          facets.set(r.edge.facet, c);
        } else if (r.finding.severity === "error") {
          errors++;
        }
      }
      coverageShards.push({ frontend: id, file: f, facets, errors });
    }
  }

  const linked = await link({
    root: projectRoot,
    files: allFiles,
    shards,
    resolvers: plugins.resolvers.map((r) => ({ id: r.manifest.id, resolver: r.resolver })),
  });
  const text = serializeDocument(linked.doc);
  const validation = validateIR(text, plugins.registry, { closed: true });
  const problems = validation.errors.slice(0, 50).map((e) => (e.line ? `line ${e.line}: ${e.message}` : e.message));

  const id = snapshotId(text);
  const previousLatest = state.latest;
  let snapshotChanged = previousLatest !== id;
  if (!snapshotExists(paths, id)) writeSnapshot(paths, id, text);
  if (!state.snapshots.some((s) => s.id === id)) {
    state.snapshots.push({
      id,
      createdAt: new Date().toISOString(),
      nodes: linked.doc.nodes.length,
      edges: linked.doc.edges.length,
      findings: linked.doc.findings.length,
    });
    while (state.snapshots.length > KEEP_SNAPSHOTS) {
      const old = state.snapshots.shift();
      if (old && old.id !== id) deleteSnapshot(paths, old.id);
    }
  }
  state.latest = id;

  if (readIndexedSnapshot(paths.indexDb) !== id) {
    writeIndex(paths.indexDb, linked.doc, id);
  }

  state.frontends = nextFrontends;
  saveState(paths, state);
  writeFileAtomic(paths.treeFile, JSON.stringify(scan.tree));
  writeFileAtomic(paths.statCache, JSON.stringify(scan.stats));

  const coverage = computeCoverage({
    facets: CORE_FACETS,
    frontends: ran.map((r) => ({ id: r.id, provides: [...r.frontend.provides] })),
    shards: coverageShards,
    coreFiles: allFiles.length,
  });

  say(
    extracted.length === 0
      ? "no changes: nothing extracted"
      : `extracted ${extracted.length} file(s), reused ${reused}`,
  );

  return {
    projectPath: root,
    durationMs: Date.now() - started,
    snapshot: id,
    snapshotChanged,
    nodes: linked.doc.nodes.length,
    edges: linked.doc.edges.length,
    findings: linked.doc.findings.length,
    resolved: linked.resolved,
    unresolved: linked.unresolved,
    frontends: frontendReports,
    skipped,
    disabled: plugins.disabled,
    extracted,
    reused,
    failed,
    removed,
    changes,
    rehashed: scan.rehashed,
    coverage,
    problems,
    logs,
  };
}

