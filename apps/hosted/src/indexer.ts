// POST /api/index and GET /api/health: the hosted indexer's request flow. A submission is deduplicated against the
// stored status of its commit, counted against the daily caps, and then indexed in the background (waitUntil). The job
// downloads the commit's tarball, exports it (@insight/export) and uploads the static files. Its progress and result go
// to status.json, which the browser polls. The layout and the codes are in the hosted-backend plan (Free-tier contract).
//
// Private repos: when the signed-in user can read the repo (GitHub's `private` field decides), the same flow runs with the
// user's token and writes under private/gh/... only (see private.ts). Public submissions are unchanged.
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { exportProject as defaultExportProject, ExportError, type ExportResult, type PhaseEvent } from "@insight/export";
import {
  authConfigFromEnv,
  installUrlOf,
  originAllowed,
  requireAccess,
  sessionFrom,
  type Env,
  type Session,
} from "./auth.js";
import {
  ArchiveLimitError,
  checkRef,
  downloadAndExtract,
  InputError,
  NotFoundError,
  parseRepoInput,
  repoInfo,
  repoName,
  resolveSha,
  UpstreamError,
  type ExtractLimits,
  type RepoInfo,
} from "./github.js";
import { errorResponse, json, NO_STORE, withCookies } from "./http.js";
import { repoStorageBase, repoStoragePrefix, type Visibility } from "./private.js";
import type { FetchLike, Storage } from "./storage.js";

export { NO_STORE };
export const IMMUTABLE = "public, max-age=31536000, immutable";
export const SHORT_CACHE = "public, max-age=60";
const JSON_TYPE = "application/json";
const RECENT_LIMIT = 50;
const RUNNING_FRESH_MS = 6 * 60 * 1000;
const FAILED_RETRY_MS = 60 * 60 * 1000;
/** Status writes: only on a phase change, and at most one per this many ms (the KV write budget, see docs/hosting.md). */
const STATUS_INTERVAL_MS = 3000;
/** The daily index cap with Workers KV (1k writes a day on the free plan; one index writes about 26 times). */
const KV_DAILY_CAP = 25;
const DAILY_CAP = 200;
const WATCHDOG_MS = 270_000;

/** The hosted caps: 10k files, 1 MiB per file, 200 MiB in total. */
export const HOSTED_LIMITS: Required<ExtractLimits> = {
  maxFiles: 10_000,
  maxFileBytes: 1024 * 1024,
  maxTotalBytes: 200 * 1024 * 1024,
};

export type ErrorCode =
  | "bad_request"
  | "method_not_allowed"
  | "not_found"
  | "too_large"
  | "rate_limited"
  | "timeout"
  | "index_failed"
  | "upstream_error"
  | "auth_required"
  | "forbidden";

export interface IndexError {
  code: ErrorCode | string;
  message: string;
}

export interface IndexStatus {
  repo: string;
  sha: string;
  ref: string;
  state: "running" | "done" | "failed";
  phase?: string;
  done?: number;
  total?: number;
  error?: IndexError;
  startedAt: string;
  updatedAt: string;
}

export interface IndexDeps {
  storage: Storage;
  /** GITHUB_TOKEN, MAX_REPO_KB, INDEX_DAILY_CAP, INDEX_IP_DAILY_CAP, and the sign-in variables. Unset values take their defaults. */
  env: Record<string, string | undefined>;
  fetch: FetchLike;
  waitUntil: (promise: Promise<unknown>) => void;
  now: () => number;
  exportProject: typeof defaultExportProject;
  /** Scratch folder; each job works in <tmpRoot>/<sha> (private: <tmpRoot>/private-<sha>) and removes it when done. */
  tmpRoot: string;
  /** Watchdog for one job. Defaults to 270 s. */
  timeoutMs?: number;
  /** Caps for the download and the export. Defaults to HOSTED_LIMITS. */
  limits?: Required<ExtractLimits>;
}

