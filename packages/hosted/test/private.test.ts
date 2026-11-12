import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  fsStorage,
  handleGrant,
  handleIndex,
  handleLatest,
  handleRepos,
  handleSource,
  handleStatus,
  sealValue,
  SESSION_COOKIE,
  signPrefix,
  type IndexDeps,
  type IndexStatus,
  type PrivateDeps,
} from "../src/index.js";
import { AUTH_ENV, fakeApp, SESSION_KEY, SIGNING_KEY, setCookieValue, type AppRepo } from "./app-helpers.js";
import { FIXTURE, listFiles, makeTarball, NOW, SHA } from "./helpers.js";

const SCRATCH = mkdtempSync(join(tmpdir(), "hosted-private-"));
const ORIGIN = "https://insight.test";
const TIMEOUT = 180_000;
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

/** A fast stand-in for exportProject (as in indexer.test.ts). */
const fakeExport: IndexDeps["exportProject"] = async (opts) => {
  const names = listFiles(opts.root);
  const files = new Map<string, string>([
    ["project.json", JSON.stringify({ project: { name: opts.name } })],
    ["model.json", JSON.stringify({ nodes: [] })],
    ["files.json", JSON.stringify(names)],
  ]);
  return { files, meta: { capturedAt: "2026-11-11T12:00:00.000Z", commit: opts.commit ?? "unknown", nodes: 3, edges: 1, files: names.length } };
};

const REPOS: Record<string, AppRepo> = {
  "acme/secret": { private: true, readers: ["alice"], files: { "src/a.ts": "export const a = 1;\n" } },
  "acme/other": { private: true, readers: ["alice"] },
  "acme/open": { readers: ["alice", "bob"] },
};

let counter = 0;
async function harness(over: Partial<IndexDeps> = {}, env: Record<string, string> = AUTH_ENV) {
  counter += 1;
  const dir = join(SCRATCH, `case-${counter}`);
  const storageDir = join(dir, "storage");
  const storage = fsStorage(storageDir);
  const tarball = await makeTarball(FIXTURE);
  const fake = fakeApp(REPOS, tarball);
  const jobs: Promise<unknown>[] = [];
  const deps: IndexDeps = {
    storage,
    env: { ...env },
    fetch: fake.fetch,
    waitUntil: (p) => {
      jobs.push(p);
    },
    now: () => NOW,
    exportProject: fakeExport,
    tmpRoot: join(dir, "tmp"),
    ...over,
  };
  return { deps, storage, storageDir, jobs, calls: fake.calls, fake, tarball };
}

function sessionFor(login: string, id: number): string {
  return `${SESSION_COOKIE}=${sealValue({ t: `tok-${login}`, id, login, av: "x", e: Date.now() + 3_600_000, r: `ref-${login}`, re: Date.now() + 86_400_000 }, SESSION_KEY)}`;
}

const ALICE = sessionFor("alice", 1);
const BOB = sessionFor("bob", 2);

function submit(repo: string, cookie?: string, origin: string | null = ORIGIN, extra: Record<string, unknown> = {}): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cookie) headers.cookie = cookie;
  if (origin !== null) headers.origin = origin;
  return new Request(`${ORIGIN}/api/index`, { method: "POST", headers, body: JSON.stringify({ repo, ...extra }) });
}

async function json(res: Response): Promise<any> {
  return res.json();
}

function getReq(path: string, cookie?: string): Request {
  return new Request(`${ORIGIN}${path}`, cookie ? { headers: { cookie } } : undefined);
}

