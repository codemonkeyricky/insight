// One Vercel Function serves the index API. The table maps each path to the job it runs.
import { waitUntil } from "@vercel/functions";

const PATHS = {
  "/api/index": "index",
  "/api/status": "status",
};

const a = process.env.CF_ACCOUNT_ID;
const n = process.env.CF_KV_NAMESPACE;

async function writeStatus(k: string, body: string): Promise<void> {
  await fetch(`https://api.cloudflare.com/client/v4/accounts/${a}/storage/kv/namespaces/${n}/values/${k}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${process.env.CF_API_TOKEN}` },
    body,
  });
}

async function repoInfo(o: string, r: string): Promise<unknown> {
  const res = await fetch(`https://api.github.com/repos/${o}/${r}`, { headers: { Accept: "application/vnd.github+json" } });
  return res.json();
}

export default async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const job = PATHS[url.pathname];
  if (job === "index") {
    waitUntil(writeStatus("status/latest", JSON.stringify({ state: "queued" })));
    return new Response(null, { status: 202 });
  }
  if (job === "status") {
    const info = await repoInfo("codemonkeyricky", "insight");
    return Response.json(info);
  }
  return new Response("not found", { status: 404 });
}