function intEnv(value: string | undefined, fallback: number): number {
  const n = value === undefined || value.trim() === "" ? NaN : Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

/** The client's address for the per-IP cap: the first x-forwarded-for entry, else x-real-ip. */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  if (first) return first;
  const real = request.headers.get("x-real-ip")?.trim();
  return real ? real : "unknown";
}

function utcDay(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/** Seconds until the daily counters reset at 00:00 UTC. */
function secondsToUtcMidnight(nowMs: number): number {
  const next = Date.UTC(new Date(nowMs).getUTCFullYear(), new Date(nowMs).getUTCMonth(), new Date(nowMs).getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - nowMs) / 1000));
}

interface DailyCounter {
  total: number;
  ips: Record<string, number>;
}

function errorMessage(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.length > 500 ? `${text.slice(0, 497)}...` : text;
}

/** The job's error code. Limit breaches are too_large; anything else that fails is index_failed. */
function failureCode(err: unknown): ErrorCode {
  if (err instanceof ArchiveLimitError) return "too_large";
  if (err instanceof ExportError) return err.code === "too_large" ? "too_large" : "index_failed";
  if (err instanceof Error && err.name === "IndexLimitError") return "too_large";
  if (err instanceof NotFoundError) return "not_found";
  return "index_failed";
}

/** The pointer name used for "the default branch" when a submission named no ref. */
export const DEFAULT_REF = "@default";

/** The storage key (under the repo folder) of a ref's pointer: refs/<encodeURIComponent(ref)>.json. */
export function refPointerKey(ref: string): string {
  return ref === DEFAULT_REF ? `refs/${DEFAULT_REF}.json` : `refs/${encodeURIComponent(ref)}.json`;
}

/**
 * Ref pointers: refs/<encoded ref>.json = {ref, sha, indexedAt} next to latest.json (same visibility, same cache). A
 * submission with no ref also writes refs/@default.json ("@" is not a valid ref character, so no branch collides with it).
 */
export async function writeRefPointers(
  storage: Storage,
  args: { owner: string; repo: string; visibility: Visibility; ref: string; sha: string; indexedAt: string; isDefault?: boolean },
): Promise<void> {
  const pointer = JSON.stringify({ ref: args.ref, sha: args.sha, indexedAt: args.indexedAt });
  const opts = { contentType: JSON_TYPE, cacheControl: SHORT_CACHE, gzip: true };
  const base = repoStorageBase(args.owner, args.repo, args.visibility);
  await storage.put(`${base}${refPointerKey(args.ref)}`, pointer, opts);
  if (args.isDefault) await storage.put(`${base}${refPointerKey(DEFAULT_REF)}`, pointer, opts);
}

/**
 * Writes the commit's static export (gzip, immutable), then latest.json and, for a public index only, recent.json. A
 * private index writes its files and latest.json under private/gh/... and nothing else.
 */
export async function publishExport(
  storage: Storage,
  args: {
    owner: string;
    repo: string;
    sha: string;
    ref: string;
    indexedAt: string;
    result: ExportResult;
    visibility?: Visibility;
    /** The submission named no ref, so the resolved default branch is also the "@default" pointer. */
    isDefault?: boolean;
  },
): Promise<void> {
  const { owner, repo, sha, ref, indexedAt, result } = args;
  const visibility = args.visibility ?? "public";
  const prefix = repoStoragePrefix(owner, repo, sha, visibility);
  for (const [path, rawText] of result.files) {
    let text = rawText;
    // The index's metadata says which ref it was taken from, so the page can show "from <branch>".
    if (path === "meta.json") {
      try {
        text = JSON.stringify({ ...JSON.parse(rawText), ref });
      } catch {
        text = rawText;
      }
    }
    await storage.put(prefix + path, text, { contentType: JSON_TYPE, cacheControl: IMMUTABLE, gzip: true });
  }
  const name = repoName(owner, repo);
  const { nodes, files } = result.meta;
  await storage.put(
    `${repoStorageBase(owner, repo, visibility)}latest.json`,
    JSON.stringify({ repo: name, sha, ref, indexedAt, nodes, files }),
    { contentType: JSON_TYPE, cacheControl: SHORT_CACHE, gzip: true },
  );
  await writeRefPointers(storage, { owner, repo, visibility, ref, sha, indexedAt, isDefault: args.isDefault });
  if (visibility === "private") return;
  const previous = (await storage.getJson<{ repo: string }[]>("meta/recent.json")) ?? [];
  const recent = [{ repo: name, sha, indexedAt, nodes, files }, ...previous.filter((e) => e.repo !== name)].slice(
    0,
    RECENT_LIMIT,
  );
  await storage.put("meta/recent.json", JSON.stringify(recent), {
    contentType: JSON_TYPE,
    cacheControl: SHORT_CACHE,
    gzip: true,
  });
}

