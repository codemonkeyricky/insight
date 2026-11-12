import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { PhaseEvent } from "@insight/export";
import {
  fsStorage,
  handleIndex,
  handleStatus,
  observedStorage,
  writeStatus,
  type IndexDeps,
  type IndexStatus,
  type Storage,
} from "../src/index.js";
import { FIXTURE, fakeGithub, makeTarball, NOW, SHA, type FakeRepo } from "./helpers.js";

const SCRATCH = mkdtempSync(join(tmpdir(), "hosted-budget-"));
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

let counter = 0;

/** An export that writes 17 files (the size of a real Insight export) and reports the exporter's phases. */
function clockedExport(clock: { t: number }, events: (emit: (p: PhaseEvent) => void) => void): IndexDeps["exportProject"] {
  return async (opts) => {
    events((p) => {
      opts.onPhase?.(p);
      clock.t += 1000;
    });
    const files = new Map<string, string>();
    for (let i = 0; i < 17; i += 1) files.set(`part-${i}.json`, JSON.stringify({ i }));
    return { files, meta: { capturedAt: new Date(clock.t).toISOString(), commit: SHA, nodes: 3, edges: 1, files: 17 } };
  };
}

const SIX_PHASES = (emit: (p: PhaseEvent) => void) => {
  for (const phase of ["scan", "extract", "link", "analyze", "save"]) emit({ phase: phase as PhaseEvent["phase"] });
};

/** Deps over a folder store that records every put, a scripted GitHub and a clock the test moves. */
async function setup(repos: Record<string, FakeRepo>, over: { kind?: "kv" | "fs"; events?: typeof SIX_PHASES; env?: Record<string, string> } = {}) {
  counter += 1;
  const dir = join(SCRATCH, `case-${counter}`);
  const puts: string[] = [];
  const inner = fsStorage(join(dir, "storage"));
  const store: Storage = over.kind === "kv" ? { ...inner, kind: "kv" as const } : inner;
  const storage: Storage = observedStorage(store, (key) => puts.push(key));
  const gh = fakeGithub(repos, await makeTarball(FIXTURE));
  const clock = { t: NOW };
  const jobs: Promise<unknown>[] = [];
  const deps: IndexDeps = {
    storage,
    env: over.env ?? {},
    fetch: gh.fetch,
    waitUntil: (p) => {
      jobs.push(p);
    },
    now: () => clock.t,
    exportProject: clockedExport(clock, over.events ?? SIX_PHASES),
    tmpRoot: join(dir, "tmp"),
  };
  return { deps, storage, puts, jobs, dir };
}

function submit(repo: string, ip = "198.51.100.9"): Request {
  return new Request("https://insight.test/api/index", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify({ repo }),
  });
}

describe("status writes: the KV write budget", () => {
  it("a fixture index run performs at most 30 storage puts in total", async () => {
    const h = await setup({ "acme/widget": {} });
    const res = await handleIndex(submit("acme/widget"), h.deps);
    expect(res.status).toBe(202);
    await Promise.all(h.jobs);
    const status = await h.storage.getJson<IndexStatus>(`gh/acme/widget/${SHA}/status.json`);
    expect(status?.state).toBe("done");
    expect(h.puts.length, h.puts.join("\n")).toBeLessThanOrEqual(30);
    // 17 export files, latest.json, recent.json, the daily counter, and the status writes.
    const statusPuts = h.puts.filter((key) => key.endsWith("status.json"));
    expect(statusPuts.length).toBeLessThanOrEqual(8);
  });

  it("writes status only on phase changes, and at most one progress write per 3 s", async () => {
    // Every event lands at the same instant, so only the queued and the final writes can happen.
    const h = await setup({ "acme/widget": {} }, { events: (emit) => { for (let i = 0; i < 200; i += 1) emit({ phase: i % 2 ? "scan" : "extract", done: i, total: 200 }); } });
    const clockFixed = { ...h.deps, now: () => NOW };
    await handleIndex(submit("acme/widget"), clockFixed);
    await Promise.all(h.jobs);
    const statusPuts = h.puts.filter((key) => key.endsWith("status.json"));
    expect(statusPuts).toHaveLength(2);
  });

  it("writes a progress status for each phase change that is 3 s or more after the last write", async () => {
    const h = await setup({ "acme/widget": {} }, { events: (emit) => { for (const phase of ["scan", "extract", "link", "analyze", "save"]) for (let i = 0; i < 4; i += 1) emit({ phase: phase as PhaseEvent["phase"], done: i, total: 4 }); } });
    await handleIndex(submit("acme/widget"), h.deps);
    await Promise.all(h.jobs);
    const statusPuts = h.puts.filter((key) => key.endsWith("status.json"));
    // queued, then progress writes no closer than 3 s apart (the clock advances 1 s per event), then done.
    expect(statusPuts.length).toBeGreaterThan(2);
    expect(statusPuts.length).toBeLessThanOrEqual(2 + 20 / 3 + 1);
  });
});

