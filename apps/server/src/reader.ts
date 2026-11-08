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
  scopeDoc,
  scopeFacets,
  unavailableReason,
  type AnalysisFile,
  type CoverageRow,
  type LensRecord,
  type LensStatus,
  type LoadedPlugins,
  type ScopeStats,
} from "@insight/core";
import { buildFileFlow, summarizeFlows, summarizeScope, type FileFlow, type FileFlowSummary, type ScopeFlow } from "@insight/flow";
import { edgeTargets, isExternal, type ProjectRoot } from "@insight/sdk";
import type { IREdge, IRDocument, IRFinding, IRNode, IRRecord, NodeId } from "@insight/ir";
import { statSync } from "node:fs";
import { join } from "node:path";
import { ProjectError, type ProjectRecord } from "./registry.js";
import type { JobRunner } from "./jobs.js";

/** One snapshot, indexed for reads. */
export interface LoadedSnapshot {
  id: string;
  nodes: Map<NodeId, IRNode>;
  edges: IREdge[];
  findings: IRFinding[];
  outgoing: Map<NodeId, IREdge[]>;
  incoming: Map<NodeId, IREdge[]>;
  children: Map<NodeId, NodeId[]>;
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
  return { id, nodes, edges, findings, outgoing, incoming, children };
}