/** Writes status.json (never cached, not gzipped: the browser polls it). */
export async function writeStatus(
  storage: Storage,
  owner: string,
  repo: string,
  sha: string,
  status: IndexStatus,
  visibility: Visibility = "public",
) {
  await storage.put(`${repoStoragePrefix(owner, repo, sha, visibility)}status.json`, JSON.stringify(status), {
    contentType: JSON_TYPE,
    cacheControl: NO_STORE,
  });
}

/** The statuses below are the job's view; `finalized` stops every write once the job has a final state. */
interface JobContext {
  owner: string;
  repo: string;
  sha: string;
  ref: string;
  startedAt: string;
  deps: IndexDeps;
  limits: Required<ExtractLimits>;
  timeoutMs: number;
  finalized: boolean;
  /** The phase last written to status.json (queued at submission). */
  phase?: string;
  /** When status.json was last written (ms); the write throttle reads it. */
  lastWrite: number;
  visibility: Visibility;
  /** The signed-in user's token, for a private index only. Used for the download; never stored. */
  token?: string;
  /** The submission named no ref. */
  isDefault?: boolean;
}

async function writeJobStatus(ctx: JobContext, patch: Partial<IndexStatus>): Promise<void> {
  if (ctx.finalized) return;
  const status: IndexStatus = {
    repo: repoName(ctx.owner, ctx.repo),
    sha: ctx.sha,
    ref: ctx.ref,
    state: "running",
    startedAt: ctx.startedAt,
    updatedAt: new Date(ctx.deps.now()).toISOString(),
    ...patch,
  };
  ctx.lastWrite = ctx.deps.now();
  await writeStatus(ctx.deps.storage, ctx.owner, ctx.repo, ctx.sha, status, ctx.visibility);
}

/** The scratch folder key of a job: private jobs get their own folder, so they never share one with a public job. */
function scratchKey(ctx: JobContext): string {
  return ctx.visibility === "private" ? `private-${ctx.sha}` : ctx.sha;
}

