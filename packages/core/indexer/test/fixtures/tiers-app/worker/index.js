// The public read-only view of the index namespace: GET /<key> returns the stored JSON.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const value = await env.INDEX.get(url.pathname.slice(1));
    if (value === null) return new Response("not found", { status: 404 });
    return new Response(value, { headers: { "Content-Type": "application/json" } });
  },
};
