import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleCoupling } from "../src/index.js";
import { fsStorage, type Storage } from "../src/storage.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const OTHER = "fedcba9876543210fedcba9876543210fedcba98";
const KEY = `gh/acme/widget/${SHA}/graph.json`;

// The minimal graph.json the export writes: two packages, apps/app calls libs/util. The coupling route builds its index
// from this graph, exactly as the local server builds one from a snapshot.
const graph = {
  snapshot: SHA,
  nodes: [
    { id: "package.json", facet: "structure", kind: "structure.file", attrs: { path: "package.json" }, provenance: { frontend: "core", confidence: "exact" } },
    { id: "libs/util/package.json", facet: "structure", kind: "structure.file", attrs: { path: "libs/util/package.json" }, provenance: { frontend: "core", confidence: "exact" } },
    { id: "apps/app/package.json", facet: "structure", kind: "structure.file", attrs: { path: "apps/app/package.json" }, provenance: { frontend: "core", confidence: "exact" } },
    {
      id: "apps/app/src/main.ts#run",
      facet: "structure",
      kind: "structure.function",
      attrs: { name: "run", qualifiedName: "run", exported: true },
      span: { file: "apps/app/src/main.ts", start: [1, 0], end: [5, 1] },
      provenance: { frontend: "frontend-typescript", confidence: "exact" },
    },
    {
      id: "libs/util/src/u.ts#local",
      facet: "structure",
      kind: "structure.function",
      attrs: { name: "local", qualifiedName: "local", exported: true },
      span: { file: "libs/util/src/u.ts", start: [3, 0], end: [5, 1] },
      provenance: { frontend: "frontend-typescript", confidence: "exact" },
    },
    { id: "apps/app/src/main.ts", facet: "structure", kind: "structure.file", attrs: { path: "apps/app/src/main.ts" }, provenance: { frontend: "core", confidence: "exact" } },
    { id: "libs/util/src/u.ts", facet: "structure", kind: "structure.file", attrs: { path: "libs/util/src/u.ts" }, provenance: { frontend: "core", confidence: "exact" } },
  ],
  edges: [
    {
      from: "apps/app/src/main.ts#run",
      to: "libs/util/src/u.ts#local",
      facet: "calls",
      kind: "calls.call",
      attrs: { callee: "local" },
      span: { file: "apps/app/src/main.ts", start: [3, 9], end: [3, 16] },
      provenance: { frontend: "frontend-typescript", confidence: "exact" },
    },
  ],
};

