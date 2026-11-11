import { mkdtempSync, readdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exportProject } from "@insight/export";
import {
  buildDeps,
  fsStorage,
  handleHealth,
  handleIndex,
  IMMUTABLE,
  storageFromEnv,
  type IndexDeps,
  type IndexStatus,
  writeStatus,
} from "../src/index.js";
import { FIXTURE, fakeGithub, listFiles, makeTarball, NOW, SHA, type FakeRepo } from "./helpers.js";

const SCRATCH = mkdtempSync(join(tmpdir(), "hosted-indexer-"));
const TIMEOUT = 180_000;

/** A fast stand-in for exportProject: it reports the files it was given, so the extraction is checked too. */
const fakeExport: IndexDeps["exportProject"] = async (opts) => {
  const names = listFiles(opts.root);
  const files = new Map<string, string>([
    ["project.json", JSON.stringify({ project: { name: opts.name } })],
    ["model.json", JSON.stringify({ nodes: [] })],
    ["files.json", JSON.stringify(names)],
    ["meta.json", JSON.stringify({ commit: opts.commit })],
  ]);
  return { files, meta: { capturedAt: "2026-11-11T12:00:00.000Z", commit: opts.commit ?? "unknown", nodes: 3, edges: 1, files: names.length } };
};

interface Harness {
  deps: IndexDeps;
  storage: ReturnType<typeof fsStorage>;
  jobs: Promise<unknown>[];
  calls: string[];
  dir: string;
}

let counter = 0;
/** Deps with a fresh storage folder, a scripted GitHub, and a waitUntil that collects the background jobs. */
async function harness(
  repos: Record<string, FakeRepo>,
  over: Partial<IndexDeps> = {},
  tarball?: Uint8Array,
): Promise<Harness> {
  counter += 1;
  const dir = join(SCRATCH, `case-${counter}`);
  const storage = fsStorage(join(dir, "storage"));
  const gh = fakeGithub(repos, tarball ?? (await makeTarball(FIXTURE)));
  const jobs: Promise<unknown>[] = [];
  const deps: IndexDeps = {
    storage,
    env: {},
    fetch: gh.fetch,
    waitUntil: (p) => {
      jobs.push(p);
    },
    now: () => NOW,
    exportProject: fakeExport,
    tmpRoot: join(dir, "tmp"),
    ...over,
  };
  return { deps, storage, jobs, calls: gh.calls, dir };
}

function submit(repo: unknown, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}): Request {
  return new Request("https://insight.test/api/index", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ repo, ...extra }),
  });
}

async function json(res: Response): Promise<any> {
  return res.json();
}

afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

describe("handleIndex: lookups", () => {
  it("answers 404 not_found for a missing repo", async () => {
    const h = await harness({ "acme/widget": { missing: true } });
    const res = await handleIndex(submit("acme/widget"), h.deps);
    expect(res.status).toBe(404);
    expect((await json(res)).error.code).toBe("not_found");
    expect(h.jobs).toHaveLength(0);
  });

  it("answers 404 not_found for a private repo", async () => {
    const h = await harness({ "acme/widget": { private: true } });
    const res = await handleIndex(submit("https://github.com/Acme/Widget.git"), h.deps);
    expect(res.status).toBe(404);
    expect((await json(res)).error.code).toBe("not_found");
  });

  it("answers 404 not_found for a ref that does not exist", async () => {
    const h = await harness({ "acme/widget": {} });
    const res = await handleIndex(submit("acme/widget", { ref: "no-such-ref" }), h.deps);
    expect(res.status).toBe(404);
  });

  it("answers 413 too_large when the repo is over MAX_REPO_KB", async () => {
    const h = await harness({ "acme/widget": { size: 300_001 } });
    const res = await handleIndex(submit("acme/widget"), h.deps);
    expect(res.status).toBe(413);
    expect((await json(res)).error.code).toBe("too_large");
    expect(h.jobs).toHaveLength(0);
  });

  it("honours a MAX_REPO_KB override", async () => {
    const h = await harness({ "acme/widget": { size: 5000 } }, { env: { MAX_REPO_KB: "1000" } });
    expect((await handleIndex(submit("acme/widget"), h.deps)).status).toBe(413);
  });

  it("answers 400 bad_request for input that is not a GitHub repo", async () => {
    const h = await harness({});
    const res = await handleIndex(submit("https://gitlab.com/acme/widget"), h.deps);
    expect(res.status).toBe(400);
    expect((await json(res)).error.code).toBe("bad_request");
  });

  it("answers 405 for GET", async () => {
    const h = await harness({});
    const res = await handleIndex(new Request("https://insight.test/api/index"), h.deps);
    expect(res.status).toBe(405);
  });
});

