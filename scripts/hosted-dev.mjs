#!/usr/bin/env node
// Local end-to-end server for the hosted build. It serves apps/web/dist-hosted, runs /api/index, /api/status and /api/health
// through the same handlers the Vercel Function uses (packages/hosted), and keeps background jobs alive as waitUntil promises.
// The store is Workers KV when the Cloudflare KV variables are in the environment (CLOUDFLARE_API_TOKEN, R2_ACCOUNT_ID or
// CF_ACCOUNT_ID, CF_KV_NAMESPACE_ID): then the local run writes to the real namespace. Otherwise it is a local folder
// (INSIGHT_STORAGE_DIR), served at /storage/* with the headers each object's sidecar (<key>.meta.json) records. R2 variables
// are ignored here. Every storage write is logged as "storage write <key>".
//
//   pnpm -r build && pnpm --filter @insight/web build:hosted
//   INSIGHT_STORAGE_DIR=/path/to/storage node scripts/hosted-dev.mjs [--port 4330]
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDeps, handleHealth, handleIndex, handleStatus, observedStorage, storageFromEnv } from "../packages/hosted/dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const webDist = resolve(here, "../apps/web/dist-hosted");

function parseArgs(argv) {
  let port = 4330;
  let host = "127.0.0.1";
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--port") port = Number(argv[++i]);
    else if (argv[i] === "--host") host = argv[++i];
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`bad port ${port}`);
  return { port, host };
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

/** The request as a web Request, for the handlers. The body is read whole (the submissions are small). */
async function toWebRequest(req, origin) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) for (const v of value) headers.append(name, v);
    else if (value !== undefined) headers.set(name, value);
  }
  const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;
  return new Request(new URL(req.url ?? "/", origin), { method: req.method, headers, body: req.method === "GET" || req.method === "HEAD" ? undefined : body });
}

/** Writes a web Response to the node response. */
async function sendWebResponse(res, webRes, head = false) {
  const headers = {};
  webRes.headers.forEach((value, name) => {
    headers[name] = value;
  });
  res.writeHead(webRes.status, headers);
  if (head || webRes.body === null) return res.end();
  res.end(Buffer.from(await webRes.arrayBuffer()));
}

/** The file for a storage key under `dir`, or undefined when the key would leave the folder. */
function storageFile(dir, key) {
  const parts = key.split("/");
  if (parts.some((p) => p === "" || p === "." || p === "..")) return undefined;
  const file = join(dir, ...parts);
  return file.startsWith(dir + sep) ? file : undefined;
}

/** A stored object with its sidecar headers (the same ones the R2 bucket is given). */
async function serveStorage(req, res, dir, key, head) {
  const file = storageFile(dir, key);
  if (!file) return sendText(res, 400, "bad storage key");
  let body;
  let sidecar;
  try {
    body = await readFile(file);
    sidecar = JSON.parse(await readFile(`${file}.meta.json`, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return sendText(res, 404, "not found");
    throw err;
  }
  const headers = {
    "content-type": sidecar.contentType ?? "application/octet-stream",
    "cache-control": sidecar.cacheControl ?? "no-store",
    "content-length": String(body.length),
  };
  if (sidecar.contentEncoding) headers["content-encoding"] = sidecar.contentEncoding;
  res.writeHead(200, headers);
  res.end(head ? undefined : body);
}

function sendText(res, status, text) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
  res.end(text);
}

/** A file of the built web app, or index.html for a client-side route. */
async function serveWeb(res, pathname, head) {
  const safe = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, "");
  let file = join(webDist, safe);
  if (!file.startsWith(webDist + sep) && file !== webDist) return sendText(res, 400, "bad path");
  try {
    if ((await stat(file)).isDirectory()) file = join(file, "index.html");
  } catch {
    file = join(webDist, "index.html");
  }
  let body;
  try {
    body = await readFile(file);
  } catch {
    return sendText(res, 404, "the hosted build is missing: run pnpm --filter @insight/web build:hosted");
  }
  const type = MIME[extname(file)] ?? "application/octet-stream";
  const cache = file.includes(`${sep}assets${sep}`) ? "public, max-age=31536000, immutable" : "no-cache";
  res.writeHead(200, { "content-type": type, "cache-control": cache, "content-length": String(body.length) });
  res.end(head ? undefined : body);
}

export function startHostedDev({ port, host, env: given = process.env }) {
  const pending = new Set();
  const waitUntil = (promise) => {
    pending.add(promise);
    promise
      .catch((err) => console.error("background job failed:", err))
      .finally(() => pending.delete(promise));
  };
  // R2 variables from the shell are ignored so local runs never touch the bucket.
  const env = { ...given };
  for (const name of ["R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"]) delete env[name];
  if (!(env.CLOUDFLARE_API_TOKEN || env.CF_KV_NAMESPACE_ID)) delete env.R2_ACCOUNT_ID;
  const storage = observedStorage(storageFromEnv(env), (key) => console.log(`storage write ${key}`));
  const storageDir = storage.kind === "fs" ? resolve(env.INSIGHT_STORAGE_DIR) : undefined;
  const deps = buildDeps(env, { waitUntil, storage });
  const origin = `http://${host}:${port}`;

  const server = createServer(async (req, res) => {
    try {
      const { pathname } = new URL(req.url ?? "/", origin);
      const head = req.method === "HEAD";
      if (pathname === "/api/index") {
        const webRes = await handleIndex(await toWebRequest(req, origin), deps);
        return await sendWebResponse(res, webRes);
      }
      if (pathname === "/api/status") {
        return await sendWebResponse(res, await handleStatus(await toWebRequest(req, origin), { storage }));
      }
      if (pathname === "/api/health") {
        return await sendWebResponse(res, handleHealth({ storage }), head);
      }
      if (pathname.startsWith("/api/")) return sendText(res, 404, "not found");
      if (req.method !== "GET" && !head) return sendText(res, 405, "use GET");
      if (pathname.startsWith("/storage/")) {
        if (!storageDir) return sendText(res, 404, "not found: the store is KV, not a folder");
        return await serveStorage(req, res, storageDir, decodeURIComponent(pathname.slice("/storage/".length)), head);
      }
      return await serveWeb(res, pathname, head);
    } catch (err) {
      console.error(err);
      if (!res.headersSent) sendText(res, 500, String(err?.message ?? err));
      else res.end();
    }
  });
  return new Promise((resolvePromise) => {
    server.listen(port, host, () => resolvePromise({ server, pending, origin, storageKind: storage.kind }));
  });
}

async function main() {
  const { port, host } = parseArgs(process.argv.slice(2));
  if (!process.env.INSIGHT_STORAGE_DIR && !process.env.CF_KV_NAMESPACE_ID && !process.env.CLOUDFLARE_API_TOKEN) {
    console.error("set INSIGHT_STORAGE_DIR (a folder) or the Cloudflare KV variables (CLOUDFLARE_API_TOKEN, R2_ACCOUNT_ID, CF_KV_NAMESPACE_ID)");
    process.exit(2);
  }
  const { origin, storageKind } = await startHostedDev({ port, host, env: process.env });
  console.log(`hosted dev on ${origin} (storage ${storageKind}, web ${webDist})`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
