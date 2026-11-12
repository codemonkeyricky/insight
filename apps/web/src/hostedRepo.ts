// Hosted mode's repository names: what the home page accepts as "owner/repo" or a GitHub link, the hash links to an
// index, the messages for an index that failed, and a relative time for the recent list. Pure, so the tests need no DOM.

export type RepoInput = { ok: true; owner: string; repo: string; ref?: string } | { ok: false; error: string };

const SHA40 = /^[0-9a-f]{40}$/;
// A branch, tag or sha as the server accepts it (checkRef): letters, digits, ".", "_", "-" and "/", no empty or dot segments.
const REF = /^[A-Za-z0-9._\-/]+$/;

/** True when `ref` is a git ref the server accepts (see checkRef in packages/hosted). */
export function isRefName(ref: string): boolean {
  return REF.test(ref) && !ref.split("/").some((seg) => seg === "" || seg === "." || seg === "..");
}

// GitHub account names: letters, digits and single hyphens, no leading or trailing hyphen, at most 39 characters.
const OWNER = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// Repository names: letters, digits, dots, hyphens and underscores. "." and ".." are not names.
const REPO = /^[a-z0-9._-]{1,100}$/;

/** True when `owner` and `repo` are a name GitHub can have, in the lowercase form the storage uses. */
export function isRepoName(owner: string, repo: string): boolean {
  return owner.length <= 39 && OWNER.test(owner) && REPO.test(repo) && repo !== "." && repo !== "..";
}

/**
 * Reads what the user typed: `owner/repo`, `github.com/owner/repo`, or `https://github.com/owner/repo` with an optional
 * `.git` and trailing slash. Names come back lowercased. A branch or folder link is refused, since the hosted index is
 * of a commit the server picks, and a link to another host is refused too.
 */
