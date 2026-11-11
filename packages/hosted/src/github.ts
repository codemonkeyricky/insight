// GitHub access for the hosted indexer: input normalization, the repo's metadata and ref resolution (REST API), and the
// source download (codeload tarball, extracted with node-tar under explicit caps).
import { mkdir } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as tar from "tar";
import type { ReadEntry } from "tar";
import type { FetchLike } from "./storage.js";

export interface RepoRef {
  owner: string;
  repo: string;
  /** The branch, tag or sha given in the URL (/tree/<ref>), if any. */
  ref?: string;
}

/** The request is malformed (not a GitHub repo, a bad name). */
export class InputError extends Error {
  readonly code = "bad_request" as const;
}

const OWNER = /^[a-z0-9](?:[a-z0-9-]{0,38})$/;
const REPO = /^[a-z0-9._-]{1,100}$/;
const REF = /^[A-Za-z0-9._/-]{1,200}$/;

/**
 * Parses "owner/repo" or a github.com URL (optionally /tree/<ref>, with a trailing .git or slash). Names are lowercased
 * because GitHub's names are case-insensitive and the storage keys are lowercase.
 */
export function parseRepoInput(input: string): RepoRef {
  const text = input.trim();
  if (text === "") throw new InputError("empty repository");
  let owner: string | undefined;
  let repo: string | undefined;
  let ref: string | undefined;

  if (/^(https?:\/\/)?(www\.)?github\.com\//i.test(text)) {
    if (/^http:\/\//i.test(text)) throw new InputError("use an https:// GitHub URL");
    const url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
    if (url.search !== "" || url.hash !== "") throw new InputError("a GitHub URL may not have a query or fragment");
    const parts = url.pathname.split("/").filter((p) => p !== "");
    if (parts.length < 2) throw new InputError("expected github.com/<owner>/<repo>");
    [owner, repo] = parts as [string, string];
    repo = repo.replace(/\.git$/i, "");
    const rest = parts.slice(2);
    if (rest.length > 0) {
      if (rest[0] !== "tree" || rest.length < 2) throw new InputError("only /tree/<ref> may follow the repository");
      ref = rest.slice(1).join("/");
    }
  } else if (/^[^/\s:]+\/[^/\s:]+$/.test(text)) {
    [owner, repo] = text.split("/") as [string, string];
    repo = repo.replace(/\.git$/i, "");
  } else {
    throw new InputError("expected owner/repo or a https://github.com/ URL");
  }

  owner = owner.toLowerCase();
  repo = repo.toLowerCase();
  if (!OWNER.test(owner)) throw new InputError(`invalid owner: ${owner}`);
  if (!REPO.test(repo) || repo === "." || repo === "..") throw new InputError(`invalid repository name: ${repo}`);
  if (ref !== undefined) return { owner, repo, ref: checkRef(ref) };
  return { owner, repo };
}

/** A branch, tag or sha: letters, digits, ".", "_", "-" and "/", no empty or dot segments. Returns it unchanged. */
export function checkRef(ref: string): string {
  if (!REF.test(ref) || ref.split("/").some((seg) => seg === "" || seg === "." || seg === "..")) {
    throw new InputError(`invalid ref: ${ref}`);
  }
  return ref;
}

/** "owner/repo", lowercased: the public name of a hosted index. */
export function repoName(owner: string, repo: string): string {
  return `${owner}/${repo}`;
}

/** A GitHub lookup that found no usable repo (missing, private, or the ref does not exist). */
export class NotFoundError extends Error {
  readonly code = "not_found" as const;
}

/** GitHub refused or failed a lookup for a reason other than "not found". */
export class UpstreamError extends Error {
  readonly code = "upstream_error" as const;
}

export interface GithubOptions {
  fetch: FetchLike;
  token?: string;
}

export interface RepoInfo {
  default_branch: string;
  /** Size in KB, as GitHub reports it. */
  size: number;
  private: boolean;
}

function headers(opts: GithubOptions): Record<string, string> {
  const h: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "insight-indexer",
  };
  if (opts.token) h.Authorization = `Bearer ${opts.token}`;
  return h;
}

