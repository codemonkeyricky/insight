# Hosting: index any public GitHub repo

The hosted build lets anyone paste a public GitHub repository and open its architecture, flow and findings. The
browser never runs the indexer: a Vercel Function downloads the commit, runs the same exporter the local app uses,
and writes a static export to a Cloudflare Workers KV namespace. The page reads that export through a small read-only
Worker, and reads the run's progress through the Function.

Storage is **Workers KV** (the free Workers plan: no card needed). R2 remains an adapter, selected only when no KV
variable is set. The plan of record is `~/.claude/plans/hosted-backend.md`, section "Storage switch: Cloudflare Workers KV".
This document is the operator's view.

## Architecture

```
browser ──► arch-insight.vercel.app (static: dist-hosted, VITE_STORAGE_BASE = KV_PUBLIC_BASE/)
   │
   ├─ POST /api/index ──┐
   ├─ GET  /api/status ─┼─► Vercel Function (index.func, one function, Node 22, 2 GB, 300 s)
   ├─ GET  /api/health ─┘      route by ?route= (set by the rewrites in config.json)
   │                             index: 1. GitHub REST: repo size, ref → commit sha
   │                                    2. status.json (queued) → 202, job continues in the background
   │                                    3. codeload tarball → /tmp/insight/<sha>, extracted under caps
   │                                    4. @insight/export (in-process indexer, built-in plugins)
   │                                    5. KV writes: export files, latest.json, recent.json, status.json done
   │
   └─ GET  <KV_PUBLIC_BASE>/gh/<owner>/<repo>/<sha>/…   (workers/storage: KV read, CORS-allowed)
             GET  <KV_PUBLIC_BASE>/gh/<owner>/<repo>/latest.json, /meta/recent.json
             the run's progress is polled from /api/status (see "Status" below)
```

Packages: `packages/export` (`@insight/export`, the slim static export), `packages/hosted` (`@insight/hosted`,
handlers, storage adapters, GitHub fetch, the Node entry for Vercel), `apps/web` (hosted build flavour, `build:hosted`),
`workers/storage` (the read-only Worker, `insight-storage`).

## Storage layout

Keys in the KV namespace `insight-index` (in production; a folder with `<key>.meta.json` sidecars locally, and R2 keys
the same when R2 is used):

