const KV_API = "https://api.cloudflare.com/client/v4";

export function kvStore(config: { accountId: string; namespaceId: string }) {
  const base = `${KV_API}/accounts/${config.accountId}/storage/kv/namespaces/${config.namespaceId}/values`;
  const url = (key: string) => `${base}/${encodeURIComponent(key)}`;
  const send = (target: string, init: { method: string }) => fetch(target, init);
  return {
    async put(key: string, body: string) {
      await fetch(url(key), { method: "PUT", body });
    },
    async remove(key: string) {
      await send(url(key), { method: "DELETE" });
    },
  };
}