export function parseRepoInput(text: string): RepoInput {
  const raw = text.trim();
  if (raw === "") return { ok: false, error: "Enter a GitHub repository, like owner/repo or https://github.com/owner/repo." };
  const link = /^(?:https?:\/\/)?(?:www\.)?github\.com\/(.*)$/i.exec(raw);
  if (!link && /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return { ok: false, error: "Only GitHub repositories can be indexed here." };
  const path = (link ? (link[1] ?? "") : raw).replace(/[?#].*$/, "").replace(/\/+$/, "");
  const parts = path.split("/");
  let ref: string | undefined;
  if (parts.length > 3 && parts[2] === "tree") {
    // A branch link: the ref is the first segment after "tree" (a folder path after it cannot be told from a slash branch;
    // write owner/repo@a/b for that).
    ref = parts[3];
    parts.length = 2;
  } else if (parts.length === 3 && parts[2] === "tree") {
    return { ok: false, error: "Add the branch after /tree/, or paste the repository's link." };
  } else if (parts.length > 2 && parts[1]?.includes("@")) {
    // owner/repo@a/b: everything after the "@" is the ref.
    const first = (parts[1] ?? "").split("@");
    ref = [first.slice(1).join("@"), ...parts.slice(2)].join("/");
    parts.length = 2;
    parts[1] = first[0] ?? "";
  } else if (parts.length === 2 && parts[1]?.includes("@")) {
    const at = (parts[1] ?? "").indexOf("@");
    ref = (parts[1] ?? "").slice(at + 1);
    parts[1] = (parts[1] ?? "").slice(0, at);
  }
  if (ref !== undefined) {
    try {
      ref = decodeURIComponent(ref);
    } catch {
      return { ok: false, error: `"${ref}" is not a valid branch name.` };
    }
    if (!isRefName(ref)) return { ok: false, error: `"${ref}" is not a valid branch name.` };
  }
  if (parts.length !== 2) return { ok: false, error: "Use owner/repo, owner/repo@branch or https://github.com/owner/repo." };
  const owner = (parts[0] ?? "").toLowerCase();
  const repo = (parts[1] ?? "").replace(/\.git$/i, "").toLowerCase();
  if (owner === "" || owner.length > 39 || !OWNER.test(owner)) return { ok: false, error: `"${parts[0] ?? ""}" is not a GitHub account name.` };
  if (!REPO.test(repo) || repo === "." || repo === "..") return { ok: false, error: `"${parts[1] ?? ""}" is not a valid repository name.` };
  return { ok: true, owner, repo, ...(ref !== undefined ? { ref } : {}) };
}

/**
 * The hash link to an index: the latest one of a repository, the one at a commit, or (with `ref`) the latest of a branch.
 * A branch is percent-encoded, so "build/x" is `@build%2Fx`; a 40-hex ref is the commit form.
 */
export function hrefHosted(owner: string, repo: string, sha?: string, ref?: string): string {
  const base = `#/gh/${owner}/${repo}`;
  if (sha) return `${base}@${sha}`;
  if (ref === undefined || ref === "") return base;
  return SHA40.test(ref) ? `${base}@${ref}` : `${base}@${encodeURIComponent(ref)}`;
}

/** What a run's phase is called on the page. The names are the ones the hosted job and the core pipeline write to status.json. */
const PHASE_LABELS: Record<string, string> = {
  queued: "Queued",
  download: "Downloading the source",
  fetch: "Downloading the source",
  extract: "Unpacking the source",
  scan: "Scanning files",
  link: "Linking the code",
  analyze: "Analyzing the code",
  index: "Indexing the code",
  export: "Indexing the code",
  upload: "Saving the index",
  save: "Saving the index",
};

/** The label of a run's phase. A phase the page does not know is shown as the server named it, and no phase is "Starting". */
export function phaseLabel(phase: string | undefined): string {
  if (!phase) return "Starting";
  return PHASE_LABELS[phase] ?? phase;
}

/** What the user reads when an index did not finish, by the error code the server or the page gave. */
export function indexErrorText(code: string, repo: string, fallback?: string, branch?: string): string {
  switch (code) {
    case "not_found":
      // The server words a missing ref "ref <name> was not found in <repo>".
      if (branch !== undefined && /^ref /.test(fallback ?? "")) return `Branch not found on GitHub: ${branch} (in ${repo}).`;
      return `No public GitHub repository named ${repo}. Check the spelling. A private one needs sign-in and the Insight app installed on it.`;
    case "auth_required":
      return `${repo} is private. Sign in with GitHub to index it.`;
    case "too_large":
      return `${repo} is too large to index on the free hosted tier.`;
    case "rate_limited":
      return "Too many indexing requests right now. Try again in a little while.";
    case "bad_request":
      return "That is not a GitHub repository this page can index.";
    case "upstream_error":
      return "GitHub did not answer the request. Try again in a little while.";
    case "timeout":
      return `Indexing ${repo} took longer than the time limit and was stopped.`;
    case "network":
      return "Could not reach the indexing service. Check your connection and try again.";
    default:
      return fallback ?? `Indexing ${repo} failed on the server.`;
  }
}

/** The code of a failed sign-in, from the `auth_error=<code>` query of the hash the callback returns to, or undefined. */
export function authErrorOf(hash: string): string | undefined {
  const at = hash.indexOf("?");
  if (at === -1) return undefined;
  const code = new URLSearchParams(hash.slice(at + 1)).get("auth_error");
  return code !== null && /^[a-z_]{1,40}$/i.test(code) ? code : undefined;
}

/** Whether a failed index can be asked for again from the page. Other failures are kept for an hour on the server. */
export function canRetry(code: string): boolean {
  return code === "rate_limited" || code === "network";
}

/** "3 days ago", "in 2 hours": a time as a phrase relative to `now` (both in milliseconds since the epoch). */
export function relativeTime(iso: string, now: number): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const seconds = Math.round((t - now) / 1000);
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["year", 365 * 86400],
    ["month", 30 * 86400],
    ["week", 7 * 86400],
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
  ];
  const format = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit);
  }
  return "just now";
}