| Key | Content | Headers (the Worker serves these) |
|---|---|---|
| `gh/<owner>/<repo>/<sha>/<export file>` | static export JSON | gzip, `application/json`, `public, max-age=31536000, immutable` |
| `gh/<owner>/<repo>/<sha>/status.json` | `{repo, sha, ref, state, phase?, done?, total?, error?, startedAt, updatedAt}` | `no-store`, not gzipped |
| `gh/<owner>/<repo>/latest.json` | `{repo, sha, ref, indexedAt, nodes, files}` | gzip, `max-age=60` |
| `meta/recent.json` | array, newest 50 `{repo, sha, indexedAt, nodes, files}` | gzip, `max-age=60` |
| `meta/daily/<YYYY-MM-DD>.json` | `{total, ips: {<ip>: n}}` for the daily caps | `no-store` (not served by the Worker's CORS path in practice) |

Owner and repo are stored lowercased. A KV value holds up to 25 MiB; the largest gzipped export file for Insight is about
1.2 MB.

Status `state` is `running`, `done` or `failed`. While running, `phase` is `queued`, then the exporter's phases
(`download`, `scan`, `extract`, `link`, `analyze`, `save`) with `done`/`total` when the phase counts its work.
A failed status carries `error.code`: `bad_request`, `method_not_allowed`, `not_found`, `too_large`, `rate_limited`,
`upstream_error` (GitHub failed on the request path), `timeout`, `index_failed`.

## Status: why it is read through the Function

The page polls `GET /api/status?repo=<owner>/<repo>&sha=<sha>` (answered `Cache-Control: no-store`), not the Worker.
A KV read at the edge can be up to 60 s stale after a write, which would freeze the progress bar; the Function reads
the value through the REST API, which is current. `latest.json`, `recent.json` and the export files are still read from
the Worker, because they are immutable or change once per run.

Responses: 200 with the status; 400 `bad_request` for a missing or malformed `repo` (a `/tree/` ref is refused) or `sha`
(40 lowercase hex); 404 `not_found` when no run has written a status for that commit; 405 for anything but GET.

## Write budget (KV free plan: 1,000 writes a day)

- Status writes only on a phase change, and at most one per 3 s. The queued and the final `done`/`failed` writes always
  happen. Progress events of the same phase are dropped.
- One index writes about 17 export files, `latest.json`, `recent.json`, the daily counter, and two to seven status
  writes: roughly 20 to 28 puts. A test run of the fixture performs at most 30 puts (`packages/hosted/test/budget.test.ts`).
- The daily cap defaults to 25 indexes a day when the store is KV (about 650 writes a day at most), so the whole site
  stays under the 1,000 writes a day allowance. Reads are 100,000 a day on the free plan; the Worker's reads are cached at
  the edge.
- Over the allowance, writes fail until the daily reset at 00:00 UTC. A failed write fails the run (`index_failed`).

## Environment variables

| Variable | Where | Meaning |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | Function, `kv-setup`, `hosted-seed`, `hosted-dev` | An API token with Workers KV Storage edit rights on the account. Required with the KV set below. |
| `R2_ACCOUNT_ID` or `CF_ACCOUNT_ID` | Function, `kv-setup`, `hosted-seed` | The Cloudflare account id (not the R2 storage id). |
| `CF_KV_NAMESPACE_ID` | Function, `hosted-seed`, `hosted-dev` | The namespace id `insight-index` (`node scripts/kv-setup.mjs` prints it). |
| `KV_PUBLIC_BASE` | `build-vercel-hosted` (required; `R2_PUBLIC_BASE` is the fallback) | The storage Worker's public URL, e.g. `https://insight-storage.<account>.workers.dev`. Baked into the static build as `VITE_STORAGE_BASE` with a trailing slash. |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` | Function, `r2-setup`, `hosted-seed` | The R2 alternative (S3 API). Used only when no KV variable is set. Set all four or none. |
| `R2_PUBLIC_BASE` | `build-vercel-hosted` | The R2 bucket's public URL, when R2 is the store. |
| `GITHUB_TOKEN` | Function (optional) | A GitHub token sent with the REST and tarball requests. Raises GitHub's rate limit for the function's calls. |
| `MAX_REPO_KB` | Function (optional) | Pre-flight size cap in KB. Default 300000. |
| `INDEX_DAILY_CAP` | Function (optional) | Indexes started per UTC day, all users. Default 25 with KV, 200 otherwise. |
| `INDEX_IP_DAILY_CAP` | Function (optional) | Indexes started per UTC day, per client address. Default 10. |
| `INSIGHT_STORAGE_DIR` | local only | Folder store used when no KV or R2 variable is set (`hosted-dev`, tests, seeding without a cloud store). |
| `INSIGHT_TMP_DIR` | optional | Scratch root for jobs. Default `/tmp/insight`. Each job removes its folder. |
| `VITE_STORAGE_BASE` | web build | Storage root the page reads its indexes from. Default `/storage/`; the Vercel build sets `${KV_PUBLIC_BASE}/`. |
| `VITE_API_BASE` | web build | The origin of `/api/index` and `/api/status`. Default empty (the same origin). |
| `VITE_HOSTED`, `VITE_STATIC` | web build | `build:hosted` sets `VITE_HOSTED=1`. `build:demo` is the offline demo. |

Storage is chosen in this order (`packages/hosted/src/env.ts`): KV when `CLOUDFLARE_API_TOKEN` or `CF_KV_NAMESPACE_ID` is
set (then the account id and both others are required), else R2 when any `R2_*` variable is set, else the folder in
`INSIGHT_STORAGE_DIR`. `GET /api/health` reports the store as `{"ok":true,"storage":"kv"}`.

## Limits

| Limit | Value | Behaviour |
|---|---|---|
| GitHub repo size (`size` from REST) | 300 000 KB | `413 too_large`, before any download |
| Files in a commit | 10 000 | job fails `too_large` |
| One file | 1 MiB | skipped with a warning |
| Total extracted | 200 MiB | job fails `too_large` |
| Job wall clock | 270 s watchdog (function `maxDuration` 300 s) | job fails `timeout` |
| Concurrent jobs | not limited (each invocation is one job) | |
| Submissions | 25 per UTC day total with KV (200 otherwise), 10 per address per day | `429 rate_limited` |
| A running job | a new POST within 6 min of its last update returns the running state; after 6 min a new job starts | |
| A failed commit | a new POST within 1 h returns the failure; after that it is retried | |
| Function memory | 2048 MB | |
| Function unzipped size | about 111 MB (limit 250 MB) | |

Only public repositories are indexed. Private, missing and non-GitHub hosts are refused (`not_found`, `bad_request`).
The index is of the default branch's head, or of the ref in a `/tree/<ref>` URL. The web page itself refuses branch and folder links and asks for the repository link.

## Local development

```sh
pnpm -r --workspace-concurrency=1 build
pnpm --filter @insight/web build:hosted
INSIGHT_STORAGE_DIR=/tmp/insight-storage node scripts/hosted-dev.mjs --port 4330
open http://127.0.0.1:4330/
```

`scripts/hosted-dev.mjs` serves `apps/web/dist-hosted` and runs `/api/index`, `/api/status` and `/api/health` through the
same handlers the Function uses. Its store follows the same variables: **with the KV variables in the shell, a local run
writes to the real namespace** (every write is logged as `storage write <key>`). Unset them to use the folder in
`INSIGHT_STORAGE_DIR`, which then also serves `/storage/*` with the sidecar headers. R2 variables are ignored there.
Indexing needs network access to GitHub.

To point the page at the real Worker while developing, build it with `VITE_STORAGE_BASE=$KV_PUBLIC_BASE/` (the page then
reads `latest.json` from the Worker, and the progress from the local `/api/status`).

End-to-end checks were run with playwright-core and headless chromium (see the PR description and
`docs/screenshots/hosted/*.png`; `kv-e2e.png` is the live KV run).

## Links

A repository opens at a path as well as from the home page: `https://arch-insight.vercel.app/facebook/zstd` (the
`github.com/<owner>/<repo>` and `https://github.com/<owner>/<repo>` forms work too, with an optional `.git`). The page
moves the path to the hash route `#/gh/<owner>/<repo>` before the router reads it, and that route indexes the repository
if it has no index yet, exactly as the home page's Index button does. A `/tree/<ref>/<path>` or `/blob/<ref>/<path>` link
opens the repository's default branch: the ref and the path are ignored in v1. Paths under `/api/`, `/assets/` and
`/storage/`, and any other path, show the home page. Vercel and `scripts/hosted-dev.mjs` send every unknown path to
`index.html`, so the same page answers all of them. The parser is `parseRepoPath` in `apps/web/src/hostedRepo.ts`.

## Packaging and deploy

### 1. The storage Worker (once, and after changing `workers/storage`)

The Worker is read-only: `GET`/`HEAD /<key>` from the KV binding `INDEX`, with the headers the namespace's metadata records.
Pre-gzipped bodies are sent as they are, and `Access-Control-Allow-Origin: *`.

```sh
node scripts/kv-setup.mjs                    # needs CLOUDFLARE_API_TOKEN and R2_ACCOUNT_ID; prints the namespace id
cd workers/storage
CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… npx wrangler@4 deploy
```

`workers/storage/wrangler.toml` names the Worker `insight-storage` (so the URL is
`https://insight-storage.<account subdomain>.workers.dev`) and binds the namespace. Set `KV_PUBLIC_BASE` to that URL.

### 2. The Function and the static site

1. Build the packages and the hosted web, and package the Vercel output:

   ```sh
   KV_PUBLIC_BASE=https://insight-storage.<account>.workers.dev node scripts/build-vercel-hosted.mjs <outDir>
   ```

   This writes `<outDir>/.vercel/output/`: `config.json` (version 3: real files first, then the API rewrites
   `/api/index`, `/api/status` and `/api/health`, each sent to `/api/index?route=<name>`, then `/index.html`), `static/`
   (the hosted web build), and one Function, `functions/api/index.func`. It holds a flat `node_modules` from
   `pnpm --filter @insight/hosted deploy --prod --config.node-linker=hoisted`, the hosted `dist`, the built-in plugins
   under `packages/` and `plugins/`, and a `pnpm-workspace.yaml` marker at its root.

   Built-in plugins: core discovers them by walking up from its own file to `pnpm-workspace.yaml`. The marker makes the
   function's root the plugin root, so the plugins are found with no code change. `better-sqlite3` is removed from the
   bundle: the hosted export never opens `index.sqlite`, and core imports it lazily.

2. Deploy the prebuilt output. Link the project once (`vercel link`), then from `<outDir>`:

   ```sh
   vercel deploy --prebuilt --prod --archive=tgz
   ```

   Turn on Fluid compute for the project. The index function needs up to 300 s, and the Function's `maxDuration` is 300
   (`.vc-config.json`). Without Fluid compute the limit is lower.

3. Set the Function environment variables in the Vercel project: `CLOUDFLARE_API_TOKEN`, `R2_ACCOUNT_ID` (the account
   id), `CF_KV_NAMESPACE_ID`, optionally `GITHUB_TOKEN` and the caps. Redeploy after changing them.

4. Check the deployment: `GET https://<site>/api/health` returns `{"ok":true,"storage":"kv"}`. Index a small public repo
   from the home page and open it. `GET https://<site>/api/status?repo=<owner>/<repo>&sha=<sha>` returns the run's status.

### R2 alternative

R2 stays as an adapter: set the four `R2_*` variables (and `R2_PUBLIC_BASE` for the build) instead of the KV variables.
The bucket's CORS rule is applied once with `node scripts/r2-setup.mjs --dry-run` (prints the rule) and
`node scripts/r2-setup.mjs` (needs the `R2_*` variables). The rule allows GET and HEAD from the site, its Vercel previews
and localhost (see the header of `scripts/r2-setup.mjs`).

## Seeding

The featured Insight self-index, or any repository the function cannot fetch (private), is published from a local checkout
with the same export and storage:

```sh
pnpm -r --workspace-concurrency=1 build
CLOUDFLARE_API_TOKEN=… R2_ACCOUNT_ID=… CF_KV_NAMESPACE_ID=… \
  node scripts/hosted-seed.mjs <localPath> <owner/repo> <40-char commit sha>
```

Without the cloud variables it writes to `INSIGHT_STORAGE_DIR`. The script writes the export, `latest.json`, `recent.json`
and a `done` status, so the repository opens at `#/gh/<owner>/<repo>` straight away. A seed counts toward the KV write budget
(about 20 writes).

## Private repositories

A visitor signs in with GitHub through a GitHub App that is installed only on the repositories they choose. A signed-in
user can then index and view a private repository that they can read on GitHub. Nobody without read access can read its
index or sources. Public repositories work as before, signed in or not. Sign-in is off unless all three of
`GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET` and `SESSION_SECRET` are set; then `/api/auth/*` and `/api/private/*`
answer 404 and `/api/index` and `/api/status` behave as before.

How it works: `/api/auth/login` and `/api/auth/callback` run GitHub's user OAuth (the app's user-to-server tokens, which
expire after 8 hours and are refreshed with the refresh token). The session is an encrypted, HttpOnly cookie
`insight_session` (AES-256-GCM with `SESSION_SECRET`). Visibility is decided by GitHub's `private` field, never by the
client. A private index is written under `private/gh/<owner>/<repo>/<sha>/` only (no `recent.json`, no public
`latest.json`). The browser reads it through `GET /api/private/grant`, which checks access and returns a base URL on the
storage Worker signed for 12 hours (`/p/<exp>/<sig>/private/gh/...`). The Worker refuses every `private/` key without a
valid signature.

