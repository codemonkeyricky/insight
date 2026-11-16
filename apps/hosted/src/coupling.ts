// GET /api/coupling?repo=owner/repo&sha=<40 hex>[&scope=<file|folder>][&fn=<function id>][&visibility=private]:
// the coupling footprint of an indexed project, in the same JSON the local server's /api/projects/:id/coupling answers
// and the CLI's `insight coupling --json` prints. The index's graph.json holds the full IR (the export writes it), so the
// index is built here per request and kept for a few commits. A private run needs a signed-in user who can read the repo,
// like GET /api/status.
import { couplingIndex, couplingReport, type CouplingReport } from "@insight/flow";
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

/** The coupling indexes kept per Function instance. Each one is a whole project, so the bound is small. */
const CACHE_LIMIT = 4;
const cache = new Map<string, ReturnType<typeof couplingIndex>>();

function indexOf(key: string, graph: Graph): ReturnType<typeof couplingIndex> {
  const hit = cache.get(key);
  if (hit) return hit;
  const index = couplingIndex(graph.nodes, graph.edges);
  cache.set(key, index);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
  return index;
}

/** The scope path normalized as the server's scope routes do it: no empty or `.` segments; `""` is the project. */
function normalizeScope(scope: string): string {
  return scope
    .replace(/\\/g, "/")
    .split("/")
    .filter((part) => part !== "" && part !== ".")
    .join("/");
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
  const rawScope = url.searchParams.get("scope") ?? "";
  if (rawScope.replace(/\\/g, "/").split("/").includes("..")) {
    return errorResponse(400, "bad_request", "scope must not leave the project");
  }
  const scope = normalizeScope(rawScope);
  const key = `${repoStoragePrefix(parsed.owner, parsed.repo, sha, visibility)}graph.json`;

  let setCookie: string | undefined;
  if (visibility === "private") {
    const fetchFn: FetchLike = deps.fetch ?? ((input, init) => fetch(input, init));
    const session = await requireAccess(request, deps.env ?? {}, fetchFn, parsed.owner, parsed.repo, deps.now);
    if (session instanceof Response) return session;
    setCookie = session.setCookie;
  }

  const graph = await deps.storage.getJson<Graph>(key);
  if (graph === undefined) {
    const answer = errorResponse(404, "not_found", "no index for this commit");
    return setCookie === undefined ? answer : withCookies(answer, setCookie);
  }

  const index = indexOf(key, graph);
  let report: CouplingReport;
  if (fn !== undefined) {
    if (!index.functions.has(fn)) return answerWithCookies(errorResponse(404, "not_found", `no function ${fn}`), setCookie);
    report = couplingReport(index, { ids: [fn] });
  } else if (scope !== "") {
    // A file or folder is a scope only when an indexed file names it or lies under it, as the local server decides it.
    const known = graph.nodes.some((n) => {
      if (n.kind !== "structure.file") return false;
      const path = String(n.attrs.path ?? n.id);
      return path === scope || path.startsWith(`${scope}/`);
    });
    if (!known) return answerWithCookies(errorResponse(404, "not_found", "no such scope"), setCookie);
    report = couplingReport(index, { scope });
  } else {
    report = couplingReport(index);
  }
  const answer = json(200, report);
  return setCookie === undefined ? answer : withCookies(answer, setCookie);
}

function answerWithCookies(answer: Response, setCookie: string | undefined): Response {
  return setCookie === undefined ? answer : withCookies(answer, setCookie);
}
