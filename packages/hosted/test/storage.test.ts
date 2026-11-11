import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import { fsStorage, IMMUTABLE, r2Storage } from "../src/index.js";

const SCRATCH = mkdtempSync(join(tmpdir(), "hosted-storage-"));
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

describe("fsStorage", () => {
  it("writes gzip bodies with a sidecar of headers, and reads them back decoded", async () => {
    const store = fsStorage(join(SCRATCH, "fs"));
    await store.put("gh/o/r/sha/project.json", '{"a":1}', { contentType: "application/json", cacheControl: IMMUTABLE, gzip: true });
    const raw = readFileSync(join(SCRATCH, "fs/gh/o/r/sha/project.json"));
    expect(raw[0]).toBe(0x1f);
    expect(gunzipSync(raw).toString("utf8")).toBe('{"a":1}');
    const sidecar = JSON.parse(readFileSync(join(SCRATCH, "fs/gh/o/r/sha/project.json.meta.json"), "utf8"));
    expect(sidecar).toEqual({ contentType: "application/json", cacheControl: IMMUTABLE, contentEncoding: "gzip" });
    expect(await store.getJson("gh/o/r/sha/project.json")).toEqual({ a: 1 });
    expect(await store.get("gh/o/r/missing.json")).toBeUndefined();
    expect(store.kind).toBe("fs");
  });

  it("refuses keys that escape the folder", async () => {
    const store = fsStorage(join(SCRATCH, "fs2"));
    await expect(store.put("../x.json", "{}", { contentType: "application/json", cacheControl: "no-store" })).rejects.toThrow();
  });
});

describe("r2Storage", () => {
  const config = { accountId: "acct123", accessKeyId: "AKID", secretAccessKey: "SECRET", bucket: "insight" };

  it("signs PUTs with SigV4 and sends the gzip body with its headers", async () => {
    const seen: Request[] = [];
    const store = r2Storage({
      ...config,
      fetch: async (input) => {
        seen.push(input as Request);
        return new Response(null, { status: 200 });
      },
    });
    await store.put("gh/o/r/sha/scope/@root/arch.json", '{"b":2}', {
      contentType: "application/json",
      cacheControl: IMMUTABLE,
      gzip: true,
    });
    expect(seen).toHaveLength(1);
    const req = seen[0] as Request;
    expect(req.method).toBe("PUT");
    expect(req.url).toBe("https://acct123.r2.cloudflarestorage.com/insight/gh/o/r/sha/scope/@root/arch.json");
    expect(req.headers.get("authorization")?.startsWith("AWS4-HMAC-SHA256")).toBe(true);
    expect(req.headers.get("authorization")).toContain("/auto/s3/aws4_request");
    expect(req.headers.get("content-encoding")).toBe("gzip");
    expect(req.headers.get("cache-control")).toBe(IMMUTABLE);
    expect(req.headers.get("content-type")).toBe("application/json");
    const body = Buffer.from(await req.arrayBuffer());
    expect(body[0]).toBe(0x1f);
    expect(gunzipSync(body).toString("utf8")).toBe('{"b":2}');
  });

  it("signs GETs, returns undefined on 404 and decodes gzip bodies", async () => {
    const zipped = gzipSync('{"c":3}');
    const store = r2Storage({
      ...config,
      fetch: async (input) => {
        const req = input as Request;
        if (req.url.endsWith("/missing.json")) return new Response("nope", { status: 404 });
        expect(req.method).toBe("GET");
        expect(req.headers.get("authorization")?.startsWith("AWS4-HMAC-SHA256")).toBe(true);
        return new Response(zipped, { status: 200 });
      },
    });
    expect(await store.get("gh/o/r/missing.json")).toBeUndefined();
    expect(await store.getJson("gh/o/r/latest.json")).toEqual({ c: 3 });
    expect(store.kind).toBe("r2");
  });
});
