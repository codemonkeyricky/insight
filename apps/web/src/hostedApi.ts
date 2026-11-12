// The hosted build's api. Each indexed commit is a project whose id is gh~<owner>~<repo>~<sha> (public) or
// ghp~<owner>~<repo>~<sha> (private, read with the signed-in user's access): its files are the static export under the
// storage base (a private one under a signed grant base), its sources are read from GitHub (a private one through
// /api/private/source), and the only write is asking the server to index a repository (POST /api/index). Everything else
// answers as the read-only demo does.
import type { Project } from "./api";
import { ApiError } from "./apiError";
import { isRepoName, parseRepoInput } from "./hostedRepo";
import { makeStaticApi } from "./staticApi";

export interface HostedRef {
  owner: string;
  repo: string;
  sha: string;
  /** True for a private repository: its project id is ghp~…, and its reads go through the signed-in user's grant. */
  private?: boolean;
}

/** A parsed project id: always says whether the repository is private. */
export type ParsedRef = HostedRef & { private: boolean };

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

/** refs/<ref>.json: where a branch pointed when it was last indexed. */
export interface RefPointer {
  ref: string;
  sha: string;
  indexedAt: string;
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
  /** The ref the run is for (the default branch's name when the request named none). */
  ref?: string;
  /** On a 200 done: the ref's pointer already named this commit, so nothing was indexed. */
  upToDate?: boolean;
  /** "private" when the repository is private: the index is then a ghp~ project. */
  visibility?: "public" | "private";
  error?: { code: string; message: string };
}

/** GET /api/auth/me. `enabled` is false when sign-in is not configured on the server (or the request failed). */
export interface AuthState {
  enabled: boolean;
  signedIn: boolean;
  login?: string;
  avatarUrl?: string;
  installUrl?: string;
}

/** One repository the Insight app can see for the signed-in user. */
export interface PrivateRepo {
  /** "owner/repo", lowercased. */
  repo: string;
  private: boolean;
  defaultBranch?: string;
}

/** GET /api/private/repos. */
export interface PrivateRepos {
  repos: PrivateRepo[];
  installUrl?: string;
}

const SHA = /^[0-9a-f]{40}$/;

/** The message of a private read the visitor is not signed in for. */
export const SIGN_IN_PRIVATE = "Sign in with GitHub to view this private repository";
/** The message of a private read the visitor has no access to on GitHub. */
export const NO_ACCESS = "You don't have access to this repository";

/** The project id of an indexed commit. Owner and repo never contain "~", so the id splits back exactly. */
export function projectIdOf(ref: HostedRef): string {
  return `${ref.private ? "ghp" : "gh"}~${ref.owner}~${ref.repo}~${ref.sha}`;
}

/** The commit a project id names (gh~ public, ghp~ private), or undefined when the id is not a hosted one. */
export function parseProjectId(id: string): ParsedRef | undefined {
  const parts = id.split("~");
  if (parts.length !== 4 || (parts[0] !== "gh" && parts[0] !== "ghp")) return undefined;
  const [kind, owner, repo, sha] = parts as [string, string, string, string];
  if (!isRepoName(owner, repo) || !SHA.test(sha)) return undefined;
  return { owner, repo, sha, private: kind === "ghp" };
}

/** The origin of the hosted API (POST /api/index, GET /api/status, the /api/auth and /api/private routes), without a trailing slash: VITE_API_BASE, or "" (same origin). */
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

/** A grant is renewed this long before its expiry, so a read never starts with one that is about to lapse. */
const GRANT_MARGIN_MS = 5 * 60 * 1000;

interface Grant {
  base: string;
  /** Epoch milliseconds from which the grant is renewed. 0 when the server gave no usable expiry: no caching. */
  refreshAt: number;
}

const grants = new Map<string, Grant>();
const grantsInFlight = new Map<string, Promise<Grant>>();

