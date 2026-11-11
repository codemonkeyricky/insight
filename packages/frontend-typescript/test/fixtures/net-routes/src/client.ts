const BASE = import.meta.env.VITE_API_BASE;

export async function postLiteral() {
  return fetch("https://api.github.com/repos/o/r/issues", { method: "post" });
}

export async function templated(owner: string, repo: string) {
  return fetch(`https://api.github.com/repos/${owner}/${repo}/releases`);
}

export async function relative() {
  return fetch("/api/index", { method: "POST", headers: {} });
}

export async function fromEnv(id: string) {
  return fetch(`${BASE}/v1/items/${id}`);
}

export async function injected(deps: { fetch: typeof fetch }, url: string) {
  return deps.fetch(url, { method: "PUT" });
}

const KV_API = "https://api.cloudflare.com/client/v4";

export async function viaFetchFn(fetchFn: typeof fetch, id: string) {
  return fetchFn(`${KV_API}/accounts/${id}`, { method: "PUT" });
}

export async function parsed() {
  return fetch(new URL("https://api.github.com/x"));
}
