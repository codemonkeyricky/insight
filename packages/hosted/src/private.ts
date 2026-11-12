// Reads of private indexes: the signed storage grant (a 12-hour base URL for the storage Worker), the source text of one
// file (GitHub's contents API), the latest index of a repo, and the repos the app can see for the signed-in user. Every
// read checks the user's access with GitHub first; the signature is what the storage Worker checks.
import { createHmac } from "node:crypto";
import { authConfigFromEnv, installUrlOf, requireAccess, requireSession, type Env } from "./auth.js";
import { parseRepoInput } from "./github.js";
import { errorResponse, json, withCookies } from "./http.js";
import { parseKey } from "./session.js";
import { storageFromEnv } from "./env.js";
import type { FetchLike, Storage } from "./storage.js";

export type Visibility = "public" | "private";

/** A signed storage base lives this long (seconds). */
export const GRANT_LIFETIME_S = 12 * 60 * 60;
const API = "https://api.github.com";
const USER_AGENT = "insight-indexer";
const MAX_INSTALLATIONS = 5;

/** The storage folder of a repo: "gh/<o>/<r>/" (public) or "private/gh/<o>/<r>/" (private). */
export function repoStorageBase(owner: string, repo: string, visibility: Visibility): string {
  return `${visibility === "private" ? "private/" : ""}gh/${owner}/${repo}/`;
}

/** The storage folder of one commit of a repo, with its trailing slash. */
export function repoStoragePrefix(owner: string, repo: string, sha: string, visibility: Visibility): string {
  return `${repoStorageBase(owner, repo, visibility)}${sha}/`;
}

/**
 * The signature of a storage prefix: base64url(HMAC-SHA256(key, `${exp}:${prefix}`)). The storage Worker computes the same
 * value (workers/storage/index.js) and compares it in constant time.
 */
export function signPrefix(key: Buffer, exp: number, prefix: string): string {
  return createHmac("sha256", key).update(`${exp}:${prefix}`).digest("base64url");
}

/** STORAGE_SIGNING_KEY as a 32-byte key, or undefined. */
export function signingKeyOf(env: Env): Buffer | undefined {
  const text = env.STORAGE_SIGNING_KEY?.trim();
  return text ? parseKey(text) : undefined;
}

/** The public base of the storage Worker (no trailing slash): STORAGE_PUBLIC_BASE, else KV_PUBLIC_BASE, else R2_PUBLIC_BASE. */
export function storageBaseOf(env: Env): string | undefined {
  const base = (env.STORAGE_PUBLIC_BASE || env.KV_PUBLIC_BASE || env.R2_PUBLIC_BASE || "").trim().replace(/\/+$/, "");
  return base === "" ? undefined : base;
}

/** The owner and repo a request names (?repo=owner/repo), and its commit (?sha=, when wanted), or the 400 answer. */
function readTarget(url: URL, withSha: boolean): { owner: string; repo: string; sha: string } | Response {
  let parsed;
  try {
    parsed = parseRepoInput(url.searchParams.get("repo") ?? "");
  } catch {
    return errorResponse(400, "bad_request", "repo must be owner/repo");
  }
  if (parsed.ref !== undefined) return errorResponse(400, "bad_request", "repo must be owner/repo");
  const sha = url.searchParams.get("sha") ?? "";
  if (withSha && !/^[0-9a-f]{40}$/.test(sha)) return errorResponse(400, "bad_request", "sha must be a 40-character commit id");
  return { owner: parsed.owner, repo: parsed.repo, sha };
}

/** Why a source path is refused, or undefined when it is a relative path with no empty, "." or ".." segment. */
export function sourcePathError(path: string): string | undefined {
  if (path === "") return "path is required";
  if (path.startsWith("/")) return "path must be relative";
  if (/[\0\\]/.test(path)) return "path has invalid characters";
  if (path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    return "path may not contain empty, '.' or '..' segments";
  }
  return undefined;
}

export interface PrivateDeps {
  env: Env;
  fetch: FetchLike;
  now: () => number;
  /** The index store; read only by GET /api/private/latest. Defaults to the environment's store. */
  storage?: Storage;
}

async function githubGet(url: string, token: string, fetchFn: FetchLike): Promise<Response> {
  return fetchFn(url, {
    headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "User-Agent": USER_AGENT },
  });
}

/** GET /api/private/grant?repo=o/r&sha=: {base, expiresAt}, where base is a signed storage prefix valid for 12 hours. */
export async function handleGrant(request: Request, deps: PrivateDeps): Promise<Response> {
  if (request.method !== "GET") return errorResponse(405, "method_not_allowed", "use GET");
  if (!authConfigFromEnv(deps.env)) return errorResponse(404, "not_found", "sign-in is not configured");
  const target = readTarget(new URL(request.url), true);
  if (target instanceof Response) return target;
  const key = signingKeyOf(deps.env);
  const base = storageBaseOf(deps.env);
  if (key === undefined || base === undefined) return errorResponse(404, "not_found", "private reads are not configured");
  const session = await requireAccess(request, deps.env, deps.fetch, target.owner, target.repo);
  if (session instanceof Response) return session;

  const exp = Math.floor(deps.now() / 1000) + GRANT_LIFETIME_S;
  const prefix = repoStoragePrefix(target.owner, target.repo, target.sha, "private");
  const sig = signPrefix(key, exp, prefix);
  return withCookies(
    json(200, { base: `${base}/p/${exp}/${sig}/${prefix}`, expiresAt: new Date(exp * 1000).toISOString() }),
    session.setCookie,
  );
}

