import type { ExecModel, FileFlow, FileFlowSummary, SceneLayout, ScopeFlow } from "@insight/flow";
import type { ArchModel } from "@insight/lens-dependencies";
import { ApiError } from "./apiError";
import { staticApi } from "./staticApi";

// Types only: the flow package is not bundled, its charts are drawn by components/FlowChart.tsx.
// The architecture model is plain data from the lens package; the Arch tab draws it in components/views/ArchView.tsx.
export type { ArchEdge, ArchModel, ArchPackage, ArchUnresolved, ArchViolation } from "@insight/lens-dependencies";
export type {
  ExecCoroutine,
  ExecDispatch,
  ExecDispatchHow,
  ExecFunctionRef,
  ExecHow,
  ExecModel,
  ExecModelStats,
  ExecSpawn,
  ExecSpawnHow,
  ExecSpawnStatus,
  ExecThread,
  ExecThreadKind,
  FileFlow,
  FileFlowSummary,
  FlowEdge,
  FlowEdgeKind,
  FlowNode,
  FlowRole,
  FlowShape,
  FlowSpan,
  FlowStats,
  FunctionFlow,
  ScopeCall,
  ScopeExternal,
  ScopeFile,
  ScopeFlow,
  ScopeFlowStats,
  ScopeFunction,
  ScopeGranularity,
  SceneLayout,
} from "@insight/flow";

/** True in the read-only demo build (VITE_STATIC=1): one fixed project, served from JSON files. */
export const IS_DEMO = import.meta.env.VITE_STATIC === "1";

export type Span = { file: string; start: [number, number]; end: [number, number] };
export type Severity = "error" | "warning" | "info";

export interface CoverageRow {
  facet: string;
  providers: string[];
  filesScanned: number;
  filesWithRecords: number;
  filesWithErrors: number;
  nodes: number;
  edges: number;
}

export interface LensSummary {
  id: string;
  title: string;
  status: "ok" | "unavailable" | "error";
  reason?: string;
  reused: boolean;
  findings: number;
  metrics: Record<string, unknown>;
}

export interface LastRun {
  snapshot: string;
  commit?: string;
  dirty?: boolean;
  finishedAt: string;
  durationMs: number;
  nodes: number;
  edges: number;
  findings: number;
  extracted: number;
  reused: number;
  coverage: CoverageRow[];
  problems: string[];
  lenses: LensSummary[];
}

export interface Project {
  id: string;
  name: string;
  addedAt: string;
  source: { kind: "path"; path: string } | { kind: "git"; url: string };
  allowBuildTools: boolean;
  status: "idle" | "indexing" | "error";
  queued: boolean;
  error?: string;
  last?: LastRun;
}

export interface SnapshotSummary {
  id: string;
  createdAt: string;
  commit?: string;
  nodes: number;
  edges: number;
  findings: number;
}

export interface Overview {
  project: Project;
  snapshots: SnapshotSummary[];
  snapshot: (SnapshotSummary & { latest: boolean }) | null;
  coverage: CoverageRow[];
  problems: string[];
  lenses: LensSummary[];
  findings: { total: number; bySeverity: Record<string, number>; byLens: Record<string, number> };
}

export interface FindingRow {
  id: string;
  lens: string;
  severity: Severity;
  message: string;
  nodes?: string[];
  span?: Span;
}

export interface GraphView {
  type: "graph";
  id: string;
  title: string;
  nodes: { id: string; label: string; group?: string; span?: Span }[];
  edges: { from: string; to: string; kind: string; label?: string; confidence?: string; span?: Span }[];
}

export interface TableView {
  type: "table";
  id: string;
  title: string;
  columns: string[];
  rows: (string | number | boolean | null)[][];
}

export interface TreeNode {
  label: string;
  /** What the node is, for example process, thread, coroutine, module or function. */
  kind?: string;
  detail?: string;
  span?: Span;
  children?: TreeNode[];
}

export interface TreeView {
  type: "tree";
  id: string;
  title: string;
  root: TreeNode;
}

export type LensView = GraphView | TableView | TreeView;

export interface LensRecord {
  id: string;
  title: string;
  status: "ok" | "unavailable" | "error";
  reason?: string;
  reused: boolean;
  result?: { findings: FindingRow[]; views: LensView[]; metrics: Record<string, unknown> };
}

/** What a scope is: the whole project, a folder, or one file. */
export type ScopeLevel = "project" | "folder" | "file";

export interface ScopeStats {
  /** Nodes that belong to the scope. */
  nodes: number;
  edges: number;
  findings: number;
  /** Nodes outside the scope that an edge inside it reaches. */
  external: number;
}

