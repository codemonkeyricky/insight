// The hosted build's api. Each indexed commit is a project whose id is gh~<owner>~<repo>~<sha>: its files are the static
// export under the storage base, its sources are read from GitHub, and the only write is asking the server to index a
// repository (POST /api/index). Everything else answers as the read-only demo does.
import type { Project } from "./api";
import { ApiError } from "./apiError";
import { isRepoName, parseRepoInput } from "./hostedRepo";
import { makeStaticApi } from "./staticApi";

export interface HostedRef {
  owner: string;
  repo: string;
  sha: string;
}

/** A run's status.json, as the function writes it. */
export interface IndexStatus {
  repo: string;
  sha: string;
  ref?: string;
  state: "running" | "done" | "failed";
  phase?: string;
  done?: number;
  total?: number;
  error?: { code: string; message: string };
  startedAt?: string;
  updatedAt?: string;
}

/** latest.json: the newest finished index of a repository. */
export interface LatestIndex {
  repo: string;
  sha: string;
  ref?: string;
  indexedAt: string;
  nodes: number;
  files: number;
}

/** One entry of meta/recent.json. */
export interface RecentIndex {
  repo: string;
  sha: string;
  indexedAt: string;
  nodes: number;
  files: number;
}

/** The reply of POST /api/index: 200 or 202 with a state, or a 4xx with a coded error. */
export interface IndexReply {
  state: "running" | "done" | "failed";
  repo: string;
  sha: string;
  error?: { code: string; message: string };
}

const SHA = /^[0-9a-f]{40}$/;

/** The project id of an indexed commit. Owner and repo never contain "~", so the id splits back exactly. */
export function projectIdOf(ref: HostedRef): string {
  return `gh~${ref.owner}~${ref.repo}~${ref.sha}`;
}

/** The commit a project id names, or undefined when the id is not a hosted one. */
export function parseProjectId(id: string): HostedRef | undefined {
  const parts = id.split("~");
  if (parts.length !== 4 || parts[0] !== "gh") return undefined;
  const [, owner, repo, sha] = parts as [string, string, string, string];
  if (!isRepoName(owner, repo) || !SHA.test(sha)) return undefined;
  return { owner, repo, sha };
}

/** The origin of the hosted API (POST /api/index, GET /api/status), without a trailing slash: VITE_API_BASE, or "" (same origin). */
export function apiBase(): string {
  return (import.meta.env.VITE_API_BASE ?? "").replace(/\/+$/, "");
}

/** The storage root with a trailing slash: VITE_STORAGE_BASE, or "/storage/". */
export function storageRoot(): string {
  const configured = import.meta.env.VITE_STORAGE_BASE || "/storage/";
  return configured.endsWith("/") ? configured : `${configured}/`;
}

/** The folder of one indexed commit under the storage root, with a trailing slash. */
export function indexBase(root: string, ref: HostedRef): string {
  return `${root}gh/${ref.owner}/${ref.repo}/${ref.sha}/`;
}

/** The base of a project's files: the function that the static api reads them through. */
export function hostedBaseFor(root: string): (projectId: string) => string {
  return (id) => {
    const ref = parseProjectId(id);
    if (!ref) throw new ApiError(404, `no hosted project ${id}`);
    return indexBase(root, ref);
  };
}

/** The GitHub raw URL of one file at the indexed commit. Each path segment is encoded, so spaces and "#" survive. */
export function rawSourceUrl(ref: HostedRef, path: string): string {
  return `https://raw.githubusercontent.com/${ref.owner}/${ref.repo}/${ref.sha}/${path.split("/").map(encodeURIComponent).join("/")}`;
}

/** A thrown index request: the HTTP status (0 when the request never got one), the server's code and its message. */
export class IndexRequestError extends ApiError {
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(status, message);
    this.code = code;
  }
}

async function readJson<T>(url: string): Promise<T | undefined> {
  const res = await fetch(url, { cache: "no-store" });
  if (res.status === 404) return undefined;
  if (!res.ok) throw new ApiError(res.status, `could not read ${url} (${res.status})`);
  return (await res.json()) as T;
}

/**
 * The status of one run, or undefined when no run has written one for that commit. It is read through the API
 * (GET /api/status, never cached), not from the storage: the storage's edge copy can lag behind a running job.
 */
export function readStatus(ref: HostedRef): Promise<IndexStatus | undefined> {
  const repo = encodeURIComponent(`${ref.owner}/${ref.repo}`);
  return readJson<IndexStatus>(`${apiBase()}/api/status?repo=${repo}&sha=${ref.sha}`);
}

/** The newest finished index of a repository, or undefined when none has finished. */
export function readLatest(root: string, owner: string, repo: string): Promise<LatestIndex | undefined> {
  return readJson<LatestIndex>(`${root}gh/${owner}/${repo}/latest.json`);
}