async function runJob(ctx: JobContext): Promise<void> {
  const { owner, repo, sha, ref, deps } = ctx;
  const jobDir = join(deps.tmpRoot, scratchKey(ctx));
  const src = join(jobDir, "src");
  const home = join(jobDir, "home");
  // Phase writes: one per phase change, at most one per STATUS_INTERVAL_MS (later events of the same phase are dropped).
  // The chain keeps the writes in order.
  let chain: Promise<void> = Promise.resolve();
  let writtenPhase: string | undefined = ctx.phase;
  const progress = (p: PhaseEvent): void => {
    if (ctx.finalized || p.phase === writtenPhase) return;
    if (deps.now() - ctx.lastWrite < STATUS_INTERVAL_MS) return;
    writtenPhase = p.phase;
    ctx.lastWrite = deps.now();
    chain = chain.then(() => writeJobStatus(ctx, { phase: p.phase, done: p.done, total: p.total }));
  };
  try {
    progress({ phase: "download" });
    await chain;
    await downloadAndExtract(owner, repo, sha, src, ctx.limits, deps.fetch, ctx.token);
    const result = await deps.exportProject({
      root: src,
      name: repo,
      commit: sha,
      home,
      url: `https://github.com/${owner}/${repo}`,
      limits: ctx.limits,
      onPhase: progress,
    });
    await chain;
    if (ctx.finalized) return;
    await publishExport(deps.storage, {
      owner,
      repo,
      sha,
      ref,
      indexedAt: new Date(deps.now()).toISOString(),
      result,
      visibility: ctx.visibility,
      isDefault: ctx.isDefault,
    });
    await finish(ctx, { state: "done" });
  } catch (err) {
    await finish(ctx, { state: "failed", error: { code: failureCode(err), message: errorMessage(err) } });
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
}

/** Sets the final status once. Later writes from the same job are dropped. */
async function finish(ctx: JobContext, patch: Partial<IndexStatus>): Promise<void> {
  if (ctx.finalized) return;
  ctx.finalized = true;
  await writeStatus(
    ctx.deps.storage,
    ctx.owner,
    ctx.repo,
    ctx.sha,
    {
      repo: repoName(ctx.owner, ctx.repo),
      sha: ctx.sha,
      ref: ctx.ref,
      startedAt: ctx.startedAt,
      updatedAt: new Date(ctx.deps.now()).toISOString(),
      state: "running",
      ...patch,
    } as IndexStatus,
    ctx.visibility,
  );
}

/** Runs the job, with the watchdog: past the timeout the status becomes failed/timeout and later writes are dropped. */
async function runWithWatchdog(ctx: JobContext): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ctx.timeoutMs);
  });
  const outcome = await Promise.race([runJob(ctx).then(() => "finished" as const), timeout]);
  clearTimeout(timer);
  if (outcome === "timeout") {
    await finish(ctx, {
      state: "failed",
      error: { code: "timeout", message: `indexing took longer than ${Math.round(ctx.timeoutMs / 1000)} s` },
    });
    await rm(join(ctx.deps.tmpRoot, scratchKey(ctx)), { recursive: true, force: true });
  }
}

/** POST /api/index. Body: {repo: "owner/repo" | GitHub URL, ref?: string}. */
export async function handleIndex(request: Request, deps: IndexDeps): Promise<Response> {
  if (request.method !== "POST") return errorResponse(405, "method_not_allowed", "use POST");
  const session = await sessionFrom(request, deps.env as Env, deps.fetch);
  return withCookies(await submit(request, deps, session), session?.setCookie);
}

