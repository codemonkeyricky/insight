# Hosting: index any public GitHub repo

The hosted build lets anyone paste a public GitHub repository and open its architecture, flow and findings. The
browser never runs the indexer: a Vercel Function downloads the commit, runs the same exporter the local app uses,
and writes a static export to a Cloudflare R2 bucket. The page then reads that export straight from R2.

Plan of record: `~/.claude/plans/hosted-backend.md`, section "Free-tier contract". This document is the operator's view.

## Architecture

```
browser ──► arch-insight.vercel.app (static: dist-hosted, VITE_STORAGE_BASE = R2 public URL)
   │
   ├─ POST /api/index ──► Vercel Function (index.func, Node 22, 2 GB, 300 s)
   │                        1. GitHub REST: repo size, ref → commit sha
   │                        2. status.json (queued) → 202, job continues in the background
   │                        3. codeload tarball → /tmp/insight/<sha>, extracted under caps
   │                        4. @insight/export (in-process indexer, built-in plugins)
   │                        5. upload gzip files, latest.json, recent.json, status.json done
   │
   ├─ GET  /api/health  ──► Vercel Function (health.func)
   │
   └─ GET  <R2_PUBLIC_BASE>/gh/<owner>/<repo>/<sha>/…  (static JSON, CORS-allowed)
             status.json polled every 1.5 s while indexing
```

Packages: `packages/export` (`@insight/export`, the slim static export), `packages/hosted` (`@insight/hosted`,
handlers, storage adapters, GitHub fetch, the Node entry for Vercel), `apps/web` (hosted build flavour, `build:hosted`).

## Storage layout

Bucket keys (R2 in production, a folder with `<key>.meta.json` sidecars locally):

| Key | Content | Headers |
|---|---|---|
| `gh/<owner>/<repo>/<sha>/<export file>` | static export JSON | gzip, `application/json`, `public, max-age=31536000, immutable` |
| `gh/<owner>/<repo>/<sha>/status.json` | `{repo, sha, ref, state, phase?, done?, total?, error?, startedAt, updatedAt}` | `no-store`, not gzipped |
| `gh/<owner>/<repo>/latest.json` | `{repo, sha, ref, indexedAt, nodes, files}` | gzip, `max-age=60` |
| `meta/recent.json` | array, newest 50 `{repo, sha, indexedAt, nodes, files}` | gzip, `max-age=60` |
| `meta/daily/<YYYY-MM-DD>.json` | `{total, ips: {<ip>: n}}` for the daily caps | `no-store` |

Owner and repo are stored lowercased.

Status `state` is `running`, `done` or `failed`. While running, `phase` is `queued`, then the exporter's phases
(`download`, `scan`, `extract`, `link`, `analyze`, `save`) with `done`/`total` when the phase counts its work.
A failed status carries `error.code`: `bad_request`, `method_not_allowed`, `not_found`, `too_large`, `rate_limited`,
`upstream_error` (GitHub failed on the request path), `timeout`, `index_failed`.

## Environment variables

| Variable | Where | Meaning |
|---|---|---|
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` | Function, `r2-setup`, `hosted-seed` | R2 S3 API credentials. Set all four or none. |
| `R2_PUBLIC_BASE` | `build-vercel-hosted` (required) | The bucket's public URL, e.g. `https://pub-xxxx.r2.dev`. Baked into the static build. |
| `GITHUB_TOKEN` | Function (optional) | A GitHub token sent with the REST and tarball requests. Raises GitHub's rate limit for the function's calls. |
| `MAX_REPO_KB` | Function (optional) | Pre-flight size cap in KB. Default 300000. |
| `INDEX_DAILY_CAP` | Function (optional) | Indexes started per UTC day, all users. Default 200. |
| `INDEX_IP_DAILY_CAP` | Function (optional) | Indexes started per UTC day, per client address. Default 10. |
| `INSIGHT_STORAGE_DIR` | local only | Folder store used when no `R2_*` variable is set (`hosted-dev`, tests, seeding without R2). |
| `INSIGHT_TMP_DIR` | optional | Scratch root for jobs. Default `/tmp/insight`. Each job removes its folder. |
| `VITE_STORAGE_BASE` | web build | Storage root the page reads from. Default `/storage/`; the Vercel build sets `${R2_PUBLIC_BASE}/`. |
| `VITE_HOSTED`, `VITE_STATIC` | web build | `build:hosted` sets `VITE_HOSTED=1`. `build:demo` is the offline demo. |

## Limits

| Limit | Value | Behaviour |
|---|---|---|
| GitHub repo size (`size` from REST) | 300 000 KB | `413 too_large`, before any download |
| Files in a commit | 10 000 | job fails `too_large` |
| One file | 1 MiB | skipped with a warning |
| Total extracted | 200 MiB | job fails `too_large` |
| Job wall clock | 270 s watchdog (function `maxDuration` 300 s) | job fails `timeout` |
| Concurrent jobs | not limited (each invocation is one job) | |
| Submissions | 200 per UTC day total, 10 per address per day | `429 rate_limited` |
| A running job | a new POST within 6 min of its last update returns the running state; after 6 min a new job starts | |
| A failed commit | a new POST within 1 h returns the failure; after that it is retried | |
| Function memory | 2048 MB | |
| Function unzipped size | 111 MB each (limit 250 MB) | |

