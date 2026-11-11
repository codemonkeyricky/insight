// The bucket's CORS rule, for the browser's cross-origin reads of the public storage base. Built as a signed S3 request
// (PutBucketCors on the R2 endpoint, SigV4 region "auto") so scripts/r2-setup.mjs can apply it with the R2_* credentials.
import { createHash } from "node:crypto";
import { AwsV4Signer } from "aws4fetch";

/** Origins that may read the storage: the production site, its preview deployments, and the local hosted-dev server. */
export const CORS_ORIGINS = [
  "https://arch-insight.vercel.app",
  "https://*.vercel.app",
  "http://localhost:4330",
  "http://127.0.0.1:4330",
] as const;

export const CORS_METHODS = ["GET", "HEAD"] as const;
/** Headers the browser may read: the ETag, the encoding and the length of a stored object. */
export const CORS_EXPOSE = ["ETag", "Content-Encoding", "Content-Length"] as const;
export const CORS_MAX_AGE_SECONDS = 3600;

export interface R2Credentials {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

const escapeXml = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The CORSConfiguration document the S3 PutBucketCors call takes. */
export function corsXml(origins: readonly string[] = CORS_ORIGINS): string {
  const lines = [
    "<CORSConfiguration>",
    "  <CORSRule>",
    ...origins.map((o) => `    <AllowedOrigin>${escapeXml(o)}</AllowedOrigin>`),
    ...CORS_METHODS.map((m) => `    <AllowedMethod>${m}</AllowedMethod>`),
    ...CORS_EXPOSE.map((h) => `    <ExposeHeader>${h}</ExposeHeader>`),
    `    <MaxAgeSeconds>${CORS_MAX_AGE_SECONDS}</MaxAgeSeconds>`,
    "  </CORSRule>",
    "</CORSConfiguration>",
  ];
  return lines.join("\n");
}

/** The signed PutBucketCors request: PUT https://<account>.r2.cloudflarestorage.com/<bucket>?cors, with Content-MD5. */
export async function putBucketCorsRequest(config: R2Credentials, origins: readonly string[] = CORS_ORIGINS): Promise<Request> {
  const body = corsXml(origins);
  const md5 = createHash("md5").update(body, "utf8").digest("base64");
  const url = `https://${config.accountId}.r2.cloudflarestorage.com/${config.bucket}?cors`;
  const signed = await new AwsV4Signer({
    url,
    method: "PUT",
    headers: { "content-type": "application/xml", "content-md5": md5 },
    body,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    service: "s3",
    region: "auto",
  }).sign();
  return new Request(signed.url, { method: signed.method, headers: signed.headers, body });
}