export function loadSnapshot(root: string, id: string): LoadedSnapshot {
  const key = `${root}\0${id}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const loaded = index(id, readSnapshot(projectPaths(root), id));
  cache.set(key, loaded);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
  return loaded;
}

/** The snapshot a read refers to: the requested one when it exists for the project, else the latest. */
export function resolveSnapshot(root: string, requested: string | undefined): string | undefined {
  const state = loadState(projectPaths(root));
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
export function allFindings(root: string, snapshot: string): FindingRow[] {
  const rows: FindingRow[] = [];
  const analysis = readAnalysis(projectPaths(root), snapshot);
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
  loadSnapshot(root, snapshot).findings.forEach((f, i) => {
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

export function overview(record: ProjectRecord, jobs: JobRunner, root: string, requested?: string) {
  const state = loadState(projectPaths(root));
  const snapshot = resolveSnapshot(root, requested);
  const info = snapshot ? state.snapshots.find((s) => s.id === snapshot) : undefined;
  const findings = snapshot ? allFindings(root, snapshot) : [];
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
    lenses: lensSummaries(root, snapshot),
    findings: { total: findings.length, bySeverity, byLens },
  };
}

function lensSummaries(root: string, snapshot: string | undefined) {
  if (!snapshot) return [];
  const analysis = readAnalysis(projectPaths(root), snapshot);
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
  };
}

export function analysisFor(root: string, snapshot: string | undefined): AnalysisFile | undefined {
  return snapshot ? readAnalysis(projectPaths(root), snapshot) : undefined;
}

export function lensRecord(root: string, snapshot: string | undefined, lensId: string): LensRecord {
  const analysis = analysisFor(root, snapshot);
  const record = analysis?.lenses.find((r) => r.id === lensId);
  if (!record) throw new ProjectError(404, `no lens ${lensId} in this snapshot`);
  return record;
}

/** Node facts: the node, its ancestors, its children, and every edge into or out of it. */
export function nodeFacts(root: string, snapshot: string, id: NodeId) {
  const snap = loadSnapshot(root, snapshot);
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
export function listFiles(root: string, snapshot: string): FileEntry[] {
  const snap = loadSnapshot(root, snapshot);
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
  for (const f of allFindings(root, snapshot)) if (f.span) bump(f.span.file, "findings");
  const files: FileEntry[] = [];
  for (const n of snap.nodes.values()) {
    if (n.kind !== "structure.file") continue;
    const path = String(n.attrs.path ?? n.id);
    let size = 0;
    try {
      size = statSync(join(root, path)).size;
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
export function fileFacts(root: string, snapshot: string, file: string): { symbols: FileSymbol[]; findings: FindingRow[] } {
  const snap = loadSnapshot(root, snapshot);
  const symbols: FileSymbol[] = [];
  for (const n of snap.nodes.values()) {
    if ((n.kind !== "structure.function" && n.kind !== "structure.type") || n.span?.file !== file) continue;
    symbols.push({ id: n.id, kind: n.kind, name: String(n.attrs.qualifiedName ?? n.attrs.name ?? n.id), span: n.span });
  }
  symbols.sort((a, b) => a.span.start[0] - b.span.start[0] || a.span.start[1] - b.span.start[1]);
  return { symbols, findings: allFindings(root, snapshot).filter((f) => f.span?.file === file) };
}

/** The control-flow charts of the functions in one file, rebuilt from the snapshot's IR. */
export function fileFlow(root: string, snapshot: string, file: string): FileFlow {
  const snap = loadSnapshot(root, snapshot);
  const nodes = [...snap.nodes.values()].filter((n) => n.span?.file === file);
  return buildFileFlow(file, nodes, snap.edges.filter((e) => e.span?.file === file));
}

/** How branchy each file is, for the folder and project scopes of the flow view. */
export function flowSummary(root: string, snapshot: string): FileFlowSummary[] {
  const snap = loadSnapshot(root, snapshot);
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

const pluginCache = new Map<string, Promise<LoadedPlugins>>();

/** The lenses and kinds a project's indexer loads. Loaded once per project folder, since loading scans and imports. */
export function pluginsFor(root: string): Promise<LoadedPlugins> {
  const hit = pluginCache.get(root);
  if (hit) return hit;
  const loaded = loadPlugins({ projectPath: root });
  pluginCache.set(root, loaded);
  loaded.catch(() => pluginCache.delete(root));
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
export async function scopeView(root: string, snapshot: string, path: string): Promise<ScopeView> {
  const scope = normalizeScope(path);
  const snap = loadSnapshot(root, snapshot);
  const kind = scopeKindOf(snap, scope);
  if (!kind) throw new ProjectError(404, "no such scope");
  const doc: IRDocument = { nodes: [...snap.nodes.values()], edges: snap.edges, findings: snap.findings };
  const cut = scopeDoc(doc, scope);
  return { snapshot, scope, kind, doc, stats: cut.stats, facets: scopeFacets(cut.doc), plugins: await pluginsFor(root) };
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
export function scopeFlowOf(root: string, snapshot: string, path: string): ScopeFlowView {
  const scope = normalizeScope(path);
  const key = `${root}\0${snapshot}\0${scope}`;
  const hit = scopeFlows.get(key);
  if (hit) return hit;
  const snap = loadSnapshot(root, snapshot);
  const kind = scopeKindOf(snap, scope);
  if (!kind) throw new ProjectError(404, "no such scope");
  const doc: IRDocument = { nodes: [...snap.nodes.values()], edges: snap.edges, findings: snap.findings };
  const cut = scopeDoc(doc, scope);
  const files = cut.doc.nodes.filter((n) => n.kind === "structure.file" && !isExternal(n)).map((n) => String(n.attrs.path ?? n.id));
  const view: ScopeFlowView = { scope, kind, flow: summarizeScope(cut.doc.nodes, cut.doc.edges, files) };
  scopeFlows.set(key, view);
  if (scopeFlows.size > SCOPE_FLOW_LIMIT) scopeFlows.delete(scopeFlows.keys().next().value as string);
  return view;
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
export function scopeLensRows(view: ScopeView, root: string): ScopeLensRow[] {
  const paths = projectPaths(root);
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

/** Settings per lens id, read the way the pipeline reads them from .insight/lenses/<id>.json. */
function readLensConfigs(root: string, lensIds: string[]): Record<string, unknown> {
  const dir = projectPaths(root).lensConfigs;
  const configs: Record<string, unknown> = {};
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
export async function runScopedLens(view: ScopeView, lensId: string, project: ProjectRoot): Promise<LensRecord> {
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
    configs: readLensConfigs(project.path, view.plugins.lenses.map((l) => l.lens.id)),
  });
}

export type { CoverageRow, FileFlow, FileFlowSummary };
