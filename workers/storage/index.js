// Read-only public view of the Insight KV namespace. Keys are paths like gh/<owner>/<repo>/<sha>/model.json.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Expose-Headers": "ETag, Content-Encoding, Content-Length",
};

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: { ...CORS, "Access-Control-Allow-Headers": "*", "Access-Control-Max-Age": "3600" } });
    }
    if (req.method !== "GET" && req.method !== "HEAD") return new Response("method not allowed", { status: 405, headers: CORS });
    const key = decodeURIComponent(new URL(req.url).pathname.slice(1));
    if (!key || key.includes("..")) return new Response("not found", { status: 404, headers: { ...CORS, "Cache-Control": "no-store" } });
    // Export files under a full sha never change, so the edge may keep them long; everything else stays fresh.
    const immutable = /\/[0-9a-f]{40}\//.test(key) && !key.endsWith("/status.json");
    const { value, metadata } = await env.INDEX.getWithMetadata(key, { type: "arrayBuffer", cacheTtl: immutable ? 86400 : 60 });
    if (value === null) return new Response("not found", { status: 404, headers: { ...CORS, "Cache-Control": "no-store" } });
    const headers = new Headers(CORS);
    headers.set("Content-Type", metadata?.contentType ?? "application/octet-stream");
    headers.set("Cache-Control", metadata?.cacheControl ?? "public, max-age=60");
    if (metadata?.contentEncoding) headers.set("Content-Encoding", metadata.contentEncoding);
    return new Response(req.method === "HEAD" ? null : value, {
      headers,
      encodeBody: metadata?.contentEncoding ? "manual" : "automatic",
    });
  },
};