/** One lens on one scope. "not-run" means no run of the lens on this scope is stored yet. */
export interface ScopeLensRow {
  id: string;
  title: string;
  status: "ok" | "unavailable" | "error" | "not-run";
  reason?: string;
  findings: number | null;
  /** Demo captures only: false when the lens has no views or findings for the scope, so its tab is dimmed. */
  hasContent?: boolean;
}

export interface ScopeLenses {
  snapshot: string;
  scope: string;
  kind: ScopeLevel;
  stats: ScopeStats;
  facets: string[];
  lenses: ScopeLensRow[];
}

/** One lens run on one scope. */
export interface ScopeLensRun {
  snapshot: string;
  scope: string;
  kind: ScopeLevel;
  lens: LensRecord;
}

export interface SourceSlice {
  file: string;
  firstLine: number;
  lines: string[];
  highlight: { start: number; end: number };
  totalLines: number;
}

export interface NodeFacts {
  snapshot: string;
  node: { id: string; kind: string; facet: string; span?: Span; attrs: Record<string, unknown> };
  ancestors: { id: string; kind: string }[];
  children: { id: string; kind: string }[];
  outgoing: { from: string; to: unknown; kind: string; span?: Span; provenance: { confidence: string } }[];
  incoming: { from: string; to: unknown; kind: string; span?: Span; provenance: { confidence: string } }[];
}

export interface DiffNode {
  id: string;
  kind: string;
  facet: string;
  name?: string;
  parent?: string;
  file?: string;
  line?: number;
}

export interface DiffEdge {
  from: string;
  to: unknown;
  kind: string;
  facet: string;
  count: number;
}

export interface DiffFinding {
  key: string;
  lens: string;
  id: string;
  severity: string;
  message: string;
  file?: string;
  line?: number;
}

export interface LensDiff {
  id: string;
  comparable: boolean;
  /** The lens status on each side, or "not run". */
  base: string;
  head: string;
  added: DiffFinding[];
  removed: DiffFinding[];
  unchanged: number;
}

export interface SnapshotDiff {
  ir: {
    nodes: { added: DiffNode[]; removed: DiffNode[]; changed: DiffNode[] };
    edges: { added: DiffEdge[]; removed: DiffEdge[] };
    findings: { added: string[]; removed: string[] };
  };
  lenses: LensDiff[];
  summary: string[];
}

export interface CompareSide {
  commit: string;
  snapshot: string;
  reused: boolean;
}

export interface Compare {
  base: CompareSide;
  head: CompareSide;
  diff: SnapshotDiff;
}

export type ReviewStatus = "open" | "accepted" | "dismissed";

export interface ReviewItem {
  key: string;
  lens: string;
  id: string;
  severity: string;
  message: string;
  file?: string;
  line?: number;
  status: ReviewStatus;
  note?: string;
  updatedAt?: string;
}

export interface ReviewStale {
  key: string;
  status: "accepted" | "dismissed";
  note: string;
  updatedAt: string;
}

export interface Review {
  snapshot: string | null;
  items: ReviewItem[];
  stale: ReviewStale[];
}

export type TargetType = "node" | "edge" | "finding";

export interface Annotation {
  id: string;
  target: { type: TargetType; key: string };
  text: string;
  createdAt: string;
  updatedAt: string;
}

export interface FileEntry {
  path: string;
  size: number;
  language?: string;
  functions: number;
  types: number;
  findings: number;
}

export interface FileSymbol {
  id: string;
  kind: string;
  name: string;
  span: Span;
}

export interface FileView {
  snapshot: string | null;
  file: string;
  lines: string[];
  totalLines: number;
  size: number;
  language?: string;
  symbols: FileSymbol[];
  findings: FindingRow[];
}

export { ApiError };

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new ApiError(res.status, data.error ?? `request failed: ${res.status}`);
  return data as T;
}

const q = (params: Record<string, string | number | undefined>) => {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== "");
  return entries.length === 0 ? "" : `?${new URLSearchParams(entries.map(([k, v]) => [k, String(v)])).toString()}`;
};

