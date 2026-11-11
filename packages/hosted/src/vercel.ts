// The Vercel Function entry: one function serves three routes. POST /api/index starts an index job (the job runs in
// waitUntil, so the response returns at once with 202 and the function runs until the job finishes or the watchdog fires),
// GET /api/status reads a run's status, GET /api/health reports the storage kind. The route comes from the `route` query
// parameter (set by the rewrites in config.json) or, failing that, from the path.
import { waitUntil } from "@vercel/functions";
import { buildDeps, storageFromEnv } from "./env.js";
import { handleHealth, handleIndex, handleStatus } from "./indexer.js";

export type Route = "index" | "status" | "health";

const ROUTE_NAMES: readonly Route[] = ["index", "status", "health"];
const PATHS: Record<string, Route> = { "/api/index": "index", "/api/status": "status", "/api/health": "health" };

/** The route a request addresses: its `route` parameter when present, else its path. */
export function routeOf(url: URL): Route | undefined {
  const named = url.searchParams.get("route");
  if (named !== null) return (ROUTE_NAMES as readonly string[]).includes(named) ? (named as Route) : undefined;
  return PATHS[url.pathname];
}

/** Runs the route's handler. Unknown routes answer 404; an unexpected failure answers 500 with a coded error. */
export async function handleRequest(request: Request): Promise<Response> {
  const route = routeOf(new URL(request.url));
  if (route === undefined) return Response.json({ error: { code: "not_found", message: "no such route" } }, { status: 404 });
  try {
    if (route === "index") return await handleIndex(request, buildDeps(process.env, { waitUntil }));
    if (route === "status") return await handleStatus(request, { storage: storageFromEnv(process.env) });
    return handleHealth({ storage: storageFromEnv(process.env) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: { code: "index_failed", message } }, { status: 500 });
  }
}
