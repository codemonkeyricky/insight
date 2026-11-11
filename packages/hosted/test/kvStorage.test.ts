import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { gunzipSync, gzipSync } from "node:zlib";
import { fsStorage, IMMUTABLE, kvStorage, observedStorage, storageFromEnv, type FetchLike } from "../src/index.js";

const config = { accountId: "acct123", namespaceId: "ns456", apiToken: "tok-secret", retryDelayMs: 0 };
const BASE = "https://api.cloudflare.com/client/v4/accounts/acct123/storage/kv/namespaces/ns456/values";

interface Seen {
  url: string;
  init: RequestInit;
}

/** A fetch that records each call and answers with `reply` (a function of the call index). */
function recorder(reply: (index: number) => Response = () => new Response("{}", { status: 200 })) {
  const seen: Seen[] = [];
  const fetch: FetchLike = async (input, init) => {
    seen.push({ url: String(input), init: init ?? {} });
    return reply(seen.length - 1);
  };
  return { fetch, seen };
}

describe("kvStorage: writes", () => {
  it("PUTs the gzip body and metadata as multipart form fields, to the urlencoded key, with the bearer token", async () => {
    const rec = recorder();
    const store = kvStorage({ ...config, fetch: rec.fetch });
    await store.put("gh/o/r/sha/scope/@root/arch.json", '{"b":2}', { contentType: "application/json", cacheControl: IMMUTABLE, gzip: true });

    expect(rec.seen).toHaveLength(1);
    const { url, init } = rec.seen[0] as Seen;
    expect(init.method).toBe("PUT");
    expect(url).toBe(`${BASE}/${encodeURIComponent("gh/o/r/sha/scope/@root/arch.json")}`);
    expect(url).toContain("%2F");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer tok-secret");

    const form = init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(JSON.parse(String(form.get("metadata")))).toEqual({
      contentType: "application/json",
      cacheControl: IMMUTABLE,
      contentEncoding: "gzip",
    });
    const value = form.get("value") as Blob;
    const bytes = Buffer.from(await value.arrayBuffer());
    expect(bytes[0]).toBe(0x1f);
    expect(gunzipSync(bytes).toString("utf8")).toBe('{"b":2}');
  });

  it("sends an uncompressed body without contentEncoding in the metadata", async () => {
    const rec = recorder();
    const store = kvStorage({ ...config, fetch: rec.fetch });
    await store.put("gh/o/r/sha/status.json", '{"state":"running"}', { contentType: "application/json", cacheControl: "no-store" });
    const form = rec.seen[0]?.init.body as FormData;
    expect(JSON.parse(String(form.get("metadata")))).toEqual({ contentType: "application/json", cacheControl: "no-store" });
    expect(Buffer.from(await (form.get("value") as Blob).arrayBuffer()).toString("utf8")).toBe('{"state":"running"}');
  });

  it("retries a 503 once and then succeeds", async () => {
    const rec = recorder((i) => (i === 0 ? new Response("busy", { status: 503 }) : new Response("{}", { status: 200 })));
    const store = kvStorage({ ...config, fetch: rec.fetch });
    await store.put("k.json", "{}", { contentType: "application/json", cacheControl: "no-store" });
    expect(rec.seen).toHaveLength(2);
  });

  it("retries a 429 once, and throws when the retry fails too", async () => {
    const rec = recorder(() => new Response("slow down", { status: 429 }));
    const store = kvStorage({ ...config, fetch: rec.fetch });
    await expect(store.put("k.json", "{}", { contentType: "application/json", cacheControl: "no-store" })).rejects.toThrow(/429/);
    expect(rec.seen).toHaveLength(2);
  });

  it("does not retry a 400", async () => {
    const rec = recorder(() => new Response("bad", { status: 400 }));
    const store = kvStorage({ ...config, fetch: rec.fetch });
    await expect(store.put("k.json", "{}", { contentType: "application/json", cacheControl: "no-store" })).rejects.toThrow(/400/);
    expect(rec.seen).toHaveLength(1);
  });
});

describe("kvStorage: reads", () => {
  it("GETs the value with the token, decodes gzip by its magic bytes, and parses JSON", async () => {
    const rec = recorder(() => new Response(new Uint8Array(gzipSync('{"a":1}')), { status: 200 }));
    const store = kvStorage({ ...config, fetch: rec.fetch });
    expect(await store.getJson("gh/o/r/latest.json")).toEqual({ a: 1 });
    expect(rec.seen[0]?.init.method).toBe("GET");
    expect(rec.seen[0]?.url).toBe(`${BASE}/${encodeURIComponent("gh/o/r/latest.json")}`);
    expect((rec.seen[0]?.init.headers as Record<string, string>).authorization).toBe("Bearer tok-secret");
  });

  it("answers undefined for a 404", async () => {
    const rec = recorder(() => new Response('{"success":false}', { status: 404 }));
    const store = kvStorage({ ...config, fetch: rec.fetch });
    expect(await store.get("gh/o/r/missing.json")).toBeUndefined();
    expect(await store.getJson("gh/o/r/missing.json")).toBeUndefined();
    expect(store.kind).toBe("kv");
  });

  it("throws on other failures", async () => {
    const rec = recorder(() => new Response("nope", { status: 403 }));
    const store = kvStorage({ ...config, fetch: rec.fetch });
    await expect(store.get("k.json")).rejects.toThrow(/403/);
  });
});

describe("observedStorage", () => {
  it("reports each put before it runs and passes reads through", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "hosted-observed-"));
    try {
      const inner = fsStorage(join(scratch, "store"));
      const keys: string[] = [];
      const store = observedStorage(inner, (key) => keys.push(key));
      await store.put("a/b.json", '{"x":1}', { contentType: "application/json", cacheControl: "no-store" });
      expect(keys).toEqual(["a/b.json"]);
      expect(await store.getJson("a/b.json")).toEqual({ x: 1 });
      expect(store.kind).toBe("fs");
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe("storageFromEnv: the Cloudflare KV variables", () => {
  const kvEnv = { CLOUDFLARE_API_TOKEN: "t", R2_ACCOUNT_ID: "acct123", CF_KV_NAMESPACE_ID: "ns456" };

  it("picks KV when the token, the account and the namespace are set, ahead of R2 and the folder", () => {
    const store = storageFromEnv({ ...kvEnv, INSIGHT_STORAGE_DIR: "/tmp/x", R2_BUCKET: "b", R2_ACCESS_KEY_ID: "k", R2_SECRET_ACCESS_KEY: "s" });
    expect(store.kind).toBe("kv");
  });

  it("accepts CF_ACCOUNT_ID in place of R2_ACCOUNT_ID", () => {
    expect(storageFromEnv({ CLOUDFLARE_API_TOKEN: "t", CF_ACCOUNT_ID: "acct123", CF_KV_NAMESPACE_ID: "ns456" }).kind).toBe("kv");
  });

  it("names the missing KV variable when only part of the set is present", () => {
    expect(() => storageFromEnv({ CLOUDFLARE_API_TOKEN: "t", R2_ACCOUNT_ID: "a" })).toThrow(/CF_KV_NAMESPACE_ID/);
    expect(() => storageFromEnv({ CF_KV_NAMESPACE_ID: "n" })).toThrow(/CLOUDFLARE_API_TOKEN/);
  });
});