describe("handleIndex: private repositories", () => {
  it("answers 401 auth_required for a private repo with no session", async () => {
    const h = await harness();
    const res = await handleIndex(submit("acme/secret", undefined, undefined), h.deps);
    expect(res.status).toBe(401);
    expect((await json(res)).error.code).toBe("auth_required");
    expect(h.jobs).toHaveLength(0);
  });

  it("answers 404 not_found for a missing repo when sign-in is disabled", async () => {
    const h = await harness({}, {});
    const res = await handleIndex(submit("acme/missing", undefined, undefined), h.deps);
    expect(res.status).toBe(404);
    expect((await json(res)).error.code).toBe("not_found");
  });

  it(
    "indexes a private repo for a signed-in reader: private storage only, the token only in the download",
    async () => {
      const h = await harness();
      const res = await handleIndex(submit("https://github.com/Acme/Secret", ALICE), h.deps);
      expect(res.status).toBe(202);
      expect(await json(res)).toEqual({ state: "running", repo: "acme/secret", sha: SHA, ref: "main", visibility: "private" });
      await Promise.all(h.jobs);

      const status = (await h.storage.getJson<IndexStatus>(`private/gh/acme/secret/${SHA}/status.json`)) as IndexStatus;
      expect(status.state).toBe("done");
      expect(existsSync(join(h.storageDir, "private/gh/acme/secret", "latest.json"))).toBe(true);
      expect(await h.storage.getJson(`private/gh/acme/secret/refs/main.json`)).toMatchObject({ ref: "main", sha: SHA });
      expect(await h.storage.getJson(`private/gh/acme/secret/refs/@default.json`)).toMatchObject({ sha: SHA });
      expect(await h.storage.getJson(`private/gh/acme/secret/latest.json`)).toMatchObject({ repo: "acme/secret", sha: SHA });
      expect(await h.storage.getJson(`private/gh/acme/secret/${SHA}/model.json`)).toEqual({ nodes: [] });

      // Nothing public: no recent.json, no public latest.json, no public export.
      expect(existsSync(join(h.storageDir, "meta", "recent.json"))).toBe(false);
      expect(existsSync(join(h.storageDir, "gh"))).toBe(false);

      // The download went to the API with the user's token.
      const tarball = h.calls.find((c) => c.url === `https://api.github.com/repos/acme/secret/tarball/${SHA}`);
      expect(tarball?.auth).toBe("Bearer tok-alice");

      // The token is in no stored value.
      for (const rel of listFiles(h.storageDir)) {
        const text = (await h.storage.get(rel)) ?? "";
        expect(text).not.toContain("tok-alice");
        expect(text).not.toContain("ref-alice");
      }
    },
    TIMEOUT,
  );

  it("answers 404 not_found with the install link for a private repo the user cannot read", async () => {
    const h = await harness();
    const res = await handleIndex(submit("acme/secret", BOB), h.deps);
    expect(res.status).toBe(404);
    const body = await json(res);
    expect(body.error.code).toBe("not_found");
    expect(body.error.message).toContain("was not found, or the Insight app is not installed on it");
    expect(body.error.installUrl).toBe("https://github.com/apps/insight-viewer/installations/new");
    expect(h.jobs).toHaveLength(0);
  });

  it("refuses a signed-in submission from another origin with 403 forbidden", async () => {
    const h = await harness();
    const res = await handleIndex(submit("acme/open", ALICE, "https://evil.test"), h.deps);
    expect(res.status).toBe(403);
    expect((await json(res)).error.code).toBe("forbidden");
    expect(h.jobs).toHaveLength(0);
  });

  it("refuses a signed-in submission with no Origin with 403 forbidden", async () => {
    const h = await harness();
    const res = await handleIndex(submit("acme/open", ALICE, null), h.deps);
    expect(res.status).toBe(403);
  });

  it("indexes a public repo for a signed-in user as before: public storage, no token, no visibility field", async () => {
    const h = await harness();
    const res = await handleIndex(submit("acme/open", ALICE), h.deps);
    expect(res.status).toBe(202);
    expect(await json(res)).toEqual({ state: "running", repo: "acme/open", sha: SHA, ref: "main" });
    await Promise.all(h.jobs);
    expect(existsSync(join(h.storageDir, "gh", "acme", "open", "latest.json"))).toBe(true);
    expect(existsSync(join(h.storageDir, "meta", "recent.json"))).toBe(true);
    expect(existsSync(join(h.storageDir, "private"))).toBe(false);
    const codeload = h.calls.find((c) => c.url.startsWith("https://codeload.github.com/acme/open/"));
    expect(codeload?.auth).toBeUndefined();
  });

  it("applies the per-account cap to a signed-in user, not the address", async () => {
    const h = await harness({}, { ...AUTH_ENV, INDEX_IP_DAILY_CAP: "1" });
    expect((await handleIndex(submit("acme/secret", ALICE), h.deps)).status).toBe(202);
    const again = await handleIndex(submit("acme/other", ALICE), h.deps);
    expect(again.status).toBe(429);
    const body = await json(again);
    expect(body.error.code).toBe("rate_limited");
    expect(body.error.message).toContain("this account");
    await Promise.all(h.jobs);
  });
});