/**
 * An expiry as epoch milliseconds. A number is seconds when it is small (unix seconds) and milliseconds otherwise; a string
 * is an ISO time. Undefined when it is neither.
 */
export function expiryMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value < 1e11 ? value * 1000 : value;
  if (typeof value === "string") {
    const t = Date.parse(value);
    return Number.isNaN(t) ? undefined : t;
  }
  return undefined;
}

async function fetchGrant(ref: HostedRef): Promise<Grant> {
  const repo = encodeURIComponent(`${ref.owner}/${ref.repo}`);
  const res = await fetch(`${apiBase()}/api/private/grant?repo=${repo}&sha=${ref.sha}`, { cache: "no-store", credentials: "same-origin" });
  if (res.status === 401) throw new ApiError(401, SIGN_IN_PRIVATE);
  if (res.status === 404) throw new ApiError(404, NO_ACCESS);
  if (!res.ok) throw new ApiError(res.status, `could not read ${ref.owner}/${ref.repo} (${res.status})`);
  const data = (await res.json()) as { base?: unknown; expiresAt?: unknown };
  if (typeof data.base !== "string") throw new ApiError(502, `the grant for ${ref.owner}/${ref.repo} had no base`);
  const expires = expiryMs(data.expiresAt);
  return { base: data.base, refreshAt: expires === undefined ? 0 : expires - GRANT_MARGIN_MS };
}

/**
 * The signed storage base of a private commit, from GET /api/private/grant. Cached per project id until 5 minutes before the
 * grant expires; concurrent reads share one request. A 401 means not signed in, a 404 means no access.
 */
export function privateBase(ref: HostedRef): Promise<string> {
  const key = projectIdOf({ ...ref, private: true });
  const hit = grants.get(key);
  if (hit && Date.now() < hit.refreshAt) return Promise.resolve(hit.base);
  let flight = grantsInFlight.get(key);
  if (!flight) {
    flight = fetchGrant(ref)
      .then((grant) => {
        grants.set(key, grant);
        return grant;
      })
      .finally(() => grantsInFlight.delete(key));
    grantsInFlight.set(key, flight);
  }
  return flight.then((grant) => grant.base);
}

/**
 * The base of a project's files: the function that the static api reads them through. A public commit is under the storage
 * root; a private one under its signed grant base (asynchronous).
 */
export function hostedBaseFor(root: string): (projectId: string) => string | Promise<string> {
  return (id) => {
    const ref = parseProjectId(id);
    if (!ref) throw new ApiError(404, `no hosted project ${id}`);
    return ref.private ? privateBase(ref) : indexBase(root, ref);
  };
}

/** The GitHub raw URL of one file at the indexed commit. Each path segment is encoded, so spaces and "#" survive. */
export function rawSourceUrl(ref: HostedRef, path: string): string {
  return `https://raw.githubusercontent.com/${ref.owner}/${ref.repo}/${ref.sha}/${path.split("/").map(encodeURIComponent).join("/")}`;
}

/** A thrown index request: the HTTP status (0 when the request never got one), the server's code and its message. */
export class IndexRequestError extends ApiError {
  readonly code: string;
  /** Seconds until a rate limit lifts, when the server says. */
  readonly retryAfterSeconds?: number;

  constructor(status: number, code: string, message: string, retryAfterSeconds?: number) {
    super(status, message);
    this.code = code;
    if (retryAfterSeconds !== undefined) this.retryAfterSeconds = retryAfterSeconds;
  }
}

async function readJson<T>(url: string): Promise<T | undefined> {
  const res = await fetch(url, { cache: "no-store", credentials: "same-origin" });
  if (res.status === 404) return undefined;
  if (res.status === 401) throw new ApiError(401, SIGN_IN_PRIVATE);
  if (!res.ok) throw new ApiError(res.status, `could not read ${url} (${res.status})`);
  return (await res.json()) as T;
}