Only public repositories are indexed. Private, missing and non-GitHub hosts are refused (`not_found`, `bad_request`).
The index is of the default branch's head, or of the ref in a `/tree/<ref>` URL. The web page itself refuses branch and folder links and asks for the repository link.

## Local development

```sh
pnpm -r --workspace-concurrency=1 build
pnpm --filter @insight/web build:hosted
mkdir -p /tmp/insight-storage
INSIGHT_STORAGE_DIR=/tmp/insight-storage node scripts/hosted-dev.mjs --port 4330
open http://127.0.0.1:4330/
```

`scripts/hosted-dev.mjs` serves `apps/web/dist-hosted`, runs `/api/index` and `/api/health` through the same handlers the
Function uses, and serves `/storage/*` from the folder with the sidecar headers. R2 variables from the shell are ignored
there, so local runs never touch the bucket. Indexing needs network access to GitHub.

End-to-end checks were run with playwright-core and headless chromium (see the PR description and
`docs/screenshots/hosted/e2e-*.png`).

## Packaging and deploy

1. Build the packages and the hosted web, and package the Vercel output:

   ```sh
   R2_PUBLIC_BASE=https://pub-xxxx.r2.dev node scripts/build-vercel-hosted.mjs <outDir>
   ```

   This writes `<outDir>/.vercel/output/`: `config.json` (version 3: real files first, then `/index.html`), `static/`
   (the hosted web build), and `functions/api/index.func` and `functions/api/health.func`. Each function holds a flat
   `node_modules` from `pnpm --filter @insight/hosted deploy --prod --config.node-linker=hoisted`, the hosted `dist`,
   the built-in plugins under `packages/` and `plugins/`, and a `pnpm-workspace.yaml` marker at its root.

   Built-in plugins: core discovers them by walking up from its own file to `pnpm-workspace.yaml`. The marker makes the
   function's root the plugin root, so the plugins are found with no code change. `better-sqlite3` is removed from the
   bundle: the hosted export never opens `index.sqlite`, and core imports it lazily.

2. Deploy the prebuilt output. Link the project once (`vercel link`), then from `<outDir>`:

   ```sh
   vercel deploy --prebuilt --prod --archive=tgz
   ```

   Turn on Fluid compute for the project. The index function needs up to 300 s, and the Function's `maxDuration` is 300
   (`.vc-config.json`). Without Fluid compute the limit is lower.

3. Set the Function environment variables in the Vercel project: the four `R2_*` variables, optionally `GITHUB_TOKEN`
   and the caps. Redeploy after changing them.

4. Apply the bucket's CORS rule once (and after changing the origins):

   ```sh
   node scripts/r2-setup.mjs --dry-run   # prints the rule and the request
   node scripts/r2-setup.mjs             # needs the R2_* variables
   ```

   The rule allows GET and HEAD from `https://arch-insight.vercel.app`, `https://*.vercel.app`, and the local dev
   origins, exposes `ETag`, `Content-Encoding` and `Content-Length`, and caches for 3600 s.

5. Check the deployment: `GET https://<site>/api/health` returns `{"ok":true,"storage":"r2"}`. Index a small public repo
   from the home page and open it.

## Seeding

The featured Insight self-index, or any repository the function cannot fetch (private), is published from a local checkout
with the same export and storage:

```sh
pnpm -r --workspace-concurrency=1 build
R2_ACCOUNT_ID=… R2_ACCESS_KEY_ID=… R2_SECRET_ACCESS_KEY=… R2_BUCKET=… \
  node scripts/hosted-seed.mjs <localPath> <owner/repo> <40-char commit sha>
```

Without `R2_*` it writes to `INSIGHT_STORAGE_DIR`. The script writes the export, `latest.json`, `recent.json` and a
`done` status, so the repository opens at `#/gh/<owner>/<repo>` straight away.

## Known limits

- Only public GitHub repositories. Private repositories need the accounts work (plan phase 6).
- The index is of the default branch's head at the time of the request. There is no freshness check: an index is
  reused until it is replaced by a new request for a different commit.
- Storage is append-only: old commits are kept. Nothing evicts them yet.
- Repository names in URLs and messages are lowercase (the storage keys are lowercase), so the page shows
  `microsoft/typescript`, not `microsoft/TypeScript`.
- Large repositories (over 300 MB by GitHub's size, or over 10 000 files) are refused with a readable message.
- Vercel's background work: the Node entry keeps the invocation open until the index job settles, using the
  request-context hook that `@vercel/functions` reads. The packaged bundle was run locally (self-test: index to `done`);
  it has not been run on Vercel, and it depends on the Function staying alive after the response (Fluid compute). Check
  the first real index after a deploy, and that `status.json` reaches `done`.
- The daily counters are a read-modify-write in storage, so concurrent submissions can overshoot the caps slightly.
- The index job runs in `/tmp` with the function's 2 GB of memory. The watchdog ends a run at 270 s.