describe("GET /api/status for a private index", () => {
  it("reads the private status with a session and visibility=private, and refuses without one", async () => {
    const h = await harness();
    await handleIndex(submit("acme/secret", ALICE), h.deps);
    await Promise.all(h.jobs);
    const path = `/api/status?repo=acme/secret&sha=${SHA}&visibility=private`;
    const ok = await handleStatus(getReq(path, ALICE), { storage: h.storage, env: AUTH_ENV, fetch: h.fake.fetch });
    expect(ok.status).toBe(200);
    expect((await json(ok)).state).toBe("done");
    expect(ok.headers.get("cache-control")).toBe("no-store");

    const anon = await handleStatus(getReq(path), { storage: h.storage, env: AUTH_ENV, fetch: h.fake.fetch });
    expect(anon.status).toBe(401);
    const bob = await handleStatus(getReq(path, BOB), { storage: h.storage, env: AUTH_ENV, fetch: h.fake.fetch });
    expect(bob.status).toBe(404);

    // The public status path never reads a private run.
    const publicRead = await handleStatus(getReq(`/api/status?repo=acme/secret&sha=${SHA}`), { storage: h.storage });
    expect(publicRead.status).toBe(404);
  });
});

function privateDeps(h: { storage: IndexDeps["storage"]; fake: { fetch: IndexDeps["fetch"] } }, env: Record<string, string> = AUTH_ENV): PrivateDeps {
  return { env, fetch: h.fake.fetch, now: () => NOW, storage: h.storage };
}

describe("GET /api/private/grant", () => {
  it("answers 401 auth_required with no session", async () => {
    const h = await harness();
    const res = await handleGrant(getReq(`/api/private/grant?repo=acme/secret&sha=${SHA}`), privateDeps(h));
    expect(res.status).toBe(401);
    expect((await json(res)).error.code).toBe("auth_required");
  });

  it("answers 404 not_found for a user without access", async () => {
    const h = await harness();
    const res = await handleGrant(getReq(`/api/private/grant?repo=acme/secret&sha=${SHA}`, BOB), privateDeps(h));
    expect(res.status).toBe(404);
    expect((await json(res)).error.code).toBe("not_found");
  });

  it("returns a signed base for 12 hours, which the signature check accepts", async () => {
    const h = await harness();
    const res = await handleGrant(getReq(`/api/private/grant?repo=acme/secret&sha=${SHA}`, ALICE), privateDeps(h));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await json(res);
    const exp = Math.floor(NOW / 1000) + 12 * 60 * 60;
    const prefix = `private/gh/acme/secret/${SHA}/`;
    const sig = signPrefix(SIGNING_KEY, exp, prefix);
    expect(body.base).toBe(`https://storage.test/p/${exp}/${sig}/${prefix}`);
    expect(body.expiresAt).toBe(new Date(exp * 1000).toISOString());
  });

  it("answers 404 when sign-in is not configured", async () => {
    const h = await harness({}, {});
    const res = await handleGrant(getReq(`/api/private/grant?repo=acme/secret&sha=${SHA}`, ALICE), privateDeps(h, {}));
    expect(res.status).toBe(404);
    expect((await json(res)).error.message).toBe("sign-in is not configured");
  });

  it("rejects a sha that is not a full commit id", async () => {
    const h = await harness();
    const res = await handleGrant(getReq("/api/private/grant?repo=acme/secret&sha=main", ALICE), privateDeps(h));
    expect(res.status).toBe(400);
  });
});

