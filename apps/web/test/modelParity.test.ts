// The browser's scope payloads must equal the server's. This indexes this repository with the real server, then
// asks the live api (through its fetch calls, answered by the server in-process) and the demo api (fed the model the
// demo capture would write) for the same scopes, and compares each answer with the server route's JSON.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { api } from "../src/api";
import { staticApi } from "../src/staticApi";
// The server is not a web dependency; its built output is the same code the app runs. Run `pnpm build` first.
import { buildServer, type InsightServer } from "../../server/dist/index.js";

const REPO = resolve(import.meta.dirname, "..", "..", "..");
const SCOPES = ["", "packages/flow", "packages/core/src/scope.ts"];

describe("browser scope payloads equal the server's", () => {
  let server: InsightServer;
  let home: string;
  let id: string;
  const realFetch = globalThis.fetch;
  /** Calls the live api made for a model, so the test can check it asked once. */
  const modelCalls: string[] = [];

  const serverJson = async <T>(url: string): Promise<T> => {
    const res = await server.app.inject({ method: "GET", url });
    if (res.statusCode !== 200) throw new Error(`${url} -> ${res.statusCode} ${res.body}`);
    return res.json() as T;
  };

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "insight-parity-"));
    server = await buildServer({ home, intervalMs: 0, webDist: null, autostart: false });
    const added = await server.app.inject({ method: "POST", url: "/api/projects", payload: { path: REPO, name: "parity", allowBuildTools: false } });
    id = (added.json() as { project: { id: string } }).project.id;
    server.jobs.trigger(id, { full: true });
    await server.jobs.whenIdle(id);
    // The live api calls fetch with paths under /api; answer those from the in-process server.
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (!url.startsWith("/api/")) return realFetch(input, init);
      if (url.endsWith("/model")) modelCalls.push(url);
      const res = await server.app.inject({ method: init?.method ?? "GET", url });
      return new Response(res.body, { status: res.statusCode, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
  }, 900_000);

  afterAll(async () => {
    globalThis.fetch = realFetch;
    await server.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("the live api computes the flow and exec of each scope from one model", async () => {
    for (const scope of SCOPES) {
      const q = `?path=${encodeURIComponent(scope)}`;
      expect(await api.scopeFlow(id, scope), `flow ${scope}`).toEqual(await serverJson(`/api/projects/${id}/scope/flow${q}`));
      expect(await api.getScopeExec(id, scope), `exec ${scope}`).toEqual(await serverJson(`/api/projects/${id}/scope/exec${q}`));
    }
    expect(modelCalls).toHaveLength(1);
    // The comparison means something only when the scopes have functions to compare.
    expect((await api.scopeFlow(id, "packages/flow")).stats.functions).toBeGreaterThan(0);
    expect((await api.getScopeExec(id, "packages/flow")).functions.length).toBeGreaterThan(0);
  }, 600_000);

  it("the live api computes the reverse references of a function from the model, as the refs route answers them", async () => {
    const fnId = (await api.getScopeExec(id, "packages/model")).functions.find((f) => f.name === "inScope")?.id;
    expect(fnId, "a function named inScope in packages/model").toBeDefined();
    const q = `?path=packages/model&id=${encodeURIComponent(fnId!)}`;
    const refs = await api.getRefs(id, "packages/model", fnId!);
    expect(refs).toEqual(await serverJson(`/api/projects/${id}/refs${q}`));
    // inScope is called from outside its own folder, so the list names a caller outside the scope.
    expect(refs.calledBy.some((r) => !r.inScope)).toBe(true);
    expect(modelCalls).toHaveLength(1);
  }, 600_000);

  it("the live api names the same error as the server for a scope that leaves the project", async () => {
    const server400 = await server.app.inject({ method: "GET", url: `/api/projects/${id}/scope/flow?path=${encodeURIComponent("../x")}` });
    await expect(api.scopeFlow(id, "../x")).rejects.toMatchObject({ status: 400, message: server400.json().error });
  });

  it("the demo api computes the same payloads from the demo's model.json", async () => {
    // What the capture writes: the server's model route, as JSON text. The demo fetches it under /demo/.
    const modelText = JSON.stringify(await serverJson(`/api/projects/${id}/model`));
    const projectText = JSON.stringify({ project: { id }, overview: {} });
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/demo/model.json")) return new Response(modelText, { headers: { "content-type": "application/json" } });
      if (url.endsWith("/demo/project.json")) return new Response(projectText, { headers: { "content-type": "application/json" } });
      return new Response("missing", { status: 404, headers: { "content-type": "text/html" } });
    }) as typeof fetch;
    try {
      for (const scope of SCOPES) {
        const q = `?path=${encodeURIComponent(scope)}`;
        expect(await staticApi.scopeFlow(id, scope), `demo flow ${scope}`).toEqual(await serverJson(`/api/projects/${id}/scope/flow${q}`));
        expect(await staticApi.getScopeExec(id, scope), `demo exec ${scope}`).toEqual(await serverJson(`/api/projects/${id}/scope/exec${q}`));
      }
      const fnId = (await staticApi.getScopeExec(id, "packages/model")).functions.find((f) => f.name === "inScope")?.id ?? "";
      expect(await staticApi.getRefs(id, "packages/model", fnId), "demo refs").toEqual(
        await serverJson(`/api/projects/${id}/refs?path=packages/model&id=${encodeURIComponent(fnId)}`),
      );
    } finally {
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (!url.startsWith("/api/")) return realFetch(input, init);
        const res = await server.app.inject({ method: init?.method ?? "GET", url });
        return new Response(res.body, { status: res.statusCode, headers: { "content-type": "application/json" } });
      }) as typeof fetch;
    }
  }, 600_000);
});
