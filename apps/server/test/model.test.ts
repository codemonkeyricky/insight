import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadModel, MODEL_SCHEMA, scopeView, type SerializedModel } from "@insight/model";
import { buildServer, type InsightServer } from "../src/index.js";

// The whole-project model route. Its own scratch folder, so it does not race the other route tests.
const SCRATCH = resolve(import.meta.dirname, "..", ".insight-test-model");
const PROJECT = join(SCRATCH, "proj");
const BARE = join(SCRATCH, "bare");
const HOME = join(SCRATCH, "home");

function writeProject(dir: string): void {
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "lib"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "model", version: "0.0.0", private: true }));
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true }, include: ["src", "lib"] }),
  );
  writeFileSync(join(dir, "src/a.ts"), `import { b } from "./b.js";\nimport { c } from "../lib/c.js";\nexport function a(): number {\n  return b() + c();\n}\n`);
  writeFileSync(join(dir, "src/b.ts"), `import { a } from "./a.js";\nexport function b(): number {\n  return 2;\n}\nexport const d = () => a();\n`);
  writeFileSync(join(dir, "lib/c.ts"), `export function c(): number {\n  return 3;\n}\n`);
}

describe("the model route", () => {
  let server: InsightServer;
  let id: string;
  let bareId: string;

  const get = async <T>(url: string): Promise<{ status: number; body: T }> => {
    const res = await server.app.inject({ method: "GET", url });
    return { status: res.statusCode, body: res.json() as T };
  };

  beforeAll(async () => {
    rmSync(SCRATCH, { recursive: true, force: true });
    writeProject(PROJECT);
    writeProject(BARE);
    server = await buildServer({ home: HOME, intervalMs: 0, webDist: null, autostart: false });
    const added = await server.app.inject({ method: "POST", url: "/api/projects", payload: { path: PROJECT, name: "Model" } });
    id = (added.json() as { project: { id: string } }).project.id;
    const bare = await server.app.inject({ method: "POST", url: "/api/projects", payload: { path: BARE, name: "Bare", index: false } });
    bareId = (bare.json() as { project: { id: string } }).project.id;
    server.jobs.trigger(id);
    await server.jobs.whenIdle(id);
  }, 120_000);

  afterAll(async () => {
    await server.close();
    rmSync(SCRATCH, { recursive: true, force: true });
  });

  it("serves the model of the latest snapshot, with its schema and snapshot id", async () => {
    const flow = await get<{ snapshot: string }>(`/api/projects/${id}/scope/flow?path=`);
    const model = await get<SerializedModel>(`/api/projects/${id}/model`);
    expect(model.status).toBe(200);
    expect(model.body.schema).toBe(MODEL_SCHEMA);
    expect(model.body.snapshot).toBe(flow.body.snapshot);
    expect(model.body.doc.nodes.length).toBeGreaterThan(0);
    expect(model.body.doc.edges.length).toBeGreaterThan(0);
  });

  it("serves a model whose scope views match the scope listing the server computes", async () => {
    const model = loadModel((await get<SerializedModel>(`/api/projects/${id}/model`)).body);
    for (const scope of ["", "src", "lib/c.ts"]) {
      const listing = await get<{ stats: unknown }>(`/api/projects/${id}/scope/lenses?path=${encodeURIComponent(scope)}`);
      expect(listing.status, scope).toBe(200);
      expect(scopeView(model, scope).toDoc().stats, scope).toEqual(listing.body.stats);
    }
  });

  it("answers the same errors as the scope routes, in the same order", async () => {
    expect((await get<{ error: string }>(`/api/projects/${id}/model?snapshot=nope`)).body.error).toBe("unknown snapshot nope");
    expect((await get<{ error: string }>(`/api/projects/${id}/scope/flow?path=src&snapshot=nope`)).body.error).toBe("unknown snapshot nope");
    const bare = await get<{ error: string }>(`/api/projects/${bareId}/model`);
    expect(bare.status).toBe(404);
    expect(bare.body.error).toBe("project has no snapshot yet");
    const bareScope = await get<{ error: string }>(`/api/projects/${bareId}/scope/flow?path=`);
    expect(bareScope.body.error).toBe(bare.body.error);
    expect((await get(`/api/projects/nope/model`)).status).toBe(404);
  });

  it("serves a pinned snapshot by its id", async () => {
    const latest = await get<SerializedModel>(`/api/projects/${id}/model`);
    const pinned = await get<SerializedModel>(`/api/projects/${id}/model?snapshot=${latest.body.snapshot}`);
    expect(pinned.status).toBe(200);
    expect(pinned.body).toEqual(latest.body);
  });
});