async function submit(request: Request, deps: IndexDeps, session: Session | undefined): Promise<Response> {
  const auth = authConfigFromEnv(deps.env as Env);
  if (session !== undefined && auth !== undefined && !originAllowed(request, auth)) {
    return errorResponse(403, "forbidden", "this request must come from the Insight site");
  }

  let body: { repo?: unknown; ref?: unknown };
  try {
    body = (await request.json()) as { repo?: unknown; ref?: unknown };
  } catch {
    return errorResponse(400, "bad_request", "the body must be JSON: {repo, ref?}");
  }
  if (typeof body.repo !== "string") return errorResponse(400, "bad_request", "repo must be a string");

  let parsed;
  let requestedRef: string | undefined;
  try {
    parsed = parseRepoInput(body.repo);
    if (body.ref !== undefined) {
      if (typeof body.ref !== "string") throw new InputError("ref must be a string");
      requestedRef = checkRef(body.ref);
    }
  } catch (err) {
    return errorResponse(400, "bad_request", errorMessage(err));
  }
  const { owner, repo } = parsed;
  const name = repoName(owner, repo);
  // A signed-in request reads GitHub with the user's token (so it sees the repos the user can read); else GITHUB_TOKEN.
  const opts = { fetch: deps.fetch, token: session ? session.token : deps.env.GITHUB_TOKEN || undefined };

  let info: RepoInfo;
  try {
    info = await repoInfo(owner, repo, { ...opts, allowPrivate: true });
  } catch (err) {
    if (err instanceof NotFoundError) {
      if (session === undefined) {
        if (auth === undefined) return errorResponse(404, "not_found", err.message);
        // GitHub answers 404 to anonymous requests for private repos, so this may be a private repo.
        return errorResponse(401, "auth_required", `${name} was not found or is private; sign in with GitHub to index a private repository`);
      }
      return errorResponse(404, "not_found", `${name} was not found, or the Insight app is not installed on it`, {
        installUrl: auth ? installUrlOf(auth) : undefined,
      });
    }
    if (err instanceof UpstreamError) return errorResponse(502, "upstream_error", err.message);
    throw err;
  }
  if (info.private && session === undefined) {
    if (auth === undefined) return errorResponse(404, "not_found", `${name} is private`);
    return errorResponse(401, "auth_required", `${name} is private; sign in with GitHub to index it`);
  }
  const visibility: Visibility = info.private ? "private" : "public";
  // Private replies say so; public replies keep their shape.
  const reply = (status: number, bodyOut: Record<string, unknown>): Response =>
    json(status, visibility === "private" ? { ...bodyOut, visibility } : bodyOut);

  let sha: string;
  let ref: string;
  try {
    const maxKb = intEnv(deps.env.MAX_REPO_KB, 300_000);
    if (info.size > maxKb) {
      return errorResponse(413, "too_large", `${name} is ${info.size} KB; the hosted limit is ${maxKb} KB`);
    }
    ref = requestedRef ?? parsed.ref ?? info.default_branch;
    sha = await resolveSha(owner, repo, ref, opts);
  } catch (err) {
    if (err instanceof NotFoundError) return errorResponse(404, "not_found", err.message);
    if (err instanceof UpstreamError) return errorResponse(502, "upstream_error", err.message);
    throw err;
  }

  const now = deps.now();
  const existing = await deps.storage.getJson<IndexStatus>(`${repoStoragePrefix(owner, repo, sha, visibility)}status.json`);
  if (existing) {
    if (existing.state === "done") {
      const base = repoStorageBase(owner, repo, visibility);
      const pointer = await deps.storage.getJson<{ sha?: string }>(`${base}${refPointerKey(ref)}`);
      if (pointer?.sha === sha) return reply(200, { state: "done", repo: name, sha, ref, upToDate: true });
      // The commit is indexed but the ref's pointer is missing or names another commit (the branch moved back, or the index
      // predates pointers): move the pointer to it, so "latest of <ref>" is this commit.
      await writeRefPointers(deps.storage, {
        owner, repo, visibility, ref, sha, indexedAt: existing.updatedAt, isDefault: requestedRef === undefined && parsed.ref === undefined,
      });
      return reply(200, { state: "done", repo: name, sha, ref });
    }
    const updated = Date.parse(existing.updatedAt);
    if (existing.state === "running" && now - updated < RUNNING_FRESH_MS) {
      return reply(202, { state: "running", repo: name, sha, ref });
    }
    if (existing.state === "failed" && now - updated < FAILED_RETRY_MS) {
      return reply(200, { state: "failed", repo: name, sha, ref, error: existing.error });
    }
  }

  const dailyCap = intEnv(deps.env.INDEX_DAILY_CAP, deps.storage.kind === "kv" ? KV_DAILY_CAP : DAILY_CAP);
  const ipCap = intEnv(deps.env.INDEX_IP_DAILY_CAP, 10);
  // The per-identity cap: an address for public indexes, the signed-in user for private ones.
  const identity = session !== undefined && visibility === "private" ? `user:${session.user.id}` : clientIp(request);
  const dayKey = `meta/daily/${utcDay(now)}.json`;
  const counter = (await deps.storage.getJson<DailyCounter>(dayKey)) ?? { total: 0, ips: {} };
  const identityCount = counter.ips[identity] ?? 0;
  if (counter.total >= dailyCap) {
    return errorResponse(429, "rate_limited", "the daily indexing limit has been reached; try again tomorrow", {
      retryAfterSeconds: secondsToUtcMidnight(now),
    });
  }
  if (identityCount >= ipCap) {
    const who = identity.startsWith("user:") ? "this account" : "this address";
    return errorResponse(429, "rate_limited", `${who} has reached its ${ipCap} indexes for today`, {
      retryAfterSeconds: secondsToUtcMidnight(now),
    });
  }
  await deps.storage.put(
    dayKey,
    JSON.stringify({ total: counter.total + 1, ips: { ...counter.ips, [identity]: identityCount + 1 } }),
    { contentType: JSON_TYPE, cacheControl: NO_STORE },
  );

  const startedAt = new Date(now).toISOString();
  const ctx: JobContext = {
    owner,
    repo,
    sha,
    ref,
    startedAt,
    deps,
    limits: deps.limits ?? HOSTED_LIMITS,
    timeoutMs: deps.timeoutMs ?? WATCHDOG_MS,
    finalized: false,
    phase: "queued",
    lastWrite: 0,
    visibility,
    token: visibility === "private" ? session?.token : undefined,
    isDefault: requestedRef === undefined && parsed.ref === undefined,
  };
  await writeJobStatus(ctx, { state: "running", phase: "queued" });
  deps.waitUntil(runWithWatchdog(ctx));
  return reply(202, { state: "running", repo: name, sha, ref });
}