describe("GET /api/private/source", () => {
  it("refuses a '..' path with 400, before any GitHub call", async () => {
    const h = await harness();
    const res = await handleSource(getReq(`/api/private/source?repo=acme/secret&sha=${SHA}&path=src/../../etc/passwd`, ALICE), privateDeps(h));
    expect(res.status).toBe(400);
    expect((await json(res)).error.code).toBe("bad_request");
    expect(h.calls).toHaveLength(0);
  });

  it("refuses an absolute path with 400", async () => {
    const h = await harness();
    const res = await handleSource(getReq(`/api/private/source?repo=acme/secret&sha=${SHA}&path=/etc/passwd`, ALICE), privateDeps(h));
    expect(res.status).toBe(400);
  });

  it("returns the file's text for a reader, read at the commit as the user", async () => {
    const h = await harness();
    const res = await handleSource(getReq(`/api/private/source?repo=acme/secret&sha=${SHA}&path=src/a.ts`, ALICE), privateDeps(h));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("private, max-age=3600");
    expect(await res.text()).toBe("export const a = 1;\n");
    const call = h.calls.find((c) => c.url.includes("/contents/src/a.ts"));
    expect(call?.url).toBe(`https://api.github.com/repos/acme/secret/contents/src/a.ts?ref=${SHA}`);
    expect(call?.auth).toBe("Bearer tok-alice");
  });

  it("answers 401 with no session and 404 for a user without access", async () => {
    const h = await harness();
    const anon = await handleSource(getReq(`/api/private/source?repo=acme/secret&sha=${SHA}&path=src/a.ts`), privateDeps(h));
    expect(anon.status).toBe(401);
    const bob = await handleSource(getReq(`/api/private/source?repo=acme/secret&sha=${SHA}&path=src/a.ts`, BOB), privateDeps(h));
    expect(bob.status).toBe(404);
  });
});

describe("GET /api/private/latest and /api/private/repos", () => {
  it("returns the private latest.json to a reader, 404 to anyone else", async () => {
    const h = await harness();
    await handleIndex(submit("acme/secret", ALICE), h.deps);
    await Promise.all(h.jobs);
    const ok = await handleLatest(getReq("/api/private/latest?repo=acme/secret", ALICE), privateDeps(h));
    expect(ok.status).toBe(200);
    expect(await json(ok)).toMatchObject({ repo: "acme/secret", sha: SHA });
    expect((await handleLatest(getReq("/api/private/latest?repo=acme/secret", BOB), privateDeps(h))).status).toBe(404);
    expect((await handleLatest(getReq("/api/private/latest?repo=acme/secret"), privateDeps(h))).status).toBe(401);
  });

  it("lists the repos the app can see for the signed-in user, with the install link", async () => {
    const h = await harness();
    const res = await handleRepos(getReq("/api/private/repos", ALICE), privateDeps(h));
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.installUrl).toBe("https://github.com/apps/insight-viewer/installations/new");
    expect(body.repos).toEqual(
      expect.arrayContaining([
        { repo: "acme/secret", private: true, defaultBranch: "main" },
        { repo: "acme/open", private: false, defaultBranch: "main" },
      ]),
    );
    expect(body.repos.some((r: { repo: string }) => r.repo === "acme/other")).toBe(true);
    const installs = h.calls.find((c) => c.url.includes("/user/installations?per_page=100"));
    expect(installs?.auth).toBe("Bearer tok-alice");
  });

  it("answers 401 for the repos list with no session", async () => {
    const h = await harness();
    const res = await handleRepos(getReq("/api/private/repos"), privateDeps(h));
    expect(res.status).toBe(401);
  });
});

describe("cookie helpers used by the tests", () => {
  it("finds a named Set-Cookie value", () => {
    expect(setCookieValue(["insight_session=abc; Path=/", "x=1"], "insight_session")).toBe("abc");
  });
});

