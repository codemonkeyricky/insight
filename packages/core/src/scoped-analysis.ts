import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { IRDocument, KindRegistry } from "@insight/ir";
import { IRView, type LensResult, type ProjectRoot } from "@insight/sdk";
import { inputsFor, normalize, orderLenses, readAnalysis, type LensRecord } from "./analyze.js";
import type { LoadedLens } from "./loader.js";
import { projectPaths, type ProjectPaths } from "./paths.js";
import { normalizeScope, ROOT_SCOPE, scopeDoc, scopeFacets } from "./scope.js";
import { canonicalJson, readJsonFile, sha256, writeFileAtomic } from "./util.js";

/** Version of the stored scope records. A new version ignores older files, which are then computed again. */
export const SCOPED_SCHEMA = 1;

export interface ScopedLensOptions {
  /** The full IR of one snapshot. The scope is cut from it. */
  doc: IRDocument;
  registry: KindRegistry;
  root: ProjectRoot;
  snapshot: string;
  /** A normalized scope: "" for the project, a folder or a file. */
  scope: string;
  lens: LoadedLens;
  /** Every loaded lens. The ones that `lens.after` names are run first. Defaults to just `lens`. */
  lenses?: LoadedLens[];
  /** Settings per lens id, from .insight/lenses/<id>.json. */
  configs: Record<string, unknown>;
  /** Results already known for this scope, by lens id. A dependency with one is not run again. */
  resultOf?: (lensId: string) => LensResult | undefined;
  /** The lens's own previous result for this scope, passed to the lens as `ctx.previous`. */
  previous?: LensResult;
  /** Where the project's generated state lives. Defaults to `<root.path>/.insight`. */
  stateDir?: string;
}

/** What a stored scope record holds on disk. */
interface StoredScopedRecord {
  schema: typeof SCOPED_SCHEMA;
  scope: string;
  id: string;
  title: string;
  inputsHash: string;
  result: LensResult;
}

/**
 * Runs one lens on one scope of a snapshot. Only "ok" results are stored, under
 * .insight/analysis/scopes/<snapshot>/, so a later call with the same inputs reads the file.
 *
 * - The project scope "" returns the record stored for the snapshot, when there is one.
 * - A lens whose required facets are missing in the scope is "unavailable", and the reason names the scope.
 * - A lens that throws is "error" with its message. Nothing is stored for it.
 * - The inputs hash covers the scope, the lens version, its settings, and the facets it reads
 *   inside the scope, so a result is never reused for a different scope or different facts.
 */
export async function runLensOnScope(opts: ScopedLensOptions): Promise<LensRecord> {
  const scope = normalizeScope(opts.scope);
  const paths = projectPaths(opts.root.path, opts.stateDir);
  const target = opts.lens;
  if (scope === ROOT_SCOPE) {
    const stored = readAnalysis(paths, opts.snapshot)?.lenses.find((r) => r.id === target.lens.id);
    if (stored) return stored;
  }
  const run: ScopedRun = {
    scope,
    scoped: scopeDoc(opts.doc, scope).doc,
    registry: opts.registry,
    root: opts.root,
    snapshot: opts.snapshot,
    paths,
    configs: opts.configs,
  };
  const known = new Map<string, LensResult>();
  const lookup = (id: string): LensResult | undefined => known.get(id) ?? opts.resultOf?.(id);

  const deps = orderLenses(dependencyClosure(target, opts.lenses ?? [target])).filter((l) => l.lens.id !== target.lens.id);
  for (const dep of deps) {
    const supplied = opts.resultOf?.(dep.lens.id);
    if (supplied) {
      known.set(dep.lens.id, supplied);
      continue;
    }
    const record = await runScoped(run, dep, undefined, lookup);
    if (record.result) known.set(dep.lens.id, record.result);
  }
  return runScoped(run, target, opts.previous, lookup);
}

/**
 * The most recent stored result of a lens on a scope in a snapshot, or undefined. Reads only the
 * file names and one file, so it is cheap next to a lens run.
 */