const liveApi = {
  health: () => call<{ ok: boolean; version: string }>("GET", "/api/health"),
  projects: () => call<{ projects: Project[] }>("GET", "/api/projects").then((r) => r.projects),
  project: (id: string) => call<{ project: Project }>("GET", `/api/projects/${id}`).then((r) => r.project),
  add: (body: { path?: string; url?: string; name?: string; allowBuildTools: boolean }) =>
    call<{ project: Project }>("POST", "/api/projects", body).then((r) => r.project),
  remove: (id: string) => call<void>("DELETE", `/api/projects/${id}`),
  reindex: (id: string, full = false) => call<{ result: string }>("POST", `/api/projects/${id}/reindex`, { full }),
  overview: (id: string, snapshot?: string) => call<Overview>("GET", `/api/projects/${id}/overview${q({ snapshot })}`),
  lens: (id: string, lensId: string, snapshot?: string) =>
    call<{ snapshot: string | null; lens: LensRecord }>("GET", `/api/projects/${id}/lenses/${lensId}${q({ snapshot })}`).then((r) => r.lens),
  findings: (id: string, filter: { lens?: string; severity?: string; snapshot?: string } = {}) =>
    call<{ findings: FindingRow[] }>("GET", `/api/projects/${id}/findings${q(filter)}`).then((r) => r.findings),
  // The path is always sent, even when it is "" (the project), so the query is built here: q() drops empty values.
  scopeLenses: (id: string, scope: string) => call<ScopeLenses>("GET", `/api/projects/${id}/scope/lenses?path=${encodeURIComponent(scope)}`),
  scopeLens: (id: string, scope: string, lensId: string) =>
    call<ScopeLensRun>("GET", `/api/projects/${id}/scope/lenses/${encodeURIComponent(lensId)}?path=${encodeURIComponent(scope)}`),
  source:(id: string, file: string, start: number, end: number, context = 3) =>
    call<SourceSlice>("GET", `/api/projects/${id}/source${q({ file, start, end, context })}`),
  files: (id: string, snapshot?: string) =>
    call<{ snapshot: string | null; files: FileEntry[] }>("GET", `/api/projects/${id}/files${q({ snapshot })}`).then((r) => r.files),
  file: (id: string, path: string, snapshot?: string) => call<FileView>("GET", `/api/projects/${id}/file${q({ path, snapshot })}`),
  flow: (id: string, path: string) => call<FileFlow>("GET", `/api/projects/${id}/flow${q({ path })}`),
  flowSummary: (id: string) =>
    call<{ snapshot: string | null; files: FileFlowSummary[] }>("GET", `/api/projects/${id}/flow-summary`).then((r) => r.files),
  // The server adds snapshot, scope and kind to the flow; the page does not use them.
  scopeFlow: (id: string, scope: string) => call<ScopeFlow>("GET", `/api/projects/${id}/scope/flow?path=${encodeURIComponent(scope)}`),
  // The server adds snapshot and kind to the model; the page does not use them.
  getScopeExec: (id: string, scope: string) => call<ExecModel>("GET", `/api/projects/${id}/scope/exec?path=${encodeURIComponent(scope)}`),
  // The server adds scope, snapshot and kind to the model; the page does not use them. The model covers the whole project.
  getScopeArch: (id: string, scope: string) => call<ArchModel>("GET", `/api/projects/${id}/scope/arch?path=${encodeURIComponent(scope)}`),
  // The server lays the execution scene out whole and keeps it per snapshot. Any failure, a 404 included, gives undefined,
  // and the page then lays the scene out in its worker.
  scopeExecLayout: (id: string, scope: string): Promise<SceneLayout | undefined> =>
    call<SceneLayout>("GET", `/api/projects/${id}/scope/exec-layout?path=${encodeURIComponent(scope)}`).then(
      (r) => ({ containers: r.containers }),
      () => undefined,
    ),
  node: (id: string, nodeId: string) => call<NodeFacts>("GET", `/api/projects/${id}/nodes/${nodeId.split("/").map(encodeURIComponent).join("/")}`),
  compare: (id: string, base: string, head: string) => call<Compare>("GET", `/api/projects/${id}/compare${q({ base, head })}`),
  review: (id: string, snapshot?: string) => call<Review>("GET", `/api/projects/${id}/review${q({ snapshot })}`),
  decide: (id: string, key: string, status: "accepted" | "dismissed", note = "") =>
    call<{ key: string; decision: ReviewStale }>("PUT", `/api/projects/${id}/review`, { key, status, note }),
  reopen: (id: string, key: string) => call<void>("DELETE", `/api/projects/${id}/review${q({ key })}`),
  annotations: (id: string, filter: { type?: TargetType; key?: string } = {}) =>
    call<{ annotations: Annotation[] }>("GET", `/api/projects/${id}/annotations${q(filter)}`).then((r) => r.annotations),
  addAnnotation: (id: string, body: { type: TargetType; key: string; text: string }) =>
    call<{ annotation: Annotation }>("POST", `/api/projects/${id}/annotations`, body).then((r) => r.annotation),
  editAnnotation: (id: string, annId: string, text: string) =>
    call<{ annotation: Annotation }>("PATCH", `/api/projects/${id}/annotations/${encodeURIComponent(annId)}`, { text }).then((r) => r.annotation),
  removeAnnotation: (id: string, annId: string) => call<void>("DELETE", `/api/projects/${id}/annotations/${encodeURIComponent(annId)}`),
};

/** The demo build answers from captured JSON; every other build calls the server. */
export const api: typeof liveApi = IS_DEMO ? staticApi : liveApi;
