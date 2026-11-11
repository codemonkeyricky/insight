// POST /api/index and GET /api/health: the hosted indexer's request flow. A submission is deduplicated against the
// stored status of its commit, counted against the daily caps, and then indexed in the background (waitUntil). The job
// downloads the commit's tarball, exports it (@insight/export) and uploads the static files. Its progress and result go
// to status.json, which the browser polls. The layout and the codes are in the hosted-backend plan (Free-tier contract).
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { exportProject as defaultExportProject, ExportError, type ExportResult, type PhaseEvent } from "@insight/export";
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
} from "./github.js";
import type { FetchLike, Storage } from "./storage.js";

export const IMMUTABLE = "public, max-age=31536000, immutable";
export const SHORT_CACHE = "public, max-age=60";
export const NO_STORE = "no-store";
const JSON_TYPE = "application/json";
const RECENT_LIMIT = 50;
const RUNNING_FRESH_MS = 6 * 60 * 1000;
const FAILED_RETRY_MS = 60 * 60 * 1000;
const PROGRESS_INTERVAL_MS = 1000;
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
  | "upstream_error";

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
  /** GITHUB_TOKEN, MAX_REPO_KB, INDEX_DAILY_CAP, INDEX_IP_DAILY_CAP. Unset values take their defaults. */
  env: Record<string, string | undefined>;
  fetch: FetchLike;
  waitUntil: (promise: Promise<unknown>) => void;
  now: () => number;
  exportProject: typeof defaultExportProject;
  /** Scratch folder; each job works in <tmpRoot>/<sha> and removes it when done. */
  tmpRoot: string;
  /** Watchdog for one job. Defaults to 270 s. */
  timeoutMs?: number;
  /** Caps for the download and the export. Defaults to HOSTED_LIMITS. */
  limits?: Required<ExtractLimits>;
}

function json(status: number, body: unknown, cacheControl = NO_STORE): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": JSON_TYPE, "cache-control": cacheControl },
  });
}