describe("handleIndex: rate limits", () => {
  it("answers 429 rate_limited once the daily total is used", async () => {
    const h = await harness({ "acme/widget": {}, "acme/other": {} }, { env: { INDEX_DAILY_CAP: "1" } });
    expect((await handleIndex(submit("acme/widget"), h.deps)).status).toBe(202);
    const res = await handleIndex(submit("acme/other"), h.deps);
    expect(res.status).toBe(429);
    expect((await json(res)).error.code).toBe("rate_limited");
    await Promise.all(h.jobs);
  });

  it("answers 429 rate_limited for an address over its per-IP cap, and not for another address", async () => {
    const h = await harness({ "acme/widget": {}, "acme/other": {}, "acme/third": {} }, { env: { INDEX_IP_DAILY_CAP: "1" } });
    expect((await handleIndex(submit("acme/widget", {}, { "x-forwarded-for": "203.0.113.7, 10.0.0.1" }), h.deps)).status).toBe(202);
    const again = await handleIndex(submit("acme/other", {}, { "x-forwarded-for": "203.0.113.7" }), h.deps);
    expect(again.status).toBe(429);
    expect((await json(again)).error.code).toBe("rate_limited");
    expect((await handleIndex(submit("acme/third", {}, { "x-real-ip": "198.51.100.2" }), h.deps)).status).toBe(202);
    await Promise.all(h.jobs);
  });
});

describe("handleIndex: dedupe", () => {
  it("returns 200 done for a commit that is already indexed, with no second job", async () => {
    const h = await harness({ "acme/widget": {} });
    await writeStatus(h.storage, "acme", "widget", SHA, {
      repo: "acme/widget", sha: SHA, ref: "main", state: "done", startedAt: "2026-11-10T00:00:00.000Z", updatedAt: "2026-11-10T00:01:00.000Z",
    });
    const res = await handleIndex(submit("acme/widget"), h.deps);
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ state: "done", repo: "acme/widget", sha: SHA });
    expect(h.jobs).toHaveLength(0);
    expect(h.calls.some((c) => c.includes("codeload"))).toBe(false);
  });

  it("returns 202 for a running job updated under 6 minutes ago, without a second job", async () => {
    const h = await harness({ "acme/widget": {} });
    await writeStatus(h.storage, "acme", "widget", SHA, {
      repo: "acme/widget", sha: SHA, ref: "main", state: "running", phase: "index", startedAt: "x", updatedAt: new Date(NOW - 60_000).toISOString(),
    });
    const res = await handleIndex(submit("acme/widget"), h.deps);
    expect(res.status).toBe(202);
    expect(await json(res)).toEqual({ state: "running", repo: "acme/widget", sha: SHA });
    expect(h.jobs).toHaveLength(0);
  });

  it("returns 200 failed for a commit that failed under an hour ago", async () => {
    const h = await harness({ "acme/widget": {} });
    await writeStatus(h.storage, "acme", "widget", SHA, {
      repo: "acme/widget", sha: SHA, ref: "main", state: "failed", startedAt: "x",
      updatedAt: new Date(NOW - 10 * 60_000).toISOString(), error: { code: "index_failed", message: "boom" },
    });
    const res = await handleIndex(submit("acme/widget"), h.deps);
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.state).toBe("failed");
    expect(body.error).toEqual({ code: "index_failed", message: "boom" });
    expect(h.jobs).toHaveLength(0);
  });
});

