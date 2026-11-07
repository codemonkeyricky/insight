import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildServer, type InsightServer } from "../src/index.js";

// The scoped IR routes against a real index. This file has its own scratch folder, so it does not
// race server.test.ts, which removes its own scratch folder when it ends.
const SCRATCH = resolve(import.meta.dirname, "..", ".insight-test-scope");
const PROJECT = join(SCRATCH, "proj");
const BARE = join(SCRATCH, "bare");
const HOME = join(SCRATCH, "home");

interface Listing {
  snapshot: string;
  scope: string;
  kind: string;
  stats: { nodes: number; edges: number; findings: number; external: number };
  facets: string[];
  lenses: { id: string; title: string; status: string; reason?: string; findings: number | null }[];
}

interface ScopedRun {
  snapshot: string;
  scope: string;
  kind: string;
  lens: {
    id: string;
    status: string;
    reason?: string;
    reused: boolean;
    inputsHash: string;
    result?: { findings: { message: string }[] };
  };
}

/** Three files: a.ts and b.ts import each other inside src, and a.ts also imports lib/c.ts, which is outside src. */
function writeProject(dir: string): void {
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "lib"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "scoped", version: "0.0.0", private: true }));
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true }, include: ["src", "lib"] }),
  );
  writeFileSync(join(dir, "src/a.ts"), `import { b } from "./b.js";\nimport { c } from "../lib/c.js";\nexport function a(): number {\n  return b() + c();\n}\n`);
  writeFileSync(join(dir, "src/b.ts"), `import { a } from "./a.js";\nexport function b(): number {\n  return 2;\n}\nexport const d = () => a();\n`);
  writeFileSync(join(dir, "lib/c.ts"), `export function c(): number {\n  return 3;\n}\n`);
}

describe("scoped IR routes", () => {
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
    const added = await server.app.inject({ method: "POST", url: "/api/projects", payload: { path: PROJECT, name: "Scoped" } });
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

  it("answers 400 when the path is missing or given twice", async () => {
    const missing = await get<{ error: string }>(`/api/projects/${id}/scope/lenses`);
    expect(missing.status).toBe(400);
    expect(missing.body.error).toBe("path is required");
    const lensMissing = await get<{ error: string }>(`/api/projects/${id}/scope/lenses/lens-calls`);
    expect(lensMissing.status).toBe(400);
    expect(lensMissing.body.error).toBe("path is required");
    const twice = await get<{ error: string }>(`/api/projects/${id}/scope/lenses?path=src&path=lib`);
    expect(twice.status).toBe(400);
  });

  it("answers 400 for a path that leaves the project", async () => {
    for (const path of ["../outside", "/etc", "src/../../x"]) {
      const res = await get<{ error: string }>(`/api/projects/${id}/scope/lenses?path=${encodeURIComponent(path)}`);
      expect(res.status, path).toBe(400);
    }
  });

  it("answers 404 for a path with no indexed file under it", async () => {
    for (const path of ["nope", "src/a.ts/x", "docs"]) {
      const res = await get<{ error: string }>(`/api/projects/${id}/scope/lenses?path=${encodeURIComponent(path)}`);
      expect(res.status, path).toBe(404);
      expect(res.body.error).toBe("no such scope");
    }
  });

  it("answers 404 for a project with no snapshot, and for an unknown project", async () => {
    const none = await get<{ error: string }>(`/api/projects/${bareId}/scope/lenses?path=`);
    expect(none.status).toBe(404);
    expect(none.body.error).toBe("project has no snapshot yet");
    const unknown = await get<{ error: string }>("/api/projects/missing/scope/lenses?path=");
    expect(unknown.status).toBe(404);
  });

  it("lists the project, a folder and a file, with their stats and facets", async () => {
    const project = await get<Listing>(`/api/projects/${id}/scope/lenses?path=`);
    expect(project.status).toBe(200);
    expect(project.body).toMatchObject({ scope: "", kind: "project" });
    expect(project.body.stats.external).toBe(0);
    expect(project.body.facets).toContain("structure");

    const folder = await get<Listing>(`/api/projects/${id}/scope/lenses?path=src`);
    expect(folder.body).toMatchObject({ scope: "src", kind: "folder" });
    // The edge from src/a.ts to lib/c.ts leaves the folder, so the far end is a stub.
    expect(folder.body.stats.external).toBeGreaterThanOrEqual(1);
    expect(folder.body.lenses.map((l) => l.id)).toContain("lens-dependencies");
    // Nothing in the project uses effects, so lens-effects has nothing to read in this scope.
    const effects = folder.body.lenses.find((l) => l.id === "lens-effects");
    expect(effects).toMatchObject({ status: "unavailable", reason: 'unavailable: scope "src" has no effects facts' });

    const file = await get<Listing>(`/api/projects/${id}/scope/lenses?path=src/a.ts`);
    expect(file.body).toMatchObject({ scope: "src/a.ts", kind: "file" });
    expect(file.body.stats.nodes).toBeGreaterThan(0);
  });

  it("runs a lens on a folder, and on the project", async () => {
    const folder = await get<ScopedRun>(`/api/projects/${id}/scope/lenses/lens-dependencies?path=src`);
    expect(folder.status).toBe(200);
    expect(folder.body).toMatchObject({ scope: "src", kind: "folder", lens: { id: "lens-dependencies", status: "ok" } });
    expect(folder.body.lens.result?.findings.some((f) => /Import cycle/.test(f.message))).toBe(true);

    const project = await get<ScopedRun>(`/api/projects/${id}/scope/lenses/lens-dependencies?path=`);
    expect(project.body).toMatchObject({ scope: "", kind: "project", lens: { status: "ok" } });
  });

  it("returns the stored result when the same lens runs again on the same scope", async () => {
    const first = await get<ScopedRun>(`/api/projects/${id}/scope/lenses/lens-calls?path=src/b.ts`);
    const second = await get<ScopedRun>(`/api/projects/${id}/scope/lenses/lens-calls?path=src/b.ts`);
    expect(first.body.lens.status).toBe("ok");
    expect(second.body.lens.reused).toBe(true);
    expect(second.body.lens.inputsHash).toBe(first.body.lens.inputsHash);
    expect(second.body.lens.result).toEqual(first.body.lens.result);
  });

  it("shows the stored status of each lens in the listing after a run", async () => {
    const listing = await get<Listing>(`/api/projects/${id}/scope/lenses?path=src`);
    const row = listing.body.lenses.find((l) => l.id === "lens-dependencies");
    expect(row?.status).toBe("ok");
    expect(row?.findings).toBeGreaterThanOrEqual(1);
    const calls = listing.body.lenses.find((l) => l.id === "lens-calls");
    expect(calls?.status).toBe("not-run");
  });

  it("answers 404 for an unknown lens", async () => {
    const res = await get<{ error: string }>(`/api/projects/${id}/scope/lenses/lens-nope?path=src`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("no lens lens-nope");
  });
});
