// The Node entry of the Vercel Function (launcherType "Nodejs"): a default export of (req, res). It turns the node request
// into a web Request, runs the route handler of vercel.ts, and writes the web Response back.
//
// waitUntil: @vercel/functions registers background work with the runtime's request context, which the Node launcher
// only provides when helpers are added (the bundle sets shouldAddHelpers false). So this entry installs that context
// itself: waitUntil promises are collected, the response is sent at once (202 for a submission), and the invocation stays
// open until the collected jobs settle. The jobs are bounded by the watchdog (270 s) and the function's maxDuration (300 s).
import type { IncomingMessage, ServerResponse } from "node:http";
import { handleRequest } from "./vercel.js";

const REQUEST_CONTEXT = Symbol.for("@vercel/request-context");
const jobs = new Set<Promise<unknown>>();

/** Installs the request context that @vercel/functions reads, once per process. Background promises go to `jobs`. */
function installContext(): void {
  const global = globalThis as unknown as Record<symbol, unknown>;
  if (global[REQUEST_CONTEXT] !== undefined) return;
  global[REQUEST_CONTEXT] = {
    get: () => ({
      waitUntil: (promise: Promise<unknown>) => {
        const tracked = promise.catch(() => undefined).finally(() => jobs.delete(tracked));
        jobs.add(tracked);
      },
    }),
  };
}

/** Used when the request names no host (never on Vercel, where the host header is always sent). */
const FALLBACK_ORIGIN = "https://insight.vercel.app";

function firstValue(value: string | string[] | undefined): string | undefined {
  const text = Array.isArray(value) ? value[0] : value;
  const first = text?.split(",")[0]?.trim();
  return first ? first : undefined;
}

/** The origin the client used: x-forwarded-proto and x-forwarded-host (Vercel's), else the host header. */
export function requestOrigin(req: IncomingMessage): string {
  const host = firstValue(req.headers["x-forwarded-host"]) ?? firstValue(req.headers.host);
  if (host === undefined) return FALLBACK_ORIGIN;
  const loopback = /^(localhost|127\.0\.0\.1)(:|$)/.test(host);
  const proto = firstValue(req.headers["x-forwarded-proto"]) ?? (loopback ? "http" : "https");
  return `${proto}://${host}`;
}

/** The node request as a web Request on the function's own origin. The body is read whole (submissions are small). */
export async function toWebRequest(req: IncomingMessage): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) for (const v of value) headers.append(name, v);
    else if (value !== undefined) headers.set(name, value);
  }
  const method = req.method ?? "GET";
  const body = method === "GET" || method === "HEAD" || chunks.length === 0 ? undefined : Buffer.concat(chunks);
  return new Request(new URL(req.url ?? "/", requestOrigin(req)), { method, headers, body });
}

/**
 * Writes a web Response to the node response, status and headers included. Set-Cookie is written as a list, one line per
 * cookie: a headers object would merge them, and the browser would keep only one.
 */
export async function sendWebResponse(res: ServerResponse, webRes: Response): Promise<void> {
  const headers: Record<string, string> = {};
  webRes.headers.forEach((value, name) => {
    if (name !== "set-cookie") headers[name] = value;
  });
  const cookies = webRes.headers.getSetCookie();
  if (cookies.length > 0) res.setHeader("set-cookie", cookies);
  res.writeHead(webRes.status, headers);
  if (webRes.body === null) {
    res.end();
    return;
  }
  res.end(Buffer.from(await webRes.arrayBuffer()));
}

/** The default export of the function: every route (see vercel.ts), answered from the request's route parameter or path. */
export function nodeHandler(): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    installContext();
    try {
      await sendWebResponse(res, await handleRequest(await toWebRequest(req)));
    } catch (err) {
      if (!res.headersSent) {
        const message = err instanceof Error ? err.message : String(err);
        res.writeHead(500, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ error: { code: "index_failed", message } }));
      } else {
        res.end();
      }
    }
    // The response is out; keep the invocation alive while background work (the index job) runs.
    await Promise.allSettled([...jobs]);
  };
}