/** GET /api/health: {ok, storage: "kv" | "r2" | "fs"}. */
export function handleHealth(deps: { storage: Pick<Storage, "kind"> }): Response {
  return json(200, { ok: true, storage: deps.storage.kind });
}

/**
 * GET /api/status?repo=owner/repo&sha=<40 hex>[&visibility=private]: the run's status.json, never cached. The page polls
 * this rather than reading the storage: edge reads of a changing object can lag by up to a minute, the API read does not.
 * A private run needs a signed-in user who can read the repo.
 */
export async function handleStatus(
  request: Request,
  deps: { storage: Storage; env?: Env; fetch?: FetchLike },
): Promise<Response> {
  if (request.method !== "GET") return errorResponse(405, "method_not_allowed", "use GET");
  const url = new URL(request.url);
  const repoText = url.searchParams.get("repo") ?? "";
  const sha = url.searchParams.get("sha") ?? "";
  let parsed;
  try {
    parsed = parseRepoInput(repoText);
  } catch {
    return errorResponse(400, "bad_request", "repo must be owner/repo");
  }
  if (parsed.ref !== undefined) return errorResponse(400, "bad_request", "repo must be owner/repo");
  if (!/^[0-9a-f]{40}$/.test(sha)) return errorResponse(400, "bad_request", "sha must be a 40-character commit id");
  const visibility = url.searchParams.get("visibility");
  if (visibility !== null && visibility !== "public" && visibility !== "private") {
    return errorResponse(400, "bad_request", "visibility must be public or private");
  }

  if (visibility === "private") {
    const fetchFn: FetchLike = deps.fetch ?? ((input, init) => fetch(input, init));
    const session = await requireAccess(request, deps.env ?? {}, fetchFn, parsed.owner, parsed.repo);
    if (session instanceof Response) return session;
    const status = await deps.storage.getJson<IndexStatus>(
      `${repoStoragePrefix(parsed.owner, parsed.repo, sha, "private")}status.json`,
    );
    if (status === undefined) return withCookies(errorResponse(404, "not_found", "no index run for this commit"), session.setCookie);
    return withCookies(json(200, status), session.setCookie);
  }

  const status = await deps.storage.getJson<IndexStatus>(`${repoStoragePrefix(parsed.owner, parsed.repo, sha, "public")}status.json`);
  if (status === undefined) return errorResponse(404, "not_found", "no index run for this commit");
  return json(200, status);
}