/** A repository named by a page path: `/owner/repo`. `scope` is reserved for a folder or file; v1 never sets it. */
export type RepoPath = { owner: string; repo: string; scope?: string; ref?: string };

/** First path segments that belong to the app or the server, never to a GitHub account. */
const RESERVED_FIRST = new Set(["api", "assets", "storage", "index.html"]);

/**
 * Reads a repository from a page path, for the links `/owner/repo`, `/github.com/owner/repo` and
 * `/https://github.com/owner/repo` (browsers may collapse the `//`). A `/tree/<ref>[/path]` or `/blob/<ref>[/path]` tail is
 * accepted and its ref and path are ignored: v1 opens the default branch. Anything else under the repository, and any
 * other path, is null. Names come back lowercased and checked like `isRepoName`.
 */
export function parseRepoPath(pathname: string): RepoPath | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const parts = decoded.split("/").filter((p) => p !== "");
  if (parts.length === 0) return null;
  const first = (parts[0] ?? "").toLowerCase();
  if (RESERVED_FIRST.has(first)) return null;
  if (/^https?:$/i.test(parts[0] ?? "")) parts.shift();
  if (/^(?:www\.)?github\.com$/i.test(parts[0] ?? "")) parts.shift();
  const owner = (parts[0] ?? "").toLowerCase();
  let repoPart = parts[1] ?? "";
  // /owner/repo@<ref>: the ref is everything after the "@" (it may hold slashes).
  const at = repoPart.indexOf("@");
  if (at !== -1) {
    const ref = [repoPart.slice(at + 1), ...parts.slice(2)].join("/");
    repoPart = repoPart.slice(0, at);
    const repoName = repoPart.replace(/\.git$/i, "").toLowerCase();
    if (parts.length < 2 || !isRepoName(owner, repoName) || !isRefName(ref)) return null;
    return { owner, repo: repoName, ref };
  }
  const repo = repoPart.replace(/\.git$/i, "").toLowerCase();
  if (parts.length < 2 || !isRepoName(owner, repo)) return null;
  const rest = parts.slice(2);
  if (rest.length === 0) return { owner, repo };
  // A tree or blob link needs its ref: the first segment after it (a folder path after it cannot be told from a slash
  // branch; use /owner/repo@a/b for that). A blob ref is ignored, as in v1.
  if (rest[0] === "tree" && rest.length >= 2) {
    const ref = rest[1] as string;
    return isRefName(ref) ? { owner, repo, ref } : { owner, repo };
  }
  if (rest[0] === "blob" && rest.length >= 2) return { owner, repo };
  return null;
}

/**
 * The URL the hosted build should show for a page path, or undefined when the path names no repository. With no hash
 * route, the repository's hash route; with one, the path is dropped and the hash kept (so `/#/projects/...` still opens).
 * `hash` is `location.hash`, `pathname` is `location.pathname`.
 */
export function hashForRepoPath(pathname: string, hash: string): string | undefined {
  const repo = parseRepoPath(pathname);
  if (!repo) return undefined;
  const route = hash.replace(/^#\/?/, "");
  if (route !== "") return `/${hash}`;
  return `/${hrefHosted(repo.owner, repo.repo, undefined, repo.ref)}`;
}

/** Fired on window when the workspace has re-indexed the branch the page is already showing: the page reloads its pointer. */
export const REINDEXED_EVENT = "insight:reindexed";

/** "3 min", "5 h": a wait in seconds as a short phrase. */
export function waitText(seconds: number): string {
  if (seconds < 90) return `${Math.max(1, Math.round(seconds))} s`;
  const min = Math.round(seconds / 60);
  if (min < 90) return `${min} min`;
  return `${Math.round(min / 60)} h`;
}

/** What the re-index control says for a rate limit: the server's message, and the wait when the server gave one. */
export function rateLimitText(message: string, retryAfterSeconds?: number): string {
  return retryAfterSeconds === undefined ? message : `${message}. Resets in about ${waitText(retryAfterSeconds)}.`;
}
