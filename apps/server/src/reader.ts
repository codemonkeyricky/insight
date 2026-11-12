import {
  latestScopedRun,
  loadPlugins,
  loadState,
  normalizeScope,
  projectPaths,
  readAnalysis,
  readJsonFile,
  readSnapshot,
  ROOT_SCOPE,
  runLensOnScope,
  scopeFacets,
  unavailableReason,
  type AnalysisFile,
  type CoverageRow,
  type ProjectPaths,
  type LensRecord,
  type LensStatus,
  type LoadedPlugins,
  type ScopeStats,
} from "@insight/indexer";
import {
  buildFileFlow,
  execModel,
  summarizeFlows,
  summarizeScope,
  type ExecModel,
  type FileFlow,
  type FileFlowSummary,
  type ScopeFlow,
  type SceneLayout,
} from "@insight/flow";
import { buildProjectModel, refsOf as modelRefsOf, scopeView as modelScopeView, serializeModel, type ProjectModel, type Refs, type SerializedModel } from "@insight/model";
import { edgeTargets, IRView, isExternal, type ProjectRoot } from "@insight/sdk";
import { type IREdge, type IRDocument, type IRFinding, type IRNode, type IRRecord, type KindRegistry, type NodeId } from "@insight/ir";
import { createCoreRegistry } from "@insight/ir/node";
import { archModel, type ArchModel } from "@insight/model";
import { statSync } from "node:fs";
import { join } from "node:path";
import { ProjectError, type ProjectRecord } from "./registry.js";
import type { JobRunner } from "./jobs.js";
import { solveExecLayout } from "./exec-layout.js";

/** One snapshot, indexed for reads. */
export interface LoadedSnapshot {
  id: string;
  nodes: Map<NodeId, IRNode>;
  edges: IREdge[];
  findings: IRFinding[];
  outgoing: Map<NodeId, IREdge[]>;
  incoming: Map<NodeId, IREdge[]>;
  children: Map<NodeId, NodeId[]>;
  /** The whole-project model of this snapshot. Built on first use, then kept with the snapshot. */
  readonly model: ProjectModel;
}

const CACHE_LIMIT = 4;
const cache = new Map<string, LoadedSnapshot>();

function index(id: string, records: IRRecord[]): LoadedSnapshot {
  const nodes = new Map<NodeId, IRNode>();
  const edges: IREdge[] = [];
  const findings: IRFinding[] = [];
  for (const r of records) {
    if ("node" in r) nodes.set(r.node.id, r.node);
    else if ("edge" in r) edges.push(r.edge);
    else findings.push(r.finding);
  }
  const outgoing = new Map<NodeId, IREdge[]>();
  const incoming = new Map<NodeId, IREdge[]>();
  const children = new Map<NodeId, NodeId[]>();
  const push = <T>(m: Map<NodeId, T[]>, k: NodeId, v: T) => {
    const list = m.get(k);
    if (list) list.push(v);
    else m.set(k, [v]);
  };
  for (const e of edges) {
    push(outgoing, e.from, e);
    for (const t of edgeTargets(e).nodes) push(incoming, t, e);
  }
  for (const n of nodes.values()) if (n.parent !== undefined) push(children, n.parent, n.id);
  let model: ProjectModel | undefined;
  return {
    id,
    nodes,
    edges,
    findings,
    outgoing,
    incoming,
    children,
    get model() {
      model ??= buildProjectModel({ nodes: [...nodes.values()], edges, findings });
      return model;
    },
  };
}