describe("the daily cap with Workers KV", () => {
  it("defaults to 25 indexes a day when the storage is KV", async () => {
    const repos: Record<string, FakeRepo> = {};
    for (let i = 0; i <= 25; i += 1) repos[`acme/r${i}`] = {};
    const h = await setup(repos, { kind: "kv", env: { INDEX_IP_DAILY_CAP: "1000" } });
    const statuses: number[] = [];
    for (let i = 0; i <= 25; i += 1) {
      const res = await handleIndex(submit(`acme/r${i}`), h.deps);
      statuses.push(res.status);
      await Promise.all(h.jobs.splice(0));
    }
    expect(statuses.slice(0, 25).every((s) => s === 202)).toBe(true);
    expect(statuses[25]).toBe(429);
    const last = await handleIndex(submit("acme/r25"), h.deps);
    expect((await last.json()).error.code).toBe("rate_limited");
  }, 120_000);

  it("INDEX_DAILY_CAP still overrides the KV default", async () => {
    const h = await setup({ "acme/a": {}, "acme/b": {} }, { kind: "kv", env: { INDEX_DAILY_CAP: "1", INDEX_IP_DAILY_CAP: "1000" } });
    expect((await handleIndex(submit("acme/a"), h.deps)).status).toBe(202);
    await Promise.all(h.jobs.splice(0));
    expect((await handleIndex(submit("acme/b"), h.deps)).status).toBe(429);
  });
});

describe("handleStatus: GET /api/status", () => {
  const status: IndexStatus = {
    repo: "acme/widget",
    sha: SHA,
    ref: "main",
    state: "running",
    phase: "scan",
    done: 2,
    total: 9,
    startedAt: "2026-11-11T12:00:00.000Z",
    updatedAt: "2026-11-11T12:00:01.000Z",
  };

  async function seeded() {
    counter += 1;
    const storage = fsStorage(join(SCRATCH, `status-${counter}`));
    await writeStatus(storage, "acme", "widget", SHA, status);
    return { storage };
  }

  const get = (query: string) => new Request(`https://insight.test/api/status?${query}`);

  it("answers the stored status, never cached", async () => {
    const { storage } = await seeded();
    const res = await handleStatus(get(`repo=Acme%2FWidget&sha=${SHA}`), { storage });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual(status);
  });

  it("answers 400 for a missing or malformed repo, a ref on the repo, or a bad sha", async () => {
    const { storage } = await seeded();
    const cases = [
      `sha=${SHA}`,
      `repo=acme&sha=${SHA}`,
      `repo=acme%2Fwidget%2Fx&sha=${SHA}`,
      `repo=${encodeURIComponent("https://github.com/acme/widget/tree/main")}&sha=${SHA}`,
      "repo=acme%2Fwidget",
      "repo=acme%2Fwidget&sha=main",
      `repo=acme%2Fwidget&sha=${SHA.toUpperCase()}`,
    ];
    for (const query of cases) {
      const res = await handleStatus(get(query), { storage });
      expect(res.status, query).toBe(400);
      expect((await res.json()).error.code).toBe("bad_request");
    }
  });

  it("answers 404 when no run has written a status for the commit", async () => {
    const { storage } = await seeded();
    const res = await handleStatus(get(`repo=acme%2Fwidget&sha=${"f".repeat(40)}`), { storage });
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("not_found");
  });

  it("answers 405 for anything but GET", async () => {
    const { storage } = await seeded();
    const res = await handleStatus(new Request(`https://insight.test/api/status?repo=acme%2Fwidget&sha=${SHA}`, { method: "POST" }), { storage });
    expect(res.status).toBe(405);
  });
});