/** GET /repos/:o/:r. A missing or private repo (or one the token cannot see) is NotFoundError. */
export async function repoInfo(owner: string, repo: string, opts: GithubOptions): Promise<RepoInfo> {
  const res = await opts.fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers: headers(opts) });
  if (res.status === 404) throw new NotFoundError(`${repoName(owner, repo)} was not found on GitHub`);
  if (!res.ok) throw new UpstreamError(`GitHub answered ${res.status} for ${repoName(owner, repo)}`);
  const body = (await res.json()) as RepoInfo;
  if (body.private) throw new NotFoundError(`${repoName(owner, repo)} is private`);
  return body;
}

/** Resolves a branch, tag or sha to a full commit sha via GET /repos/:o/:r/commits/:ref. */
export async function resolveSha(owner: string, repo: string, ref: string, opts: GithubOptions): Promise<string> {
  const encoded = ref.split("/").map(encodeURIComponent).join("/");
  const res = await opts.fetch(`https://api.github.com/repos/${owner}/${repo}/commits/${encoded}`, {
    headers: headers(opts),
  });
  if (res.status === 404 || res.status === 422) throw new NotFoundError(`ref ${ref} was not found in ${repoName(owner, repo)}`);
  if (!res.ok) throw new UpstreamError(`GitHub answered ${res.status} for ref ${ref}`);
  const body = (await res.json()) as { sha?: string };
  if (typeof body.sha !== "string" || !/^[0-9a-f]{40}$/.test(body.sha)) throw new UpstreamError(`no commit for ${ref}`);
  return body.sha;
}

export interface ExtractLimits {
  /** Most regular files the archive may contain. Over this the extraction fails with ArchiveLimitError. */
  maxFiles: number;
  /** A regular file larger than this is skipped (not written). */
  maxFileBytes: number;
  /** Most bytes, summed over the written files. Over this the extraction fails with ArchiveLimitError. */
  maxTotalBytes: number;
}

export interface ExtractResult {
  files: number;
  bytes: number;
  skipped: number;
}

/** The archive is over a cap (too many files or bytes). */
export class ArchiveLimitError extends Error {
  readonly code = "too_large" as const;
}

/**
 * Downloads https://codeload.github.com/<o>/<r>/tar.gz/<sha> and extracts it into `dir`, stripping the archive's top
 * folder. Symlinks, hardlinks and devices are skipped. Files over maxFileBytes are skipped; a count or byte total over
 * the cap fails with ArchiveLimitError.
 */
export async function downloadAndExtract(
  owner: string,
  repo: string,
  sha: string,
  dir: string,
  limits: ExtractLimits,
  fetchFn: FetchLike,
): Promise<ExtractResult> {
  const res = await fetchFn(`https://codeload.github.com/${owner}/${repo}/tar.gz/${sha}`, {
    headers: { "User-Agent": "insight-indexer" },
  });
  if (res.status === 404) throw new NotFoundError(`${repoName(owner, repo)} at ${sha} was not found`);
  if (!res.ok || res.body === null) throw new UpstreamError(`codeload answered ${res.status}`);

  await mkdir(dir, { recursive: true });
  const result: ExtractResult = { files: 0, bytes: 0, skipped: 0 };
  let limitMessage: string | undefined;
  const unpack = tar.x({
    cwd: dir,
    strip: 1,
    preservePaths: false,
    filter: (_path, stat) => {
      const entry = stat as ReadEntry;
      if (entry.type === "Directory") return true;
      if (entry.type !== "File") {
        result.skipped += 1;
        return false;
      }
      if (entry.size > limits.maxFileBytes) {
        result.skipped += 1;
        return false;
      }
      if (result.files + 1 > limits.maxFiles) {
        limitMessage = `repository has more than ${limits.maxFiles} files`;
        return false;
      }
      if (result.bytes + entry.size > limits.maxTotalBytes) {
        limitMessage = `repository is over ${limits.maxTotalBytes} bytes of source`;
        return false;
      }
      result.files += 1;
      result.bytes += entry.size;
      return true;
    },
  });
  await pipeline(Readable.fromWeb(res.body as never), unpack);
  if (limitMessage !== undefined) throw new ArchiveLimitError(limitMessage);
  return result;
}