export function loadSnapshot(paths: ProjectPaths, id: string): LoadedSnapshot {
  const key = `${paths.state}\0${id}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const loaded = index(id, readSnapshot(paths, id));
  cache.set(key, loaded);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
  return loaded;
}

/** The snapshot a read refers to: the requested one when it exists for the project, else the latest. */
export function resolveSnapshot(paths: ProjectPaths, requested: string | undefined): string | undefined {
  const state = loadState(paths);
  if (requested !== undefined) {
    if (!state.snapshots.some((s) => s.id === requested)) throw new ProjectError(404, `unknown snapshot ${requested}`);
    return requested;
  }
  return state.latest ?? state.snapshots.at(-1)?.id;
}

export interface FindingRow {
  id: string;
  lens: string;
  severity: IRFinding["severity"];
  message: string;
  nodes?: string[];
  span?: IRFinding["span"];
}

/** Lens findings and index findings in one list. Index findings use the lens name "index". */
export function allFindings(paths: ProjectPaths, snapshot: string): FindingRow[] {
  const rows: FindingRow[] = [];
  const analysis = readAnalysis(paths, snapshot);
  for (const lens of analysis?.lenses ?? []) {
    for (const f of lens.result?.findings ?? []) {
      rows.push({
        id: f.id,
        lens: lens.id,
        severity: f.severity,
        message: f.message,
        ...(f.nodes ? { nodes: f.nodes } : {}),
        ...(f.span ? { span: f.span } : {}),
      });
    }
  }
  loadSnapshot(paths, snapshot).findings.forEach((f, i) => {
    rows.push({
      id: `index:${i}`,
      lens: "index",
      severity: f.severity,
      message: f.message,
      ...(f.nodes ? { nodes: f.nodes } : {}),
      ...(f.span ? { span: f.span } : {}),
    });
  });
  return rows;
}

export function overview(record: ProjectRecord, jobs: JobRunner, paths: ProjectPaths, requested?: string) {
  const state = loadState(paths);
  const snapshot = resolveSnapshot(paths, requested);
  const info = snapshot ? state.snapshots.find((s) => s.id === snapshot) : undefined;
  const findings = snapshot ? allFindings(paths, snapshot) : [];
  const bySeverity: Record<string, number> = { error: 0, warning: 0, info: 0 };
  const byLens: Record<string, number> = {};
  for (const f of findings) {
    bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;
    byLens[f.lens] = (byLens[f.lens] ?? 0) + 1;
  }
  const last = record.last;
  const isLatest = snapshot !== undefined && snapshot === state.latest;
  // Coverage and problems come from the run that wrote the snapshot, so they are shown only for it.
  const fromLastRun = last !== undefined && last.snapshot === snapshot;
  return {
    project: publicProject(record, jobs),
    snapshots: state.snapshots.map((s) => ({ id: s.id, createdAt: s.createdAt, commit: s.commit, nodes: s.nodes, edges: s.edges, findings: s.findings })),
    snapshot: snapshot && info
      ? { id: info.id, createdAt: info.createdAt, commit: info.commit, nodes: info.nodes, edges: info.edges, findings: info.findings, latest: isLatest }
      : null,
    coverage: fromLastRun ? (last.coverage ?? []) : [],
    problems: fromLastRun ? (last.problems ?? []) : [],
    lenses: lensSummaries(paths, snapshot),
    findings: { total: findings.length, bySeverity, byLens },
  };
}

function lensSummaries(paths: ProjectPaths, snapshot: string | undefined) {
  if (!snapshot) return [];
  const analysis = readAnalysis(paths, snapshot);
  return (analysis?.lenses ?? []).map((r) => ({
    id: r.id,
    title: r.title,
    status: r.status,
    reason: r.reason,
    reused: r.reused,
    findings: r.result?.findings.length ?? 0,
    metrics: r.result?.metrics ?? {},
  }));
}

/** The project as the API shows it. Git URLs are shown, local checkouts are not exposed beyond the path. */
export function publicProject(p: ProjectRecord, jobs: JobRunner) {
  return {
    id: p.id,
    name: p.name,
    addedAt: p.addedAt,
    source: p.source.kind === "path" ? { kind: "path", path: p.source.path } : { kind: "git", url: p.source.url },
    allowBuildTools: p.allowBuildTools,
    status: jobs.isIndexing(p.id) ? "indexing" : p.status,
    queued: jobs.isQueued(p.id),
    error: p.error,
    last: p.last,
    // Only while a run is active. The stage and counts, for the project cards and the workspace strip.
    progress: jobs.isIndexing(p.id) ? jobs.progressOf(p.id) : undefined,
  };
}

export function analysisFor(paths: ProjectPaths, snapshot: string | undefined): AnalysisFile | undefined {
  return snapshot ? readAnalysis(paths, snapshot) : undefined;
}

export function lensRecord(paths: ProjectPaths, snapshot: string | undefined, lensId: string): LensRecord {
  const analysis = analysisFor(paths, snapshot);
  const record = analysis?.lenses.find((r) => r.id === lensId);
  if (!record) throw new ProjectError(404, `no lens ${lensId} in this snapshot`);
  return record;
}

/** Node facts: the node, its ancestors, its children, and every edge into or out of it. */
export function nodeFacts(paths: ProjectPaths, snapshot: string, id: NodeId) {
  const snap = loadSnapshot(paths, snapshot);
  const node = snap.nodes.get(id);
  if (!node) throw new ProjectError(404, `no node ${id}`);
  const ancestors: IRNode[] = [];
  let cur: IRNode | undefined = node;
  while (cur?.parent !== undefined) {
    cur = snap.nodes.get(cur.parent);
    if (cur) ancestors.push(cur);
  }
  const describe = (e: IREdge) => ({
    from: e.from,
    to: e.to,
    facet: e.facet,
    kind: e.kind,
    span: e.span,
    provenance: e.provenance,
    attrs: e.attrs,
  });
  return {
    node,
    ancestors,
    children: (snap.children.get(id) ?? []).map((c) => snap.nodes.get(c)).filter((n): n is IRNode => n !== undefined),
    outgoing: (snap.outgoing.get(id) ?? []).map(describe),
    incoming: (snap.incoming.get(id) ?? []).map(describe),
  };
}

const LANGUAGES: Record<string, string> = {
  ts: "TypeScript", tsx: "TypeScript", mts: "TypeScript", cts: "TypeScript", js: "JavaScript", jsx: "JavaScript", mjs: "JavaScript", cjs: "JavaScript",
  json: "JSON", md: "Markdown", yaml: "YAML", yml: "YAML", html: "HTML", css: "CSS", cc: "C++", cpp: "C++", cxx: "C++", h: "C++", hpp: "C++",
  c: "C", py: "Python", rs: "Rust", go: "Go", bzl: "Starlark", bazel: "Starlark", sh: "Shell", txt: "Text",
};

export function languageOf(path: string): string | undefined {
  const name = path.split("/").pop() ?? path;
  if (name === "BUILD" || name === "WORKSPACE") return "Starlark";
  if (name === "CMakeLists.txt") return "CMake";
  return LANGUAGES[name.includes(".") ? (name.split(".").pop() as string) : ""];
}

export interface FileEntry {
  path: string;
  size: number;
  language?: string;
  functions: number;
  types: number;
  findings: number;
}

/** Every file in the snapshot, with the counts the browser shows next to it. */
export function listFiles(paths: ProjectPaths, snapshot: string): FileEntry[] {
  const snap = loadSnapshot(paths, snapshot);
  const counts = new Map<string, { functions: number; types: number; findings: number }>();
  const bump = (file: string, key: "functions" | "types" | "findings") => {
    const c = counts.get(file) ?? { functions: 0, types: 0, findings: 0 };
    c[key]++;
    counts.set(file, c);
  };
  for (const n of snap.nodes.values()) {
    if (n.kind === "structure.function" && n.span) bump(n.span.file, "functions");
    else if (n.kind === "structure.type" && n.span) bump(n.span.file, "types");
  }
  for (const f of allFindings(paths, snapshot)) if (f.span) bump(f.span.file, "findings");
  const files: FileEntry[] = [];
  for (const n of snap.nodes.values()) {
    if (n.kind !== "structure.file") continue;
    const path = String(n.attrs.path ?? n.id);
    let size = 0;
    try {
      size = statSync(join(paths.root, path)).size;
    } catch {
      /* the file is gone since the snapshot; it is listed with size 0 */
    }
    const c = counts.get(path) ?? { functions: 0, types: 0, findings: 0 };
    const language = languageOf(path);
    files.push({ path, size, ...(language ? { language } : {}), ...c });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export interface FileSymbol {
  id: string;
  kind: string;
  name: string;
  span: NonNullable<IRNode["span"]>;
}

/** Functions and types declared in one file, in source order, and the findings that point into it. */
export function fileFacts(paths: ProjectPaths, snapshot: string, file: string): { symbols: FileSymbol[]; findings: FindingRow[] } {
  const snap = loadSnapshot(paths, snapshot);
  const symbols: FileSymbol[] = [];
  for (const n of snap.nodes.values()) {
    if ((n.kind !== "structure.function" && n.kind !== "structure.type") || n.span?.file !== file) continue;
    symbols.push({ id: n.id, kind: n.kind, name: String(n.attrs.qualifiedName ?? n.attrs.name ?? n.id), span: n.span });
  }
  symbols.sort((a, b) => a.span.start[0] - b.span.start[0] || a.span.start[1] - b.span.start[1]);
  return { symbols, findings: allFindings(paths, snapshot).filter((f) => f.span?.file === file) };
}

/** The control-flow charts of the functions in one file, rebuilt from the snapshot's IR. */
export function fileFlow(paths: ProjectPaths, snapshot: string, file: string): FileFlow {
  const snap = loadSnapshot(paths, snapshot);
  const nodes = [...snap.nodes.values()].filter((n) => n.span?.file === file);
  return buildFileFlow(file, nodes, snap.edges.filter((e) => e.span?.file === file));
}

/** How branchy each file is, for the folder and project scopes of the flow view. */
export function flowSummary(paths: ProjectPaths, snapshot: string): FileFlowSummary[] {
  const snap = loadSnapshot(paths, snapshot);
  return summarizeFlows(snap.nodes.values(), snap.edges);
}

/**
 * A scope is the project, a folder that holds indexed files, or one indexed file. The routes name a
 * scope with the `path` query: "" is the project, and a folder or file is its path from the root.
 */
export type ScopeKind = "project" | "folder" | "file";

/** What a scope path names in one snapshot, or undefined when no indexed file lies under it. */
export function scopeKindOf(snap: LoadedSnapshot, scope: string): ScopeKind | undefined {
  if (scope === ROOT_SCOPE) return "project";
  let folder = false;
  for (const n of snap.nodes.values()) {
    if (n.kind !== "structure.file") continue;
    const path = String(n.attrs.path ?? n.id);
    if (path === scope) return "file";
    if (path.startsWith(`${scope}/`)) folder = true;
  }
  return folder ? "folder" : undefined;
}

/** The whole-project model of a snapshot as the browser loads it: the IR document with its schema and snapshot id (see docs/scoped-ir.md). */
export function serializedModelOf(paths: ProjectPaths, snapshot: string): SerializedModel {
  return serializeModel(loadSnapshot(paths, snapshot).model, snapshot);
}

const pluginCache = new Map<string, Promise<LoadedPlugins>>();

/** How a scope read treats the project's own folder. See IndexingOptions.projectPlugins. */
export interface ScopeReadOptions {
  /** Load the project's `.insight/plugins` and its lens settings. Defaults to true. */
  projectPlugins?: boolean;
}

/** The lenses and kinds a project's indexer loads. Loaded once per project folder, since loading scans and imports. */
export function pluginsFor(root: string, opts: ScopeReadOptions = {}): Promise<LoadedPlugins> {
  const projectPlugins = opts.projectPlugins !== false;
  const key = `${root}\0${projectPlugins}`;
  const hit = pluginCache.get(key);
  if (hit) return hit;
  const loaded = loadPlugins({ projectPath: root, projectPlugins });
  pluginCache.set(key, loaded);
  loaded.catch(() => pluginCache.delete(key));
  return loaded;
}

export interface ScopeView {
  snapshot: string;
  scope: string;
  kind: ScopeKind;
  /** The whole snapshot as a document. Lenses run on a cut of it. */
  doc: IRDocument;
  stats: ScopeStats;
  facets: string[];
  plugins: LoadedPlugins;
}

/**
 * Checks a scope path against one snapshot and cuts its IR. A path that leaves the project is an
 * InputError (400). A path with no indexed file under it is a 404.
 */
export async function scopeView(paths: ProjectPaths, snapshot: string, path: string, opts: ScopeReadOptions = {}): Promise<ScopeView> {
  const scope = normalizeScope(path);
  const snap = loadSnapshot(paths, snapshot);
  const kind = scopeKindOf(snap, scope);
  if (!kind) throw new ProjectError(404, "no such scope");
  const view = modelScopeView(snap.model, scope);
  const cut = view.toDoc();
  return { snapshot, scope, kind, doc: snap.model.doc, stats: cut.stats, facets: scopeFacets(cut.doc), plugins: await pluginsFor(paths.root, opts) };
}

/** The call flow of one scope, and the scope it names. */
export interface ScopeFlowView {
  scope: string;
  kind: ScopeKind;
  flow: ScopeFlow;
}

const SCOPE_FLOW_LIMIT = 32;
const scopeFlows = new Map<string, ScopeFlowView>();

/**
 * The call flow of a scope, summarized from its scoped IR (see docs/scoped-ir.md). A snapshot never
 * changes, so each scope's summary is kept until enough other scopes push it out.
 */
export function scopeFlowOf(paths: ProjectPaths, snapshot: string, path: string): ScopeFlowView {
  const scope = normalizeScope(path);
  const key = `${paths.state}\0${snapshot}\0${scope}`;
  const hit = scopeFlows.get(key);
  if (hit) return hit;
  const snap = loadSnapshot(paths, snapshot);
  const kind = scopeKindOf(snap, scope);
  if (!kind) throw new ProjectError(404, "no such scope");
  const cut = modelScopeView(snap.model, scope).toDoc();
  const files = cut.doc.nodes.filter((n) => n.kind === "structure.file" && !isExternal(n)).map((n) => String(n.attrs.path ?? n.id));
  const view: ScopeFlowView = { scope, kind, flow: summarizeScope(cut.doc.nodes, cut.doc.edges, files) };
  scopeFlows.set(key, view);
  if (scopeFlows.size > SCOPE_FLOW_LIMIT) scopeFlows.delete(scopeFlows.keys().next().value as string);
  return view;
}

/** The reverse references of one node, and the scope it is asked from. The lists cover the whole project. */
export interface ScopeRefsView extends Refs {
  scope: string;
  kind: ScopeKind;
}

/**
 * The calledBy and calls lists of a node (see refsOf in @insight/model). The path is checked as the scope routes check it,
 * then the node: an id the snapshot does not hold is a 404.
 */
export function scopeRefsOf(paths: ProjectPaths, snapshot: string, path: string, id: NodeId): ScopeRefsView {
  const scope = normalizeScope(path);
  const snap = loadSnapshot(paths, snapshot);
  const kind = scopeKindOf(snap, scope);
  if (!kind) throw new ProjectError(404, "no such scope");
  if (!snap.model.byId.has(id)) throw new ProjectError(404, `no node ${id}`);
  return { scope, kind, ...modelRefsOf(modelScopeView(snap.model, scope), id) };
}

/** The execution model of one scope, and the scope it names. */
export interface ScopeExecView {
  scope: string;
  kind: ScopeKind;
  exec: ExecModel;
}

const SCOPE_EXEC_LIMIT = 32;
const scopeExecs = new Map<string, ScopeExecView>();

/**
 * The execution model of a scope: its threads, coroutines and dispatches (see docs/exec-model.md). It reads the
 * whole snapshot, not the cut, because a thread's reach follows calls out of the scope. A snapshot never changes,
 * so each scope's model is kept until enough other scopes push it out.
 */
export function scopeExecOf(paths: ProjectPaths, snapshot: string, path: string): ScopeExecView {
  const scope = normalizeScope(path);
  const key = `${paths.state}\0${snapshot}\0${scope}`;
  const hit = scopeExecs.get(key);
  if (hit) return hit;
  const snap = loadSnapshot(paths, snapshot);
  const kind = scopeKindOf(snap, scope);
  if (!kind) throw new ProjectError(404, "no such scope");
  const view: ScopeExecView = { scope, kind, exec: execModel(snap.model.doc.nodes, snap.model.doc.edges, scope) };
  scopeExecs.set(key, view);
  if (scopeExecs.size > SCOPE_EXEC_LIMIT) scopeExecs.delete(scopeExecs.keys().next().value as string);
  return view;
}

/** The architecture model of one scope, and the scope it names. The model covers the whole snapshot. */
export interface ScopeArchView {
  scope: string;
  kind: ScopeKind;
  arch: ArchModel;
}

const SCOPE_ARCH_LIMIT = 8;
const scopeArchs = new Map<string, ScopeArchView>();
let coreRegistry: KindRegistry | undefined;

/**
 * The package-level architecture of a project (see packages/lens/dependencies/src/arch.ts). It reads the whole
 * snapshot, not the cut, since packages and the imports between them lie outside any one scope. A snapshot never
 * changes, so each scope's answer is kept until enough other scopes push it out.
 */
export function scopeArchOf(paths: ProjectPaths, snapshot: string, path: string): ScopeArchView {
  const scope = normalizeScope(path);
  const key = `${paths.state}\0${snapshot}\0${scope}`;
  const hit = scopeArchs.get(key);
  if (hit) return hit;
  const snap = loadSnapshot(paths, snapshot);
  const kind = scopeKindOf(snap, scope);
  if (!kind) throw new ProjectError(404, "no such scope");
  coreRegistry ??= createCoreRegistry();
  const view = new IRView({ nodes: [...snap.nodes.values()], edges: snap.edges, findings: snap.findings, registry: coreRegistry });
  const result: ScopeArchView = { scope, kind, arch: archModel(view) };
  scopeArchs.set(key, result);
  if (scopeArchs.size > SCOPE_ARCH_LIMIT) scopeArchs.delete(scopeArchs.keys().next().value as string);
  return result;
}

let layoutSolves = 0;
/** How many scene layouts this process has solved, cache hits excluded. Tests read it to see the cache at work. */
export function scopeExecLayoutSolves(): number {
  return layoutSolves;
}

/** The exec scene of one scope laid out whole, and the scope it names. */
export interface ScopeExecLayoutView {
  scope: string;
  kind: ScopeKind;
  layout: SceneLayout;
}

/** Layouts are kept per (snapshot, scope). Each one is a few hundred KB at most, so the bound is a count. */
const SCOPE_EXEC_LAYOUT_LIMIT = 64;
const scopeExecLayouts = new Map<string, Promise<ScopeExecLayoutView>>();

/**
 * The exec scene of a scope laid out whole, the way the demo capture lays it out: the model from scopeExecOf, the
 * scene built and every container solved by elkjs in the layout worker (exec-layout.ts). A snapshot never changes, so the answer is kept
 * as a promise: a second request, even one that arrives while the first is still solving, waits for the same work.
 * A failed solve is dropped from the cache, so the next request tries again.
 */
export function scopeExecLayoutOf(paths: ProjectPaths, snapshot: string, path: string): Promise<ScopeExecLayoutView> {
  const scope = normalizeScope(path);
  const key = `${paths.state}\0${snapshot}\0${scope}`;
  const hit = scopeExecLayouts.get(key);
  if (hit) return hit;
  const solved = (async (): Promise<ScopeExecLayoutView> => {
    const { kind, exec } = scopeExecOf(paths, snapshot, scope);
    layoutSolves += 1;
    return { scope, kind, layout: await solveExecLayout(exec) };
  })();
  scopeExecLayouts.set(key, solved);
  if (scopeExecLayouts.size > SCOPE_EXEC_LAYOUT_LIMIT) scopeExecLayouts.delete(scopeExecLayouts.keys().next().value as string);
  solved.catch(() => {
    if (scopeExecLayouts.get(key) === solved) scopeExecLayouts.delete(key);
  });
  return solved;
}

export interface ScopeLensRow {
  id: string;
  title: string;
  /** "not-run" when no run of the lens on this scope is stored. Lenses are not run by this read. */
  status: LensStatus | "not-run";
  reason?: string;
  /** The findings of the stored result, or null when there is none. */
  findings: number | null;
}

/** Each lens with the status of its latest stored run on the scope. */
export function scopeLensRows(view: ScopeView, paths: ProjectPaths): ScopeLensRow[] {
  const projectRecords = view.scope === ROOT_SCOPE ? readAnalysis(paths, view.snapshot)?.lenses : undefined;
  return view.plugins.lenses.map(({ lens }): ScopeLensRow => {
    const missing = lens.requires.filter((f) => !view.facets.includes(f));
    if (missing.length > 0) {
      return { id: lens.id, title: lens.title, status: "unavailable", reason: unavailableReason(view.scope, missing), findings: null };
    }
    const record = projectRecords
      ? projectRecords.find((r) => r.id === lens.id)
      : latestScopedRun(paths, view.snapshot, view.scope, lens.id);
    if (!record) return { id: lens.id, title: lens.title, status: "not-run", findings: null };
    return {
      id: lens.id,
      title: lens.title,
      status: record.status,
      ...(record.reason ? { reason: record.reason } : {}),
      findings: record.result?.findings.length ?? null,
    };
  });
}

/** Settings per lens id, read the way the pipeline reads them from .insight/lenses/<id>.json. None when the project's folder is not read. */
function readLensConfigs(root: string, lensIds: string[], opts: ScopeReadOptions): Record<string, unknown> {
  const configs: Record<string, unknown> = {};
  if (opts.projectPlugins === false) return configs;
  const dir = projectPaths(root).lensConfigs;
  for (const id of lensIds) {
    const value = readJsonFile<unknown>(join(dir, `${id}.json`), undefined);
    if (value !== undefined) configs[id] = value;
  }
  return configs;
}

/**
 * Runs one lens on the scope, or reads its stored result when the inputs have not changed. A lens
 * that throws comes back with status "error" and is not stored.
 */
export async function runScopedLens(
  view: ScopeView,
  lensId: string,
  project: ProjectRoot,
  stateDir: string,
  opts: ScopeReadOptions = {},
): Promise<LensRecord> {
  const item = view.plugins.lenses.find((l) => l.lens.id === lensId);
  if (!item) throw new ProjectError(404, `no lens ${lensId}`);
  return runLensOnScope({
    doc: view.doc,
    registry: view.plugins.registry,
    root: project,
    snapshot: view.snapshot,
    scope: view.scope,
    lens: item,
    lenses: view.plugins.lenses,
    configs: readLensConfigs(project.path, view.plugins.lenses.map((l) => l.lens.id), opts),
    stateDir,
  });
}

export type { CoverageRow, FileFlow, FileFlowSummary };