describe("GET /api/coupling on the hosted Function", () => {
  let storage: Storage;
  let dir: string;

  const get = (query: string) => new Request(`https://insight.test/api/coupling?${query}`);

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "hosted-coupling-"));
    storage = fsStorage(dir);
    await storage.put(KEY, JSON.stringify(graph), { contentType: "application/json", cacheControl: "no-store" });
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("returns the same report shape as the local server for a file scope", async () => {
    const res = await handleCoupling(get(`repo=acme/widget&sha=${SHA}&scope=apps/app/src/main.ts`), { storage });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { functions: { id: string; name: string; module: string; cross: unknown[] }[] };
    expect(Object.keys(body)).toEqual(["functions"]);
    expect(body.functions).toHaveLength(1);
    expect(body.functions[0]).toMatchObject({ id: "apps/app/src/main.ts#run", name: "run", module: "apps/app" });
    expect(body.functions[0]?.cross).toEqual([
      { label: "local()", target: "libs/util/src/u.ts#local", file: "libs/util/src/u.ts", line: 4 },
    ]);
  });

  it("defaults to the whole project and takes fn=", async () => {
    const all = await handleCoupling(get(`repo=acme/widget&sha=${SHA}`), { storage });
    expect(all.status).toBe(200);
    expect(((await all.json()) as { functions: { id: string }[] }).functions.map((f) => f.id)).toEqual([
      "apps/app/src/main.ts#run",
      "libs/util/src/u.ts#local",
    ]);
    const one = await handleCoupling(get(`repo=acme/widget&sha=${SHA}&fn=${encodeURIComponent("libs/util/src/u.ts#local")}`), { storage });
    expect(one.status).toBe(200);
    expect(((await one.json()) as { functions: { id: string }[] }).functions.map((f) => f.id)).toEqual(["libs/util/src/u.ts#local"]);
  });

  it("answers 404 for an unknown scope, an unknown function, and an unindexed commit", async () => {
    const scope = await handleCoupling(get(`repo=acme/widget&sha=${SHA}&scope=apps/nope`), { storage });
    expect(scope.status).toBe(404);
    expect(((await scope.json()) as { error: { code: string } }).error.code).toBe("not_found");
    const fn = await handleCoupling(get(`repo=acme/widget&sha=${SHA}&fn=${encodeURIComponent("apps/app/src/main.ts#nope")}`), { storage });
    expect(fn.status).toBe(404);
    const missing = await handleCoupling(get(`repo=acme/widget&sha=${OTHER}`), { storage });
    expect(missing.status).toBe(404);
  });

  it("validates the request", async () => {
    expect((await handleCoupling(get(`repo=acme/widget&sha=nope`), { storage })).status).toBe(400);
    expect((await handleCoupling(get(`repo=widget&sha=${SHA}`), { storage })).status).toBe(400);
    const post = await handleCoupling(
      new Request(`https://insight.test/api/coupling?repo=acme/widget&sha=${SHA}`, { method: "POST" }),
      { storage },
    );
    expect(post.status).toBe(405);
  });

  it("rejects an out-of-project or absolute scope even when fn= is present", async () => {
    for (const scope of ["../outside", "/apps"]) {
      const bare = await handleCoupling(get(`repo=acme/widget&sha=${SHA}&scope=${encodeURIComponent(scope)}`), { storage });
      expect(bare.status).toBe(400);
      expect(((await bare.json()) as { error: { code: string } }).error.code).toBe("bad_request");
      const withFn = await handleCoupling(
        get(`repo=acme/widget&sha=${SHA}&scope=${encodeURIComponent(scope)}&fn=${encodeURIComponent("apps/app/src/main.ts#run")}`),
        { storage },
      );
      expect(withFn.status).toBe(400);
    }
    const absolute = await handleCoupling(get(`repo=acme/widget&sha=${SHA}&scope=%2Fapps`), { storage });
    expect(((await absolute.json()) as { error: { message: string } }).error.message).toMatch(/must be relative to the project/);
    const outside = await handleCoupling(get(`repo=acme/widget&sha=${SHA}&scope=..%2Foutside`), { storage });
    expect(((await outside.json()) as { error: { message: string } }).error.message).toMatch(/must not leave the project/);
  });

  it("serves a repeated repo+sha from its cached index without downloading the graph again", async () => {
    const sha = "ab".repeat(20);
    const key = `gh/acme/widget/${sha}/graph.json`;
    await storage.put(key, JSON.stringify({ ...graph, snapshot: sha }), { contentType: "application/json", cacheControl: "no-store" });
    let reads = 0;
    const counted: Storage = {
      kind: storage.kind,
      put: (k, body, opts) => storage.put(k, body, opts),
      get: (k) => storage.get(k),
      async getJson<T>(k: string) {
        reads += 1;
        return storage.getJson<T>(k);
      },
    };
    const first = await handleCoupling(get(`repo=acme/widget&sha=${sha}`), { storage: counted });
    expect(first.status).toBe(200);
    expect(reads).toBe(1);
    const second = await handleCoupling(get(`repo=acme/widget&sha=${sha}&scope=apps%2Fapp%2Fsrc%2Fmain.ts`), { storage: counted });
    expect(second.status).toBe(200);
    expect(((await second.json()) as { functions: { id: string }[] }).functions.map((f) => f.id)).toEqual([
      "apps/app/src/main.ts#run",
    ]);
    expect(reads).toBe(1);
  });
});