| Variable | Where | Meaning |
|---|---|---|
| `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET` | Function | The GitHub App's client id and a client secret generated for it. |
| `GITHUB_APP_SLUG` | Function | The app's slug; gives the install link (`https://github.com/apps/<slug>/installations/new`). |
| `SESSION_SECRET` | Function | 32 random bytes, base64. Seals the session and the OAuth state cookies. |
| `STORAGE_SIGNING_KEY` | Function and the storage Worker (same value) | 32 random bytes, base64. Signs the storage paths. Generate one with `openssl rand -base64 32`. |
| `STORAGE_PUBLIC_BASE` | Function | The storage Worker's public URL (no trailing slash). Falls back to `KV_PUBLIC_BASE`, then `R2_PUBLIC_BASE`. |
| `PUBLIC_ORIGIN` | Function | The site's origin, e.g. `https://arch-insight.vercel.app`. Used for the OAuth redirect and the origin check. |
| `ALLOWED_ORIGINS` | Function (optional) | Extra origins allowed to make state-changing requests (comma separated), e.g. a preview URL or `http://localhost:5310`. |

GitHub App setup (Settings → Developer settings → GitHub Apps → New GitHub App):

1. Name it, e.g. "Insight Viewer". Homepage URL `https://arch-insight.vercel.app`.
2. Callback URL `https://arch-insight.vercel.app/api/auth/callback`. Add `http://localhost:5310/api/auth/callback` for local
   development.