describe("handleIndex: the job", () => {
  it("starts a job, answers 202 at once, and finishes with a done status and the uploaded files", async () => {
    const h = await harness({ "acme/widget": {} });
    const res = await handleIndex(submit("https://github.com/Acme/Widget/tree/main"), h.deps);
    expect(res.status).toBe(202);
    expect(await json(res)).toEqual({ state: "running", repo: "acme/widget", sha: SHA });
    expect(h.jobs).toHaveLength(1);
    await Promise.all(h.jobs);

    const status = await h.storage.getJson<IndexStatus>(`gh/acme/widget/${SHA}/status.json`);
    expect(status?.state).toBe("done");
    expect(status?.error).toBeUndefined();
    expect(existsSync(join(h.dir, "tmp", SHA))).toBe(false);

    const keys = ["project.json", "model.json", "files.json", "meta.json"];
    for (const key of keys) {
      const sidecar = JSON.parse(readFileSync(join(h.dir, "storage", `gh/acme/widget/${SHA}/${key}.meta.json`), "utf8"));
      expect(sidecar.cacheControl).toBe(IMMUTABLE);
      expect(sidecar.contentEncoding).toBe("gzip");
      const raw = readFileSync(join(h.dir, "storage", `gh/acme/widget/${SHA}/${key}`));
      expect(raw[0]).toBe(0x1f);
      expect(() => JSON.parse(gunzipSync(raw).toString("utf8"))).not.toThrow();
    }
    const files = await h.storage.getJson<string[]>(`gh/acme/widget/${SHA}/files.json`);
    expect(files).toEqual(["package.json", "src/a.ts", "src/b.ts", "tsconfig.json"]);

    const latest = await h.storage.getJson<any>("gh/acme/widget/latest.json");
    expect(latest).toEqual({ repo: "acme/widget", sha: SHA, ref: "main", indexedAt: new Date(NOW).toISOString(), nodes: 3, files: 4 });
    const recent = await h.storage.getJson<any[]>("meta/recent.json");
    expect(recent).toEqual([{ repo: "acme/widget", sha: SHA, indexedAt: new Date(NOW).toISOString(), nodes: 3, files: 4 }]);
    expect(readdirSync(join(h.dir, "storage", "meta"))).toContain("daily");
  });

  it("keeps recent.json to the newest 50, one entry per repo", async () => {
    const repos: Record<string, FakeRepo> = {};
    for (let i = 0; i < 51; i += 1) repos[`acme/r${i}`] = {};
    const h = await harness(repos, { env: { INDEX_DAILY_CAP: "1000", INDEX_IP_DAILY_CAP: "1000" } });
    await h.storage.put("meta/recent.json", JSON.stringify([{ repo: "acme/r0", sha: "old", indexedAt: "x", nodes: 1, files: 1 }]), {
      contentType: "application/json",
      cacheControl: "public, max-age=60",
      gzip: true,
    });
    for (let i = 0; i < 51; i += 1) {
      await handleIndex(submit(`acme/r${i}`), h.deps);
      await Promise.all(h.jobs.splice(0));
    }
    const recent = await h.storage.getJson<{ repo: string }[]>("meta/recent.json");
    expect(recent).toHaveLength(50);
    expect(recent?.[0]?.repo).toBe("acme/r50");
    expect(recent?.filter((e) => e.repo === "acme/r0")).toHaveLength(0);
    expect(recent?.[49]?.repo).toBe("acme/r1");
  });

  it("writes failed too_large when a cap is breached", async () => {
    const h = await harness({ "acme/widget": {} }, { limits: { maxFiles: 1, maxFileBytes: 1 << 20, maxTotalBytes: 1 << 20 } });
    await handleIndex(submit("acme/widget"), h.deps);
    await Promise.all(h.jobs);
    const status = await h.storage.getJson<IndexStatus>(`gh/acme/widget/${SHA}/status.json`);
    expect(status?.state).toBe("failed");
    expect(status?.error?.code).toBe("too_large");
  });

  it("writes failed index_failed when the export throws", async () => {
    const h = await harness({ "acme/widget": {} }, { exportProject: async () => { throw new Error("parser exploded"); } });
    await handleIndex(submit("acme/widget"), h.deps);
    await Promise.all(h.jobs);
    const status = await h.storage.getJson<IndexStatus>(`gh/acme/widget/${SHA}/status.json`);
    expect(status?.error).toEqual({ code: "index_failed", message: "parser exploded" });
  });

  it("the watchdog writes failed timeout and drops later writes", async () => {
    const h = await harness({ "acme/widget": {} }, { timeoutMs: 50, exportProject: () => new Promise(() => undefined) });
    await handleIndex(submit("acme/widget"), h.deps);
    await Promise.all(h.jobs);
    const status = await h.storage.getJson<IndexStatus>(`gh/acme/widget/${SHA}/status.json`);
    expect(status?.state).toBe("failed");
    expect(status?.error?.code).toBe("timeout");
    expect(existsSync(join(h.dir, "tmp", SHA))).toBe(false);
  });

  it("runs the real exporter on the extracted tarball", async () => {
    const h = await harness({ "acme/widget": {} }, { exportProject, now: () => Date.now(), timeoutMs: 170_000 });
    const started = Date.now();
    const res = await handleIndex(submit("acme/widget"), h.deps);
    expect(res.status).toBe(202);
    await Promise.all(h.jobs);
    const status = await h.storage.getJson<IndexStatus>(`gh/acme/widget/${SHA}/status.json`);
    expect(status?.state, JSON.stringify(status)).toBe("done");
    const base = `gh/acme/widget/${SHA}/`;
    for (const key of ["project.json", "model.json", "lenses.json", "findings.json", "graph.json", "files.json", "flow-summary.json", "meta.json", "scope/@root/lenses.json", "scope/@root/arch.json"]) {
      expect(existsSync(join(h.dir, "storage", base, key)), key).toBe(true);
    }
    const latest = await h.storage.getJson<any>("gh/acme/widget/latest.json");
    expect(latest.sha).toBe(SHA);
    expect(latest.nodes).toBeGreaterThan(0);
    expect(Date.now() - started).toBeLessThan(170_000);
    expect(listFiles(join(h.dir, "storage"))).toContain(`gh/acme/widget/${SHA}/project.json`);
  }, TIMEOUT);
});

