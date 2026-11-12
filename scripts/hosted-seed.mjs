#!/usr/bin/env node
// Indexes a local checkout and publishes it the way the hosted function does: the static export (gzip, immutable),
// latest.json, recent.json and a done status.json. For repos the function cannot fetch (private) or the featured
// self-index. With --private the same files go under private/, and recent.json and the public latest.json are left alone. Storage comes from the same environment as the function: Workers KV when the Cloudflare KV variables are set, then R2_*, else INSIGHT_STORAGE_DIR.
//
//   pnpm -r build && node scripts/hosted-seed.mjs [--private] <localPath> <owner/repo> <sha>
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportProject } from "../apps/export/dist/index.js";
import { IMMUTABLE, publishExport, storageFromEnv, writeStatus } from "../apps/hosted/dist/index.js";

const argv = process.argv.slice(2);
const visibility = argv.includes("--private") ? "private" : "public";
const [localPath, repoArg, sha] = argv.filter((arg) => arg !== "--private");
if (!localPath || !repoArg || !sha) {
  console.error("usage: node scripts/hosted-seed.mjs [--private] <localPath> <owner/repo> <sha>");
  process.exit(2);
}
const match = /^([a-z0-9-]+)\/([a-z0-9._-]+)$/.exec(repoArg.toLowerCase());
if (!match || !/^[0-9a-f]{40}$/.test(sha)) {
  console.error("repo must be owner/repo and sha a full 40-character commit sha");
  process.exit(2);
}
const [, owner, repo] = match;

const storage = storageFromEnv(process.env);
const home = mkdtempSync(join(tmpdir(), "insight-seed-"));
const started = new Date().toISOString();
try {
  const result = await exportProject({
    root: localPath,
    name: repo,
    commit: sha,
    home,
    url: `https://github.com/${owner}/${repo}`,
  });
  await publishExport(storage, {
    owner,
    repo,
    sha,
    ref: sha,
    indexedAt: new Date().toISOString(),
    result,
    visibility,
  });
  await writeStatus(
    storage,
    owner,
    repo,
    sha,
    {
      repo: `${owner}/${repo}`,
      sha,
      ref: sha,
      state: "done",
      startedAt: started,
      updatedAt: new Date().toISOString(),
    },
    visibility,
  );
  console.log(`seeded ${visibility} ${owner}/${repo}@${sha}: ${result.files.size} files, ${result.meta.nodes} nodes (cache ${IMMUTABLE})`);
} finally {
  rmSync(home, { recursive: true, force: true });
}
