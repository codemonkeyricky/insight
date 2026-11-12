# Insight

Repo layout, apps and plugin rules: `README.md` and `docs/layout.md`. Hosted architecture, env vars and limits: `docs/hosting.md`.

## Deployment: omninsight.vercel.app

Production is the **hosted build**: the static `apps/web` (`build:hosted`) plus one Vercel Function (`apps/hosted`). It is packaged locally and deployed **prebuilt**.

| | |
|---|---|
| Vercel project | `arch-insight` (scope `richards-projects-fcf7a01b`) |
| Production domains | https://omninsight.vercel.app (project domain), https://polyoptic.vercel.app |
| Storage | Cloudflare Workers KV, read through the `insight-storage` Worker (`KV_PUBLIC_BASE`) |
| Function env | `CLOUDFLARE_API_TOKEN`, `R2_ACCOUNT_ID`, `CF_KV_NAMESPACE_ID`, … are set in the Vercel project, not locally |

Every production deploy of `arch-insight` moves both domains to the new deployment.

**Never deploy `apps/server`.** It is the local-only Fastify app: it listens on a port and uses `~/.insight`, sqlite and `git` subprocesses. It does not run on Vercel.

### Deploy steps

Never run `vercel` from the repo root. `.claude/worktrees/` is untracked (about 13 GB) and would be uploaded. Build from a clean export of the committed tree instead:

```sh
WORK=$(mktemp -d)
mkdir -p "$WORK/src"
git archive --format=tar HEAD | tar -x -C "$WORK/src"     # committed files only, no worktrees or dirty files

cd "$WORK/src"
vercel link --yes --project arch-insight --scope richards-projects-fcf7a01b
KV_PUBLIC_BASE=https://insight-storage.insight-vserkk.workers.dev \
  node scripts/build-vercel-hosted.mjs "$WORK/out"        # writes $WORK/out/.vercel/output

cp .vercel/project.json "$WORK/out/.vercel/"           # link the output dir too
cd "$WORK/out"
vercel deploy --prebuilt --prod --archive=tgz --scope richards-projects-fcf7a01b
```

The upload is about 18 MB. The Function bundle is about 111 MB unzipped, against a 250 MB limit.

### Verify

```sh
curl -s https://omninsight.vercel.app/api/health    # {"ok":true,"storage":"kv"}
curl -s -o /dev/null -w '%{http_code}\n' https://omninsight.vercel.app/
vercel inspect omninsight.vercel.app --scope richards-projects-fcf7a01b
```

After a deploy that touches `apps/hosted`, index a small public repo from the home page and check that `/api/status` reaches `done` (see `docs/hosting.md`, "Known limits").

### Rollback

```sh
vercel rollback <previous-deployment-url> --scope richards-projects-fcf7a01b
```

`vercel ls arch-insight --scope richards-projects-fcf7a01b` lists past deployments. The domain alias was added once with `vercel domains add omninsight.vercel.app arch-insight` and does not need to be re-added.

## Local server

`node apps/server/dist/main.js` runs from a worktree with `PORT=4317 HOST=127.0.0.1 INSIGHT_HOME=~/.insight` and logs to `~/.insight-serve.log`. The repo lives at `~/deploy/insight`. After moving it, run `git worktree repair`.