/**
 * The status of one run, or undefined when no run has written one for that commit. It is read through the API
 * (GET /api/status, never cached), not from the storage: the storage's edge copy can lag behind a running job. A private
 * run's status is asked for with visibility=private, which needs the signed-in user.
 */
export function readStatus(ref: HostedRef): Promise<IndexStatus | undefined> {
  const repo = encodeURIComponent(`${ref.owner}/${ref.repo}`);
  const visibility = ref.private ? "&visibility=private" : "";
  return readJson<IndexStatus>(`${apiBase()}/api/status?repo=${repo}&sha=${ref.sha}${visibility}`);
}

/** The newest finished index of a repository, or undefined when none has finished. */
export function readLatest(root: string, owner: string, repo: string): Promise<LatestIndex | undefined> {
  return readJson<LatestIndex>(`${root}gh/${owner}/${repo}/latest.json`);
}

/** The storage key of a ref's pointer under a repository folder, as the Worker is asked for it (the stored key is encoded once, the URL twice). */
export function refPointerUrl(root: string, owner: string, repo: string, ref: string): string {
  const name = ref === "@default" ? "%40default" : encodeURIComponent(encodeURIComponent(ref));
  return `${root}gh/${owner}/${repo}/refs/${name}.json`;
}

/** Where a branch pointed when it was last indexed (public), or undefined when it was never indexed here. */
export function readRefPointer(root: string, owner: string, repo: string, ref: string): Promise<RefPointer | undefined> {
  return readJson<RefPointer>(refPointerUrl(root, owner, repo, ref));
}

/** The same for a private repository the signed-in user can read. */
export function readPrivateRefPointer(owner: string, repo: string, ref: string): Promise<RefPointer | undefined> {
  const name = encodeURIComponent(`${owner}/${repo}`);
  return readJson<RefPointer>(`${apiBase()}/api/private/latest?repo=${name}&ref=${encodeURIComponent(ref)}`);
}

/** meta.json of an indexed commit: the ref it was taken from (newer indexes) and when. Public commits only. */
export async function readIndexMeta(root: string, ref: HostedRef): Promise<{ ref?: string; capturedAt?: string } | undefined> {
  if (ref.private) return undefined;
  return readJson<{ ref?: string; capturedAt?: string }>(`${indexBase(root, ref)}meta.json`);
}

/** The newest finished private index of a repository the signed-in user can read, or undefined when there is none. */
export function readPrivateLatest(owner: string, repo: string): Promise<LatestIndex | undefined> {
  const name = encodeURIComponent(`${owner}/${repo}`);
  return readJson<LatestIndex>(`${apiBase()}/api/private/latest?repo=${name}`);
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
      credentials: "same-origin",
    });
  } catch {
    throw new IndexRequestError(0, "network", "Could not reach the indexing service");
  }
  const data = (await res.json().catch(() => ({}))) as Partial<IndexReply> & {
    error?: { code?: string; message?: string; retryAfterSeconds?: number };
  };
  if (res.status === 200 || res.status === 202) return data as IndexReply;
  throw new IndexRequestError(res.status, data.error?.code ?? "request_failed", data.error?.message ?? `indexing request failed (${res.status})`,
    typeof data.error?.retryAfterSeconds === "number" ? data.error.retryAfterSeconds : undefined,
  );
}

/**
 * The signed-in state from GET /api/auth/me. Any non-200 answer or a failed request is "sign-in is off": the page then shows
 * no sign-in controls.
 */
export async function authMe(): Promise<AuthState> {
  const off: AuthState = { enabled: false, signedIn: false };
  try {
    const res = await fetch(`${apiBase()}/api/auth/me`, { cache: "no-store", credentials: "same-origin" });
    if (res.status !== 200) return off;
    const data = (await res.json()) as Partial<AuthState>;
    const state: AuthState = { enabled: data.enabled === true, signedIn: data.signedIn === true };
    if (typeof data.login === "string") state.login = data.login;
    if (typeof data.avatarUrl === "string") state.avatarUrl = data.avatarUrl;
    if (typeof data.installUrl === "string") state.installUrl = data.installUrl;
    return state;
  } catch {
    return off;
  }
}