function errorResponse(status: number, code: ErrorCode, message: string): Response {
  return json(status, { error: { code, message } });
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

function repoPrefix(owner: string, repo: string, sha: string): string {
  return `gh/${owner}/${repo}/${sha}/`;
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

/** Writes the commit's static export (gzip, immutable), then latest.json and recent.json. */
export async function publishExport(
  storage: Storage,
  args: { owner: string; repo: string; sha: string; ref: string; indexedAt: string; result: ExportResult },
): Promise<void> {
  const { owner, repo, sha, ref, indexedAt, result } = args;
  const prefix = repoPrefix(owner, repo, sha);
  for (const [path, text] of result.files) {
    await storage.put(prefix + path, text, { contentType: JSON_TYPE, cacheControl: IMMUTABLE, gzip: true });
  }
  const name = repoName(owner, repo);
  const { nodes, files } = result.meta;
  await storage.put(
    `gh/${owner}/${repo}/latest.json`,
    JSON.stringify({ repo: name, sha, ref, indexedAt, nodes, files }),
    { contentType: JSON_TYPE, cacheControl: SHORT_CACHE, gzip: true },
  );
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
export async function writeStatus(storage: Storage, owner: string, repo: string, sha: string, status: IndexStatus) {
  await storage.put(`${repoPrefix(owner, repo, sha)}status.json`, JSON.stringify(status), {
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
  lastWrite: number;
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
  await writeStatus(ctx.deps.storage, ctx.owner, ctx.repo, ctx.sha, status);
}

async function runJob(ctx: JobContext): Promise<void> {
  const { owner, repo, sha, ref, deps } = ctx;
  const jobDir = join(deps.tmpRoot, sha);
  const src = join(jobDir, "src");
  const home = join(jobDir, "home");
  // Phase writes are throttled to one per second; the chain keeps them in order.
  let chain: Promise<void> = Promise.resolve();
  const progress = (p: PhaseEvent): void => {
    if (ctx.finalized || deps.now() - ctx.lastWrite < PROGRESS_INTERVAL_MS) return;
    chain = chain.then(() => writeJobStatus(ctx, { phase: p.phase, done: p.done, total: p.total }));
  };
  try {
    progress({ phase: "download" });
    await chain;
    await downloadAndExtract(owner, repo, sha, src, ctx.limits, deps.fetch);
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
  await writeStatus(ctx.deps.storage, ctx.owner, ctx.repo, ctx.sha, {
    repo: repoName(ctx.owner, ctx.repo),
    sha: ctx.sha,
    ref: ctx.ref,
    startedAt: ctx.startedAt,
    updatedAt: new Date(ctx.deps.now()).toISOString(),
    state: "running",
    ...patch,
  } as IndexStatus);
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
    await rm(join(ctx.deps.tmpRoot, ctx.sha), { recursive: true, force: true });
  }
}

/** POST /api/index. Body: {repo: "owner/repo" | GitHub URL, ref?: string}. */
export async function handleIndex(request: Request, deps: IndexDeps): Promise<Response> {
  if (request.method !== "POST") return errorResponse(405, "method_not_allowed", "use POST");

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
  const opts = { fetch: deps.fetch, token: deps.env.GITHUB_TOKEN || undefined };

  let sha: string;
  let ref: string;
  try {
    const info = await repoInfo(owner, repo, opts);
    const maxKb = intEnv(deps.env.MAX_REPO_KB, 300_000);
    if (info.size > maxKb) {
      return errorResponse(413, "too_large", `${repoName(owner, repo)} is ${info.size} KB; the hosted limit is ${maxKb} KB`);
    }
    ref = requestedRef ?? parsed.ref ?? info.default_branch;
    sha = await resolveSha(owner, repo, ref, opts);
  } catch (err) {
    if (err instanceof NotFoundError) return errorResponse(404, "not_found", err.message);
    if (err instanceof UpstreamError) return errorResponse(502, "upstream_error", err.message);
    throw err;
  }

  const now = deps.now();
  const name = repoName(owner, repo);
  const existing = await deps.storage.getJson<IndexStatus>(`${repoPrefix(owner, repo, sha)}status.json`);
  if (existing) {
    if (existing.state === "done") return json(200, { state: "done", repo: name, sha });
    const updated = Date.parse(existing.updatedAt);
    if (existing.state === "running" && now - updated < RUNNING_FRESH_MS) {
      return json(202, { state: "running", repo: name, sha });
    }
    if (existing.state === "failed" && now - updated < FAILED_RETRY_MS) {
      return json(200, { state: "failed", repo: name, sha, error: existing.error });
    }
  }

  const dailyCap = intEnv(deps.env.INDEX_DAILY_CAP, 200);
  const ipCap = intEnv(deps.env.INDEX_IP_DAILY_CAP, 10);
  const ip = clientIp(request);
  const dayKey = `meta/daily/${utcDay(now)}.json`;
  const counter = (await deps.storage.getJson<DailyCounter>(dayKey)) ?? { total: 0, ips: {} };
  const ipCount = counter.ips[ip] ?? 0;
  if (counter.total >= dailyCap) {
    return errorResponse(429, "rate_limited", "the daily indexing limit has been reached; try again tomorrow");
  }
  if (ipCount >= ipCap) {
    return errorResponse(429, "rate_limited", `this address has reached its ${ipCap} indexes for today`);
  }
  await deps.storage.put(
    dayKey,
    JSON.stringify({ total: counter.total + 1, ips: { ...counter.ips, [ip]: ipCount + 1 } }),
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
    lastWrite: 0,
  };
  await writeJobStatus(ctx, { state: "running", phase: "queued" });
  deps.waitUntil(runWithWatchdog(ctx));
  return json(202, { state: "running", repo: name, sha });
}

/** GET /api/health: {ok, storage: "r2" | "fs"}. */
export function handleHealth(deps: { storage: Pick<Storage, "kind"> }): Response {
  return json(200, { ok: true, storage: deps.storage.kind });
}