/** The newest finished indexes, from meta/recent.json. Entries that do not parse are left out. */
export async function recentIndexes(root: string): Promise<RecentIndex[]> {
  const list = await readJson<unknown>(`${root}meta/recent.json`);
  if (!Array.isArray(list)) return [];
  const out: RecentIndex[] = [];
  for (const entry of list as Partial<RecentIndex>[]) {
    const [owner, repo] = typeof entry.repo === "string" ? entry.repo.split("/") : [];
    if (owner === undefined || repo === undefined || !isRepoName(owner, repo)) continue;
    if (typeof entry.sha !== "string" || !SHA.test(entry.sha)) continue;
    if (typeof entry.indexedAt !== "string" || typeof entry.nodes !== "number" || typeof entry.files !== "number") continue;
    out.push({ repo: `${owner}/${repo}`, sha: entry.sha, indexedAt: entry.indexedAt, nodes: entry.nodes, files: entry.files });
  }
  return out;
}

/** Asks the server to index a repository, at a commit when `ref` is given. Throws an IndexRequestError on a 4xx or a dropped request. */
export async function requestIndex(repo: string, ref?: string): Promise<IndexReply> {
  let res: Response;
  try {
    res = await fetch(`${apiBase()}/api/index`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(ref === undefined ? { repo } : { repo, ref }),
    });
  } catch {
    throw new IndexRequestError(0, "network", "Could not reach the indexing service");
  }
  const data = (await res.json().catch(() => ({}))) as Partial<IndexReply> & { error?: { code?: string; message?: string } };
  if (res.status === 200 || res.status === 202) return data as IndexReply;
  throw new IndexRequestError(res.status, data.error?.code ?? "request_failed", data.error?.message ?? `indexing request failed (${res.status})`);
}

const sourceCache = new Map<string, Promise<string | undefined>>();

/** One source file of an indexed commit, read from GitHub. A file GitHub does not have is undefined. Each file is fetched once. */
function rawSource(projectId: string, path: string): Promise<string | undefined> {
  const ref = parseProjectId(projectId);
  if (!ref) return Promise.resolve(undefined);
  const key = `${projectId}\n${path}`;
  let hit = sourceCache.get(key);
  if (!hit) {
    hit = fetch(rawSourceUrl(ref, path)).then(async (res) => {
      if (res.status === 404) return undefined;
      if (!res.ok) throw new ApiError(res.status, `GitHub answered ${res.status} for ${path}`);
      return res.text();
    });
    sourceCache.set(key, hit);
    hit.catch(() => sourceCache.delete(key));
  }
  return hit;
}

/** The project as the page shows it: the repository and its GitHub link, not the path the export ran in. */
function identifyHosted(projectId: string, project: Project): Project {
  const ref = parseProjectId(projectId);
  if (!ref) return project;
  const { progress: _progress, error: _error, ...rest } = project;
  return {
    ...rest,
    id: projectId,
    name: `${ref.owner}/${ref.repo}`,
    source: { kind: "git", url: `https://github.com/${ref.owner}/${ref.repo}` },
    status: "idle",
    queued: false,
  };
}

function projectOf(entry: RecentIndex): Project {
  const [owner = "", repo = ""] = entry.repo.split("/");
  return {
    id: projectIdOf({ owner, repo, sha: entry.sha }),
    name: entry.repo,
    addedAt: entry.indexedAt,
    source: { kind: "git", url: `https://github.com/${entry.repo}` },
    allowBuildTools: false,
    status: "idle",
    queued: false,
  };
}

const root = storageRoot();

const readOnlyStatic = makeStaticApi(hostedBaseFor(root), {
  sourceFor: rawSource,
  rootOnly: true,
  identify: identifyHosted,
  readOnlyMessage: "Hosted indexes are read-only. Run Insight locally to add projects and re-index.",
});

/** The hosted build's api, with the same shape as the live api. */
export const hostedApi = {
  ...readOnlyStatic,
  health: async () => ({ ok: true, version: "hosted" }),
  projects: async (): Promise<Project[]> => (await recentIndexes(root)).map(projectOf),
  /** Indexes a GitHub repository at the commit the server picks. `url` takes the same forms the home page does. */
  add: async (body: { path?: string; url?: string; name?: string; allowBuildTools: boolean }): Promise<Project> => {
    const parsed = parseRepoInput(body.url ?? "");
    if (!parsed.ok) throw new ApiError(400, parsed.error);
    const repo = `${parsed.owner}/${parsed.repo}`;
    const reply = await requestIndex(repo);
    if (reply.state === "failed") throw new IndexRequestError(200, reply.error?.code ?? "index_failed", reply.error?.message ?? `Indexing ${repo} failed.`);
    return identifyHosted(projectIdOf({ owner: parsed.owner, repo: parsed.repo, sha: reply.sha }), projectOf({ repo, sha: reply.sha, indexedAt: new Date().toISOString(), nodes: 0, files: 0 }));
  },
};

