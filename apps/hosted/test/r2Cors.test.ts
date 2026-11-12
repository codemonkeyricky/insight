import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CORS_MAX_AGE_SECONDS, corsXml, putBucketCorsRequest } from "../src/index.js";

const creds = { accountId: "acc123", accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret", bucket: "insight-hosted" };

describe("R2 bucket CORS", () => {
  it("lists the origins, GET and HEAD, the exposed headers and the max age", () => {
    const xml = corsXml();
    for (const origin of ["https://arch-insight.vercel.app", "https://*.vercel.app", "http://localhost:4330", "http://127.0.0.1:4330"]) {
      expect(xml).toContain(`<AllowedOrigin>${origin}</AllowedOrigin>`);
    }
    expect(xml).toContain("<AllowedMethod>GET</AllowedMethod>");
    expect(xml).toContain("<AllowedMethod>HEAD</AllowedMethod>");
    expect(xml).not.toContain("<AllowedMethod>PUT</AllowedMethod>");
    for (const header of ["ETag", "Content-Encoding", "Content-Length"]) {
      expect(xml).toContain(`<ExposeHeader>${header}</ExposeHeader>`);
    }
    expect(xml).toContain(`<MaxAgeSeconds>${CORS_MAX_AGE_SECONDS}</MaxAgeSeconds>`);
    expect(CORS_MAX_AGE_SECONDS).toBe(3600);
  });

  it("escapes markup in an origin", () => {
    expect(corsXml(["https://a.example/?x=1&y=<2>"])).toContain("https://a.example/?x=1&amp;y=&lt;2&gt;");
  });

  it("builds a signed PutBucketCors request for the R2 S3 endpoint, with the document as its body and a Content-MD5", async () => {
    const req = await putBucketCorsRequest(creds);
    const url = new URL(req.url);
    expect(req.method).toBe("PUT");
    expect(url.origin).toBe("https://acc123.r2.cloudflarestorage.com");
    expect(url.pathname).toBe("/insight-hosted");
    expect(url.search).toBe("?cors");
    const body = await req.text();
    expect(body).toBe(corsXml());
    expect(req.headers.get("content-md5")).toBe(createHash("md5").update(body, "utf8").digest("base64"));
    expect(req.headers.get("content-type")).toBe("application/xml");
    const auth = req.headers.get("authorization") ?? "";
    expect(auth).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/auto\/s3\/aws4_request,/);
    expect(auth).toContain("SignedHeaders=");
    expect(auth).toMatch(/Signature=[0-9a-f]{64}$/);
  });

  it("writes no AllowedOrigin for an empty origin list (the caller picks the origins)", () => {
    expect(corsXml([])).not.toContain("<AllowedOrigin>");
  });
});
