#!/usr/bin/env node
// Creates the Workers KV namespace the hosted indexes live in (title "insight-index"), or finds it when it exists, and
// prints its id. The id goes into apps/storage-worker/wrangler.toml and CF_KV_NAMESPACE_ID. The API token is read from the
// environment and never printed.
//
//   CLOUDFLARE_API_TOKEN=... R2_ACCOUNT_ID=<account id> node scripts/kv-setup.mjs [--title insight-index]
//   (CF_ACCOUNT_ID is accepted in place of R2_ACCOUNT_ID)
const TITLE = process.argv.includes("--title") ? process.argv[process.argv.indexOf("--title") + 1] : "insight-index";
const token = process.env.CLOUDFLARE_API_TOKEN ?? "";
const accountId = process.env.CF_ACCOUNT_ID || process.env.R2_ACCOUNT_ID || "";
const missing = [!token && "CLOUDFLARE_API_TOKEN", !accountId && "R2_ACCOUNT_ID or CF_ACCOUNT_ID"].filter(Boolean);
if (missing.length > 0) {
  console.error(`kv-setup: set ${missing.join(", ")}`);
  process.exit(2);
}

const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces`;
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

/** One Cloudflare API call; the body is returned when the call succeeds, and a failure exits with the API's message. */
async function call(url, init = {}) {
  const res = await fetch(url, { ...init, headers: { ...headers, ...init.headers } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.success === false) {
    const messages = (body.errors ?? []).map((e) => `${e.code}: ${e.message}`).join("; ");
    console.error(`kv-setup: ${init.method ?? "GET"} failed with ${res.status}${messages ? ` (${messages})` : ""}`);
    process.exit(1);
  }
  return body;
}

// The list is paged; look through every page for the title before creating a namespace.
let existing;
for (let page = 1; !existing; page += 1) {
  const list = await call(`${base}?page=${page}&per_page=100`);
  const found = (list.result ?? []).find((ns) => ns.title === TITLE);
  if (found) existing = found;
  else if (!list.result_info || page * list.result_info.per_page >= list.result_info.total_count || list.result.length === 0) break;
}

if (existing) {
  console.log(existing.id);
  console.error(`kv-setup: found namespace "${TITLE}"`);
} else {
  const created = await call(base, { method: "POST", body: JSON.stringify({ title: TITLE }) });
  console.log(created.result.id);
  console.error(`kv-setup: created namespace "${TITLE}"`);
}