/**
 * GET /api/private/source?repo=o/r&sha=&path=: the text of one file at the commit, read through GitHub's contents API as
 * the signed-in user (GitHub's answer is the access check).
 */
export async function handleSource(request: Request, deps: PrivateDeps): Promise<Response> {
  if (request.method !== "GET") return errorResponse(405, "method_not_allowed", "use GET");
  if (!authConfigFromEnv(deps.env)) return errorResponse(404, "not_found", "sign-in is not configured");
  const url = new URL(request.url);
  const target = readTarget(url, true);
  if (target instanceof Response) return target;
  const path = url.searchParams.get("path") ?? "";
  const problem = sourcePathError(path);
  if (problem !== undefined) return errorResponse(400, "bad_request", problem);
  const session = await requireSession(request, deps.env, deps.fetch);
  if (session instanceof Response) return session;

  const encoded = path.split("/").map(encodeURIComponent).join("/");
  const res = await fetchGithubRaw(`${API}/repos/${target.owner}/${target.repo}/contents/${encoded}?ref=${target.sha}`, session.token, deps.fetch);
  const withSession = (out: Response): Response => withCookies(out, session.setCookie);
  if (res.status === 404 || res.status === 403) {
    return withSession(errorResponse(404, "not_found", `${path} was not found at ${target.sha}`));
  }
  if (!res.ok) return withSession(errorResponse(502, "upstream_error", `GitHub answered ${res.status} for ${path}`));
  const text = await res.text();
  return withSession(
    new Response(text, {
      status: 200,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "private, max-age=3600" },
    }),
  );
}

function fetchGithubRaw(url: string, token: string, fetchFn: FetchLike): Promise<Response> {
  return fetchFn(url, {
    headers: { Accept: "application/vnd.github.raw", Authorization: `Bearer ${token}`, "User-Agent": USER_AGENT },
  });
}

/** GET /api/private/latest?repo=o/r: the private index's latest.json, for a signed-in user who can read the repo. */
export async function handleLatest(request: Request, deps: PrivateDeps): Promise<Response> {
  if (request.method !== "GET") return errorResponse(405, "method_not_allowed", "use GET");
  if (!authConfigFromEnv(deps.env)) return errorResponse(404, "not_found", "sign-in is not configured");
  const target = readTarget(new URL(request.url), false);
  if (target instanceof Response) return target;
  const session = await requireAccess(request, deps.env, deps.fetch, target.owner, target.repo);
  if (session instanceof Response) return session;
  const storage = deps.storage ?? storageFromEnv(deps.env);
  // ?ref=<branch> (or @default) reads that ref's pointer instead of latest.json.
  const refParam = new URL(request.url).searchParams.get("ref");
  const name = refParam === null ? "latest.json" : `refs/${encodeURIComponent(refParam)}.json`;
  const latest = await storage.getJson(`${repoStorageBase(target.owner, target.repo, "private")}${name}`);
  if (latest === undefined) return withCookies(errorResponse(404, "not_found", "no private index for this repository"), session.setCookie);
  return withCookies(json(200, latest), session.setCookie);
}

/**
 * GET /api/private/repos: the repos the app can see for the signed-in user. Up to 5 installations, the first page (100) of
 * each. Answers {repos: [{repo, private, defaultBranch}], installUrl}.
 */
export async function handleRepos(request: Request, deps: PrivateDeps): Promise<Response> {
  if (request.method !== "GET") return errorResponse(405, "method_not_allowed", "use GET");
  const config = authConfigFromEnv(deps.env);
  if (!config) return errorResponse(404, "not_found", "sign-in is not configured");
  const session = await requireSession(request, deps.env, deps.fetch);
  if (session instanceof Response) return session;
  const withSession = (out: Response): Response => withCookies(out, session.setCookie);

  const installsRes = await githubGet(`${API}/user/installations?per_page=100`, session.token, deps.fetch);
  if (!installsRes.ok) return withSession(errorResponse(502, "upstream_error", `GitHub answered ${installsRes.status} for installations`));
  const installs = ((await installsRes.json()) as { installations?: { id: number }[] }).installations ?? [];

  const repos = new Map<string, { repo: string; private: boolean; defaultBranch: string | null }>();
  for (const install of installs.slice(0, MAX_INSTALLATIONS)) {
    const res = await githubGet(`${API}/user/installations/${install.id}/repositories?per_page=100`, session.token, deps.fetch);
    if (!res.ok) return withSession(errorResponse(502, "upstream_error", `GitHub answered ${res.status} for repositories`));
    const page = (await res.json()) as {
      repositories?: { full_name: string; private: boolean; default_branch?: string }[];
    };
    for (const item of page.repositories ?? []) {
      const repo = item.full_name.toLowerCase();
      if (!repos.has(repo)) repos.set(repo, { repo, private: item.private, defaultBranch: item.default_branch ?? null });
    }
  }
  return withSession(json(200, { repos: [...repos.values()], installUrl: installUrlOf(config) ?? null }));
}