export function latestScopedRun(paths: ProjectPaths, snapshot: string, scope: string, lensId: string): LensRecord | undefined {
  const dir = scopedDir(paths, snapshot);
  const prefix = `${scopeKey(scope)}__${lensId}__`;
  if (!existsSync(dir)) return undefined;
  let best: { file: string; mtime: number } | undefined;
  for (const name of readdirSync(dir)) {
    if (!name.startsWith(prefix) || !name.endsWith(".json")) continue;
    const file = join(dir, name);
    const mtime = statSync(file).mtimeMs;
    if (!best || mtime > best.mtime) best = { file, mtime };
  }
  if (!best) return undefined;
  const stored = readJsonFile<StoredScopedRecord | undefined>(best.file, undefined);
  return stored && stored.schema === SCOPED_SCHEMA ? toRecord(stored) : undefined;
}

interface ScopedRun {
  scope: string;
  scoped: IRDocument;
  registry: KindRegistry;
  root: ProjectRoot;
  snapshot: string;
  paths: ProjectPaths;
  configs: Record<string, unknown>;
}

async function runScoped(
  run: ScopedRun,
  item: LoadedLens,
  previous: LensResult | undefined,
  resultOf: (id: string) => LensResult | undefined,
): Promise<LensRecord> {
  const { lens, manifest } = item;
  const config = run.configs[lens.id];
  const inputs = inputsFor(lens, run.scoped);
  const inputsHash = sha256(
    canonicalJson({ id: lens.id, version: manifest.version, scope: run.scope, config: config ?? null, ...inputs }),
  );
  const present = new Set(scopeFacets(run.scoped));
  const missing = lens.requires.filter((f) => !present.has(f));
  if (missing.length > 0) {
    return {
      id: lens.id,
      title: lens.title,
      status: "unavailable",
      reason: unavailableReason(run.scope, missing),
      reused: false,
      inputsHash,
    };
  }

  const file = storedFile(run, lens.id, inputsHash);
  const stored = readJsonFile<StoredScopedRecord | undefined>(file, undefined);
  if (stored && stored.schema === SCOPED_SCHEMA && stored.inputsHash === inputsHash) {
    return { ...toRecord(stored), reused: true };
  }

  try {
    const view = new IRView({ nodes: run.scoped.nodes, edges: run.scoped.edges, findings: run.scoped.findings, registry: run.registry });
    const raw = await lens.run(view, { root: run.root, scope: run.scope, config, previous, resultOf });
    const result = normalize(lens.id, raw);
    const record: LensRecord = { id: lens.id, title: lens.title, status: "ok", reused: false, inputsHash, result };
    const toStore: StoredScopedRecord = { schema: SCOPED_SCHEMA, scope: run.scope, id: lens.id, title: lens.title, inputsHash, result };
    writeFileAtomic(file, JSON.stringify(toStore));
    return record;
  } catch (err) {
    return {
      id: lens.id,
      title: lens.title,
      status: "error",
      reason: (err as Error).message,
      reused: false,
      inputsHash,
    };
  }
}

/** The lenses that `target` needs, directly or through other lenses, found by `after`. */
function dependencyClosure(target: LoadedLens, lenses: LoadedLens[]): LoadedLens[] {
  const byId = new Map(lenses.map((l) => [l.lens.id, l]));
  const found = new Map<string, LoadedLens>();
  const walk = (l: LoadedLens): void => {
    for (const dep of l.lens.after ?? []) {
      const d = byId.get(dep);
      if (!d || found.has(dep)) continue;
      found.set(dep, d);
      walk(d);
    }
  };
  walk(target);
  return [...found.values()];
}

function scopedDir(paths: ProjectPaths, snapshot: string): string {
  return join(paths.analysis, "scopes", snapshot);
}

/** A short hash of the scope path, so the file name never holds a path. */
function scopeKey(scope: string): string {
  return sha256(scope).slice(0, 32);
}

function storedFile(run: ScopedRun, lensId: string, inputsHash: string): string {
  return join(scopedDir(run.paths, run.snapshot), `${scopeKey(run.scope)}__${lensId}__${inputsHash.slice(0, 32)}.json`);
}

function scopeLabel(scope: string): string {
  return scope === ROOT_SCOPE ? "(project)" : scope;
}

/** Why a lens cannot run on a scope: the facets it needs have no facts in the scope. */
export function unavailableReason(scope: string, missing: readonly string[]): string {
  return `unavailable: scope "${scopeLabel(scope)}" has no ${missing.join(", ")} facts`;
}

function toRecord(stored: StoredScopedRecord): LensRecord {
  return { id: stored.id, title: stored.title, status: "ok", reused: false, inputsHash: stored.inputsHash, result: stored.result };
}
