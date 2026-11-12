// The Vercel Function entry: one function serves every hosted route. POST /api/index starts an index job (the job runs in
// waitUntil, so the response returns at once with 202 and the function runs until the job finishes or the watchdog fires),
// GET /api/status reads a run's status, GET /api/health reports the storage kind, /api/auth/* is the GitHub sign-in, and
// /api/private/* reads private indexes. The route comes from the `route` query parameter (set by the rewrites in config.json)
// or, failing that, from the path.
import { waitUntil } from "@vercel/functions";
import { handleCallback, handleLogin, handleLogout, handleMe } from "./auth.js";
import { buildDeps, storageFromEnv } from "./env.js";
import { handleHealth, handleIndex, handleStatus } from "./indexer.js";
import { handleGrant, handleLatest, handleRepos, handleSource } from "./private.js";
import type { FetchLike } from "./storage.js";

export type Route =
  | "index"
  | "status"
  | "health"
  | "auth-login"
  | "auth-callback"
  | "auth-logout"
  | "auth-me"
  | "private-grant"
  | "private-source"
  | "private-latest"
  | "private-repos";

const ROUTE_NAMES: readonly Route[] = [
  "index",
  "status",
  "health",
  "auth-login",
  "auth-callback",
  "auth-logout",
  "auth-me",
  "private-grant",
  "private-source",
  "private-latest",
  "private-repos",
];
const PATHS: Record<string, Route> = {
  "/api/index": "index",
  "/api/status": "status",
  "/api/health": "health",
  "/api/auth/login": "auth-login",
  "/api/auth/callback": "auth-callback",
  "/api/auth/logout": "auth-logout",
  "/api/auth/me": "auth-me",
  "/api/private/grant": "private-grant",
  "/api/private/source": "private-source",
  "/api/private/latest": "private-latest",
  "/api/private/repos": "private-repos",
};

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
  const env = process.env;
  const fetchFn: FetchLike = (input, init) => fetch(input, init);
  try {
    switch (route) {
      case "index":
        return await handleIndex(request, buildDeps(env, { waitUntil }));
      case "status":
        return await handleStatus(request, { storage: storageFromEnv(env), env, fetch: fetchFn });
      case "health":
        return handleHealth({ storage: storageFromEnv(env) });
      case "auth-login":
        return await handleLogin(request, env);
      case "auth-callback":
        return await handleCallback(request, env, fetchFn);
      case "auth-logout":
        return await handleLogout(request, env, fetchFn);
      case "auth-me":
        return await handleMe(request, env, fetchFn);
      case "private-grant":
        return await handleGrant(request, { env, fetch: fetchFn, now: () => Date.now() });
      case "private-source":
        return await handleSource(request, { env, fetch: fetchFn, now: () => Date.now() });
      case "private-latest":
        return await handleLatest(request, { env, fetch: fetchFn, now: () => Date.now(), storage: storageFromEnv(env) });
      case "private-repos":
        return await handleRepos(request, { env, fetch: fetchFn, now: () => Date.now() });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: { code: "index_failed", message } }, { status: 500 });
  }
}