/** Ends the session: POST /api/auth/logout clears the cookie. */
export async function signOut(): Promise<void> {
  const res = await fetch(`${apiBase()}/api/auth/logout`, { method: "POST", cache: "no-store", credentials: "same-origin" });
  if (!res.ok) throw new ApiError(res.status, `sign-out failed (${res.status})`);
}

/** The repositories the Insight app can see for the signed-in user (the first page of each installation). */
export async function privateRepos(): Promise<PrivateRepos> {
  const res = await fetch(`${apiBase()}/api/private/repos`, { cache: "no-store", credentials: "same-origin" });
  if (res.status === 401) throw new ApiError(401, SIGN_IN_PRIVATE);
  if (!res.ok) throw new ApiError(res.status, `could not list your repositories (${res.status})`);
  const data = (await res.json()) as { repos?: unknown; installUrl?: unknown };
  const repos: PrivateRepo[] = [];
  for (const entry of Array.isArray(data.repos) ? (data.repos as Partial<PrivateRepo>[]) : []) {
    if (typeof entry.repo !== "string" || !/^[^/]+\/[^/]+$/.test(entry.repo)) continue;
    const row: PrivateRepo = { repo: entry.repo, private: entry.private === true };
    if (typeof entry.defaultBranch === "string") row.defaultBranch = entry.defaultBranch;
    repos.push(row);
  }
  return { repos, ...(typeof data.installUrl === "string" ? { installUrl: data.installUrl } : {}) };
}

/** The sign-in link: GitHub's flow starts at /api/auth/login, and the callback returns the visitor to `returnHash`. */
export function signInUrl(returnHash: string): string {
  return `${apiBase()}/api/auth/login?return=${encodeURIComponent(returnHash)}`;
}

const sourceCache = new Map<string, Promise<string | undefined>>();

/** One public source file of an indexed commit, read from raw.githubusercontent.com. A file GitHub does not have is undefined. */
async function publicSourceText(ref: HostedRef, path: string): Promise<string | undefined> {
  const res = await fetch(rawSourceUrl(ref, path));
  if (res.status === 404) return undefined;
  if (!res.ok) throw new ApiError(res.status, `GitHub answered ${res.status} for ${path}`);
  return res.text();
}

/** One source file of a private commit, read through the server with the signed-in user's access. */
async function privateSourceText(ref: HostedRef, path: string): Promise<string | undefined> {
  const query = new URLSearchParams({ repo: `${ref.owner}/${ref.repo}`, sha: ref.sha, path });
  const res = await fetch(`${apiBase()}/api/private/source?${query}`, { credentials: "same-origin" });
  if (res.status === 404) return undefined;
  if (res.status === 401) throw new ApiError(401, SIGN_IN_PRIVATE);
  if (!res.ok) throw new ApiError(res.status, `could not read ${path} (${res.status})`);
  return res.text();
}

/** One source file of an indexed commit. Each file is fetched once. */
function rawSource(projectId: string, path: string): Promise<string | undefined> {
  const ref = parseProjectId(projectId);
  if (!ref) return Promise.resolve(undefined);
  const key = `${projectId}\n${path}`;
  let hit = sourceCache.get(key);
  if (!hit) {
    hit = ref.private ? privateSourceText(ref, path) : publicSourceText(ref, path);
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
    const id = projectIdOf({ owner: parsed.owner, repo: parsed.repo, sha: reply.sha, private: reply.visibility === "private" });
    return identifyHosted(id, projectOf({ repo, sha: reply.sha, indexedAt: new Date().toISOString(), nodes: 0, files: 0 }));
  },
};