describe("handleHealth and the environment wiring", () => {
  it("reports the storage kind", async () => {
    const h = await harness({});
    const res = handleHealth({ storage: h.storage });
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ ok: true, storage: "fs" });
  });

  it("picks R2 when R2_* is set, the folder when only INSIGHT_STORAGE_DIR is", () => {
    expect(storageFromEnv({ INSIGHT_STORAGE_DIR: "/tmp/x" }).kind).toBe("fs");
    expect(
      storageFromEnv({ R2_ACCOUNT_ID: "a", R2_ACCESS_KEY_ID: "k", R2_SECRET_ACCESS_KEY: "s", R2_BUCKET: "b" }).kind,
    ).toBe("r2");
    expect(() => storageFromEnv({ R2_ACCOUNT_ID: "a" })).toThrow(/R2_ACCESS_KEY_ID/);
    expect(() => storageFromEnv({})).toThrow();
    expect(buildDeps({ INSIGHT_STORAGE_DIR: "/tmp/x" }).tmpRoot).toBe("/tmp/insight");
  });
});

describe("handleIndex: contract shapes", () => {
  it("answers 400 bad_request for a body that is not JSON, or a repo that is not a string", async () => {
    const h = await harness({ "acme/widget": {} });
    const broken = new Request("https://insight.test/api/index", { method: "POST", body: "not json" });
    const res = await handleIndex(broken, h.deps);
    expect(res.status).toBe(400);
    expect((await json(res)).error.code).toBe("bad_request");
    const typed = await handleIndex(submit(42), h.deps);
    expect(typed.status).toBe(400);
    expect((await json(typed)).error.code).toBe("bad_request");
    expect(h.jobs).toHaveLength(0);
  });

  it("answers 502 upstream_error when GitHub fails (not a 404)", async () => {
    const h = await harness({ "acme/widget": {} }, {
      fetch: async () => new Response("boom", { status: 500 }),
    });
    const res = await handleIndex(submit("acme/widget"), h.deps);
    expect(res.status).toBe(502);
    expect((await json(res)).error.code).toBe("upstream_error");
    expect(h.jobs).toHaveLength(0);
  });

  it("writes the initial status as running with phase queued before the job starts", async () => {
    const h = await harness({ "acme/widget": {} });
    const res = await handleIndex(submit("acme/widget"), h.deps);
    expect(res.status).toBe(202);
    const { sha } = await json(res);
    const status = await h.storage.getJson<IndexStatus>(`gh/acme/widget/${sha}/status.json`);
    expect(status).toMatchObject({ state: "running", phase: "queued", repo: "acme/widget", sha });
    await Promise.all(h.jobs);
  });

  it("writes latest.json and recent.json gzipped, with recent.json an array", async () => {
    const h = await harness({ "acme/widget": {} });
    await handleIndex(submit("acme/widget"), h.deps);
    await Promise.all(h.jobs);
    for (const key of ["gh/acme/widget/latest.json", "meta/recent.json"]) {
      const meta = JSON.parse(readFileSync(join(h.dir, "storage", `${key}.meta.json`), "utf8"));
      expect(meta).toMatchObject({ contentType: "application/json", cacheControl: "public, max-age=60", contentEncoding: "gzip" });
      expect(gunzipSync(readFileSync(join(h.dir, "storage", key))).length).toBeGreaterThan(0);
    }
    const recent = await h.storage.getJson<unknown[]>("meta/recent.json");
    expect(Array.isArray(recent)).toBe(true);
    expect(recent).toHaveLength(1);
  });
});
