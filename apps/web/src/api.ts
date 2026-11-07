import { ApiError } from "./apiError";
import { staticApi } from "./staticApi";

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

export interface TreeView {
  type: "tree";
  id: string;
  title: string;
  root: { label: string; children?: TreeView["root"][] };
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
  source: (id: string, file: string, start: number, end: number, context = 3) =>
    call<SourceSlice>("GET", `/api/projects/${id}/source${q({ file, start, end, context })}`),
  node: (id: string, nodeId: string) => call<NodeFacts>("GET", `/api/projects/${id}/nodes/${nodeId.split("/").map(encodeURIComponent).join("/")}`),
};

/** The demo build answers from captured JSON; every other build calls the server. */
export const api: typeof liveApi = IS_DEMO ? staticApi : liveApi;
