// Hosted mode's repository names: what the home page accepts as "owner/repo" or a GitHub link, the hash links to an
// index, the messages for an index that failed, and a relative time for the recent list. Pure, so the tests need no DOM.

export type RepoInput = { ok: true; owner: string; repo: string } | { ok: false; error: string };

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
  if (parts.length > 2 && parts[2] === "tree") return { ok: false, error: "Paste the repository's link, not a branch or folder link." };
  if (parts.length !== 2) return { ok: false, error: "Use owner/repo or https://github.com/owner/repo." };
  const owner = (parts[0] ?? "").toLowerCase();
  const repo = (parts[1] ?? "").replace(/\.git$/i, "").toLowerCase();
  if (owner === "" || owner.length > 39 || !OWNER.test(owner)) return { ok: false, error: `"${parts[0] ?? ""}" is not a GitHub account name.` };
  if (!REPO.test(repo) || repo === "." || repo === "..") return { ok: false, error: `"${parts[1] ?? ""}" is not a valid repository name.` };
  return { ok: true, owner, repo };
}

/** The hash link to an index: the latest one of a repository, or the one at a commit. */
export function hrefHosted(owner: string, repo: string, sha?: string): string {
  return `#/gh/${owner}/${repo}${sha ? `@${sha}` : ""}`;
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
export function indexErrorText(code: string, repo: string, fallback?: string): string {
  switch (code) {
    case "not_found":
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
