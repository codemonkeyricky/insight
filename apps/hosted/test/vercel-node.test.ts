import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fsStorage } from "../src/storage.js";
import { nodeHandler } from "../src/vercel-node.js";

const SCRATCH = mkdtempSync(join(tmpdir(), "hosted-node-"));
let server: Server;
let origin = "";

beforeAll(async () => {
  process.env.INSIGHT_STORAGE_DIR = join(SCRATCH, "storage");
  delete process.env.R2_ACCOUNT_ID;
  const handler = nodeHandler();
  server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

afterAll(() => {
  server.close();
  rmSync(SCRATCH, { recursive: true, force: true });
});

describe("node entry for the Vercel Functions", () => {
  it("answers GET /api/health from the folder storage", async () => {
    const res = await fetch(`${origin}/api/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, storage: "fs" });
  });

  it("passes a POST body through and returns the handler's coded error", async () => {
    const res = await fetch(`${origin}/api/index`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo: "https://gitlab.com/acme/widget" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("bad_request");
  });

  it("routes by the route parameter, so the rewritten paths reach the same function", async () => {
    const health = await fetch(`${origin}/api/anything?route=health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true, storage: "fs" });
    const status = await fetch(`${origin}/api/anything?route=status&repo=acme%2Fwidget&sha=${"0".repeat(40)}`);
    expect(status.status).toBe(404);
    expect((await status.json()).error.code).toBe("not_found");
  });

  it("serves /api/coupling by path and by the rewritten route parameter", async () => {
    const sha = "cd".repeat(20);
    const storage = fsStorage(join(SCRATCH, "storage"));
    await storage.put(
      `gh/acme/widget/${sha}/graph.json`,
      JSON.stringify({
        snapshot: sha,
        nodes: [
          { id: "apps/app/src/main.ts", facet: "structure", kind: "structure.file", attrs: { path: "apps/app/src/main.ts" }, provenance: { frontend: "core", confidence: "exact" } },
          {
            id: "apps/app/src/main.ts#run",
            facet: "structure",
            kind: "structure.function",
            attrs: { name: "run", qualifiedName: "run" },
            span: { file: "apps/app/src/main.ts", start: [0, 0], end: [1, 1] },
            provenance: { frontend: "frontend-typescript", confidence: "exact" },
          },
        ],
        edges: [],
      }),
      { contentType: "application/json", cacheControl: "no-store" },
    );
    const direct = await fetch(`${origin}/api/coupling?repo=acme/widget&sha=${sha}`);
    expect(direct.status).toBe(200);
    expect(((await direct.json()) as { functions: { id: string }[] }).functions.map((f) => f.id)).toEqual([
      "apps/app/src/main.ts#run",
    ]);
    // The Vercel rewrites pass ?route=coupling and keep the original path and query string.
    const rewritten = await fetch(`${origin}/api/anything?route=coupling&repo=acme/widget&sha=${sha}`);
    expect(rewritten.status).toBe(200);
    expect(((await rewritten.json()) as { functions: { id: string }[] }).functions.map((f) => f.id)).toEqual([
      "apps/app/src/main.ts#run",
    ]);
  });

  it("answers 404 for a path that is no route", async () => {
    const res = await fetch(`${origin}/api/nope`);
    expect(res.status).toBe(404);
  });

  it("installs the request context that @vercel/functions reads", async () => {
    const global = globalThis as unknown as Record<symbol, { get: () => { waitUntil?: unknown } }>;
    expect(global[Symbol.for("@vercel/request-context")]?.get().waitUntil).toBeTypeOf("function");
  });
});
