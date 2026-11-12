#!/usr/bin/env node
// Applies the R2 bucket's CORS rule (GET/HEAD from the site, its previews and localhost; exposes ETag, Content-Encoding and
// Content-Length; max age 3600 s) through the S3 PutBucketCors API. The request is built and signed in apps/hosted.
//
//   node scripts/r2-setup.mjs --dry-run   prints the rule and the request line, sends nothing (credentials optional)
//   node scripts/r2-setup.mjs             applies the rule (needs R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET)
import { corsXml, putBucketCorsRequest } from "../apps/hosted/dist/index.js";

const dryRun = process.argv.includes("--dry-run");
const env = process.env;
const config = {
  accountId: env.R2_ACCOUNT_ID ?? "",
  accessKeyId: env.R2_ACCESS_KEY_ID ?? "",
  secretAccessKey: env.R2_SECRET_ACCESS_KEY ?? "",
  bucket: env.R2_BUCKET ?? "",
};

if (dryRun) {
  const accountId = config.accountId || "<R2_ACCOUNT_ID>";
  const bucket = config.bucket || "<R2_BUCKET>";
  console.log(`PUT https://${accountId}.r2.cloudflarestorage.com/${bucket}?cors`);
  console.log(corsXml());
  process.exit(0);
}

const missing = Object.entries({ R2_ACCOUNT_ID: config.accountId, R2_ACCESS_KEY_ID: config.accessKeyId, R2_SECRET_ACCESS_KEY: config.secretAccessKey, R2_BUCKET: config.bucket })
  .filter(([, value]) => value === "")
  .map(([name]) => name);
if (missing.length > 0) {
  console.error(`r2-setup: set ${missing.join(", ")} (or use --dry-run)`);
  process.exit(2);
}

const request = await putBucketCorsRequest(config);
const res = await fetch(request);
const text = await res.text();
if (!res.ok) {
  console.error(`r2-setup: PutBucketCors failed with ${res.status}: ${text}`);
  process.exit(1);
}
console.log(`r2-setup: CORS rule applied to bucket ${config.bucket} (HTTP ${res.status})`);