3. Turn on "Expire user authorization tokens". Turn off "Active" under Webhook (no webhook).
4. Repository permissions: Contents, read-only (Metadata read-only comes with it). No other permissions.
5. Where it can be installed: any account, or only your own.
6. Generate a client secret. Record the client id, the client secret and the app's slug.

The storage Worker's secret must match the Function's `STORAGE_SIGNING_KEY`:

```sh
cd workers/storage
printf '%s' "$STORAGE_SIGNING_KEY" | CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… npx wrangler@4 secret put STORAGE_SIGNING_KEY
```

Or, through the Cloudflare API, `PUT /accounts/<id>/workers/scripts/insight-storage/secrets` with a `secret_text` binding of
that name. Deploy the Worker before the Function (the Function's grants point at it).

Seeding a private repository from a local checkout (the same files, under `private/`):
`node scripts/hosted-seed.mjs --private <localPath> <owner/repo> <sha>`.

## Known limits

- Anonymous requests: GitHub answers 404 for private repos, so with sign-in configured a missing repo and a private one both answer 401 auth_required (sign in to check). With sign-in disabled, a missing repo answers 404 not_found as before.
- Private repositories need the GitHub App and the three sign-in variables. A grant lasts 12 hours: revoking access on GitHub
  stops new grants and source reads at once, but a grant already issued works until it expires.
- The index is of the default branch's head at the time of the request. There is no freshness check: an index is
  reused until it is replaced by a new request for a different commit.
- Storage is append-only: old commits are kept. Nothing evicts them yet. KV's free allowance is about 1 GB.
- Repository names in URLs and messages are lowercase (the storage keys are lowercase), so the page shows
  `microsoft/typescript`, not `microsoft/TypeScript`.
- Large repositories (over 300 MB by GitHub's size, or over 10 000 files) are refused with a readable message.
- Status progress is coarse by design: a phase that lasts a few seconds may show only its neighbours, because a phase
  write is dropped when it falls within 3 s of the previous write.
- Vercel's background work: the Node entry keeps the invocation open until the index job settles, using the
  request-context hook that `@vercel/functions` reads. The packaged bundle was run locally (the routes were checked for
  all three paths, and an index was run to `done` against KV); it has not been run on Vercel, and it depends on the
  Function staying alive after the response (Fluid compute). Check the first real index after a deploy, and that
  `/api/status` reaches `done`. The rewrites pass the original query string (`repo`, `sha`) on to the Function; check that
  on the first deploy too.
- The daily counters are a read-modify-write in storage, so concurrent submissions can overshoot the caps slightly.
- The index job runs in `/tmp` with the function's 2 GB of memory. The watchdog ends a run at 270 s.
