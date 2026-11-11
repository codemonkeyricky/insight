// Read-only public view of the Insight KV namespace. Keys are paths like gh/<owner>/<repo>/<sha>/model.json.
//
// Private indexes live under private/ and are served only with a signature. A signed path is
//   /p/<exp>/<sig>/<key>
// where exp is unix seconds, sig = base64url(HMAC-SHA256(STORAGE_SIGNING_KEY, `${exp}:${prefix}`)) and prefix is the key's
// first five segments plus "/" (private/gh/<owner>/<repo>/<sha>/). The API (api/private/grant) issues these for 12 hours.
// With no STORAGE_SIGNING_KEY secret, every private/ and /p/ request answers 404.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Expose-Headers": "ETag, Content-Encoding, Content-Length",
};
const SIGNED_CACHE = "private, max-age=3600";
const encoder = new TextEncoder();

function notFound() {
  return new Response("not found", { status: 404, headers: { ...CORS, "Cache-Control": "no-store" } });
}

/** The HMAC key from the secret (base64 of 32 bytes), or undefined when it is missing or malformed. */
async function signingKey(env) {
  if (!env.STORAGE_SIGNING_KEY) return undefined;
  let raw;
  try {
    raw = Uint8Array.from(atob(env.STORAGE_SIGNING_KEY.trim()), (c) => c.charCodeAt(0));
  } catch {
    return undefined;
  }
  if (raw.length !== 32) return undefined;
  return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

function base64url(bytes) {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Equality of two strings in time that depends only on their lengths. */
function sameText(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** True when the signed path (exp, sig, and the key that follows) is current, and its signature is the key's prefix. */
async function validSignature(env, exp, sig, key) {
  const hmacKey = await signingKey(env);
  if (!hmacKey) return false;
  if (!/^\d+$/.test(exp) || Number(exp) < Math.floor(Date.now() / 1000)) return false;
  if (key.includes("..")) return false;
  const prefix = key.split("/").slice(0, 5).join("/") + "/";
  if (!key.startsWith(prefix)) return false;
  const mac = await crypto.subtle.sign("HMAC", hmacKey, encoder.encode(`${exp}:${prefix}`));
  return sameText(base64url(new Uint8Array(mac)), sig);
}

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: { ...CORS, "Access-Control-Allow-Headers": "*", "Access-Control-Max-Age": "3600" } });
    }
    if (req.method !== "GET" && req.method !== "HEAD") return new Response("method not allowed", { status: 405, headers: CORS });
    const path = decodeURIComponent(new URL(req.url).pathname.slice(1));
    let key = path;
    let signed = false;
    if (path === "p" || path.startsWith("p/")) {
      const match = /^p\/(\d+)\/([A-Za-z0-9_-]+)\/(.+)$/.exec(path);
      if (!match) return notFound();
      const [, exp, sig, rest] = match;
      if (!(await validSignature(env, exp, sig, rest))) return notFound();
      key = rest;
      signed = true;
    }
    if (!key || key.includes("..")) return notFound();
    // Private keys are served only through a valid signature.
    if (!signed && key.startsWith("private/")) return notFound();
    // Export files under a full sha never change, so the edge may keep them long; everything else stays fresh.
    const immutable = /\/[0-9a-f]{40}\//.test(key) && !key.endsWith("/status.json");
    const { value, metadata } = await env.INDEX.getWithMetadata(key, { type: "arrayBuffer", cacheTtl: immutable ? 86400 : 60 });
    if (value === null) return notFound();
    const headers = new Headers(CORS);
    headers.set("Content-Type", metadata?.contentType ?? "application/octet-stream");
    headers.set("Cache-Control", signed ? SIGNED_CACHE : metadata?.cacheControl ?? "public, max-age=60");
    if (metadata?.contentEncoding) headers.set("Content-Encoding", metadata.contentEncoding);
    return new Response(req.method === "HEAD" ? null : value, {
      headers,
      encodeBody: metadata?.contentEncoding ? "manual" : "automatic",
    });
  },
};
