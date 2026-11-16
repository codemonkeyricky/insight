// GET /api/coupling?repo=owner/repo&sha=<40 hex>[&scope=<file|folder>][&fn=<function id>][&visibility=private]:
// the coupling footprint of an indexed project, in the same JSON the local server's /api/projects/:id/coupling answers
// and the CLI's `insight coupling --json` prints. The index's graph.json holds the full IR (the export writes it). The
// built index, and the file list a scope is checked against, are cached per repo+sha+visibility, so a repeat request
// never downloads or parses the graph again. A private run needs a signed-in user who can read the repo, like
// GET /api/status.
import {
  couplingIndex,
  couplingReport,
  normalizeScopeInput,
  ScopeInputError,
  type CouplingIndex,
  type CouplingReport,
} from "@insight/flow";
import { errorResponse, json, withCookies } from "./http.js";
import { parseRepoInput } from "./github.js";
import { repoStoragePrefix, type Visibility } from "./private.js";
import { requireAccess, type Clock, type Env } from "./auth.js";
import type { FetchLike, Storage } from "./storage.js";

/** The shape the export's graph.json has: every node and edge of the snapshot. */
interface Graph {
  snapshot?: string;
  nodes: Parameters<typeof couplingIndex>[0];
  edges: Parameters<typeof couplingIndex>[1];
}

/** What a cached commit keeps: its coupling index and the indexed files a scope is checked against. */
interface CachedIndex {
  index: CouplingIndex;
  files: ReadonlySet<string>;
}

/**
 * The indexes kept per Function instance, keyed by the storage key (repo, sha and visibility). Each one is a whole
 * project's footprints, so the bound is small: the last two commits served, evicted in insertion order. On the 2 GB
 * Function that leaves ample headroom for a request's own graph parse when it misses.
 */
const CACHE_LIMIT = 2;
const cache = new Map<string, CachedIndex>();

/** The indexed files of a graph: what names a file or folder scope. */
function filesOf(graph: Graph): Set<string> {
  const files = new Set<string>();
  for (const n of graph.nodes) if (n.kind === "structure.file") files.add(String(n.attrs.path ?? n.id));
  return files;
}

function cachedIndex(key: string, graph: Graph): CachedIndex {
  const hit = cache.get(key);
  if (hit) return hit;
  const built: CachedIndex = { index: couplingIndex(graph.nodes, graph.edges), files: filesOf(graph) };
  cache.set(key, built);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
  return built;
}

/** True when an indexed file is the scope or lies under it. */
function knownScope(files: ReadonlySet<string>, scope: string): boolean {
  for (const file of files) if (file === scope || file.startsWith(`${scope}/`)) return true;
  return false;
}

export interface CouplingDeps {
  storage: Storage;
  env?: Env;
  fetch?: FetchLike;
  now?: Clock;
}

/** GET /api/coupling. */
export async function handleCoupling(request: Request, deps: CouplingDeps): Promise<Response> {
  if (request.method !== "GET") return errorResponse(405, "method_not_allowed", "use GET");
  const url = new URL(request.url);
  let parsed;
  try {
    parsed = parseRepoInput(url.searchParams.get("repo") ?? "");
  } catch {
    return errorResponse(400, "bad_request", "repo must be owner/repo");
  }
  if (parsed.ref !== undefined) return errorResponse(400, "bad_request", "repo must be owner/repo");
  const sha = url.searchParams.get("sha") ?? "";
  if (!/^[0-9a-f]{40}$/.test(sha)) return errorResponse(400, "bad_request", "sha must be a 40-character commit id");
  const visibilityParam = url.searchParams.get("visibility");
  if (visibilityParam !== null && visibilityParam !== "public" && visibilityParam !== "private") {
    return errorResponse(400, "bad_request", "visibility must be public or private");
  }
  const visibility: Visibility = visibilityParam === "private" ? "private" : "public";
  const fn = url.searchParams.get("fn") ?? undefined;
  // Normalize the scope before anything else, even when fn= is given: the local server rejects the same paths.
  let scope: string;
  try {
    scope = normalizeScopeInput(url.searchParams.get("scope") ?? "");
  } catch (err) {
    if (err instanceof ScopeInputError) return errorResponse(400, "bad_request", err.message);
    throw err;
  }
  const key = `${repoStoragePrefix(parsed.owner, parsed.repo, sha, visibility)}graph.json`;

  let setCookie: string | undefined;
  if (visibility === "private") {
    const fetchFn: FetchLike = deps.fetch ?? ((input, init) => fetch(input, init));
    const session = await requireAccess(request, deps.env ?? {}, fetchFn, parsed.owner, parsed.repo, deps.now);
    if (session instanceof Response) return session;
    setCookie = session.setCookie;
  }

  let cached = cache.get(key);
  if (cached === undefined) {
    const graph = await deps.storage.getJson<Graph>(key);
    if (graph === undefined) {
      const answer = errorResponse(404, "not_found", "no index for this commit");
      return setCookie === undefined ? answer : withCookies(answer, setCookie);
    }
    cached = cachedIndex(key, graph);
  }

  let report: CouplingReport;
  if (fn !== undefined) {
    if (!cached.index.functions.has(fn)) return answerWithCookies(errorResponse(404, "not_found", `no function ${fn}`), setCookie);
    report = couplingReport(cached.index, { ids: [fn] });
  } else if (scope !== "") {
    // A file or folder is a scope only when an indexed file names it or lies under it, as the local server decides it.
    if (!knownScope(cached.files, scope)) return answerWithCookies(errorResponse(404, "not_found", "no such scope"), setCookie);
    report = couplingReport(cached.index, { scope });
  } else {
    report = couplingReport(cached.index);
  }
  const answer = json(200, report);
  return setCookie === undefined ? answer : withCookies(answer, setCookie);
}

function answerWithCookies(answer: Response, setCookie: string | undefined): Response {
  return setCookie === undefined ? answer : withCookies(answer, setCookie);
}
