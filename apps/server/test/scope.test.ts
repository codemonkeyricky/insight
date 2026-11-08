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

interface FlowListing {
  snapshot: string;
  scope: string;
  kind: string;
  granularity: "functions" | "files";
  functions: { id: string; name: string; file: string; line: number; calledFromOutside?: boolean }[];
  calls: { from: string; to: string; count: number; external: boolean; candidate?: boolean }[];
  externals: { id: string; name: string; file?: string }[];
  entries: string[];
  unreferenced: { id: string; reach: number; calledFromOutside?: boolean; test?: true }[];
  files: { file: string; functions: number }[];
  stats: {
    functions: number;
    files: number;
    calls: number;
    resolved: number;
    external: number;
    unresolved: number;
    inbound: number;
    entries: number;
    functionsTotal: number;
    functionsNoise: number;
    unreferenced: number;
    unreferencedNoise: number;
    unreferencedOutside: number;
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

  describe("the call flow route", () => {
    const flowUrl = (path: string) => `/api/projects/${id}/scope/flow?path=${encodeURIComponent(path)}`;

    it("answers 400 when the path is missing or given twice, and for a path that leaves the project", async () => {
      const missing = await get<{ error: string }>(`/api/projects/${id}/scope/flow`);
      expect(missing.status).toBe(400);
      expect(missing.body.error).toBe("path is required");
      const twice = await get<{ error: string }>(`/api/projects/${id}/scope/flow?path=src&path=lib`);
      expect(twice.status).toBe(400);
      for (const path of ["../outside", "/etc", "src/../../x"]) {
        const res = await get<{ error: string }>(flowUrl(path));
        expect(res.status, path).toBe(400);
      }
    });

    it("answers 404 for a path with no indexed file under it", async () => {
      for (const path of ["nope", "src/a.ts/x", "docs"]) {
        const res = await get<{ error: string }>(flowUrl(path));
        expect(res.status, path).toBe(404);
        expect(res.body.error).toBe("no such scope");
      }
    });

    it("lists the functions that no function in the scope calls, with how far each reaches", async () => {
      const file = await get<FlowListing>(flowUrl("src/a.ts"));
      const folder = await get<FlowListing>(flowUrl("src"));
      const project = await get<FlowListing>(flowUrl(""));
      // a() is called only by d(), which is outside this file. It is still unreferenced here, and flagged. Its callees
      // are both outside the file, so it reaches nothing inside it.
      expect(file.body.unreferenced).toEqual([expect.objectContaining({ id: "src/a.ts#a", calledFromOutside: true, reach: 0 })]);
      expect(file.body.stats).toMatchObject({ unreferenced: 1, unreferencedOutside: 1, unreferencedNoise: 0 });
      // d() is the only function in src that nothing in src calls. Through a() it reaches b(), not c(), which is outside.
      expect(folder.body.unreferenced.map((f) => f.id)).toEqual(["src/b.ts#d"]);
      expect(folder.body.unreferenced[0]).toMatchObject({ reach: 2 });
      expect(project.body.unreferenced.map((f) => f.id)).toEqual(["src/b.ts#d"]);
      expect(project.body.unreferenced[0]).toMatchObject({ reach: 3 });
      expect(project.body.stats).toMatchObject({ functionsTotal: 4, functionsNoise: 0, unreferenced: 1, unreferencedOutside: 0 });
    });

    it("answers 404 for an unknown snapshot, and for a project with no snapshot yet", async () => {
      const unknown = await get<{ error: string }>(`${flowUrl("src")}&snapshot=nope`);
      expect(unknown.status).toBe(404);
      expect(unknown.body.error).toBe("unknown snapshot nope");
      const none = await get<{ error: string }>(`/api/projects/${bareId}/scope/flow?path=`);
      expect(none.status).toBe(404);
      expect(none.body.error).toBe("project has no snapshot yet");
    });

    it("marks a call that leaves the file as external, and the function it reaches from outside", async () => {
      const file = await get<FlowListing>(flowUrl("src/a.ts"));
      expect(file.status).toBe(200);
      expect(file.body).toMatchObject({ scope: "src/a.ts", kind: "file", granularity: "functions" });
      expect(file.body.functions.map((f) => f.id)).toEqual(["src/a.ts#a"]);
      // a() is called by d() in b.ts, which is outside this file.
      expect(file.body.functions[0]?.calledFromOutside).toBe(true);
      // a() calls b() in b.ts and c() in lib/c.ts. Neither is in this file, so both are external here.
      expect(file.body.calls.map((c) => c.to).sort()).toEqual(["lib/c.ts#c", "src/b.ts#b"]);
      expect(file.body.calls.every((c) => c.external)).toBe(true);
      expect(file.body.stats).toMatchObject({ calls: 2, resolved: 0, external: 2, unresolved: 0, inbound: 1, files: 1 });
      // a() has a caller outside the file, so it is not an entry of this scope.
      expect(file.body.entries).toEqual([]);
    });

    it("resolves the same calls once the folder that holds the callee is selected", async () => {
      const folder = await get<FlowListing>(flowUrl("src"));
      expect(folder.status).toBe(200);
      expect(folder.body).toMatchObject({ scope: "src", kind: "folder", granularity: "functions" });
      expect(folder.body.functions.map((f) => f.id)).toEqual(expect.arrayContaining(["src/a.ts#a", "src/b.ts#b"]));
      // a() -> b() now resolves inside src. a() -> c() still leaves src for lib/c.ts.
      expect(folder.body.stats).toMatchObject({ calls: 3, resolved: 2, external: 1, unresolved: 0, inbound: 0 });
      expect(folder.body.externals).toEqual([{ id: "lib/c.ts#c", name: "c", file: "lib/c.ts" }]);
      // Nothing in src is called from outside it.
      expect(folder.body.functions.some((f) => f.calledFromOutside)).toBe(false);
      // a() and b() each have a caller in src. d() has none, so it is the one entry.
      expect(folder.body.entries).toEqual(["src/b.ts#d"]);
    });

    it("only widens resolution as the scope widens, and the project resolves every call", async () => {
      const file = await get<FlowListing>(flowUrl("src/a.ts"));
      const folder = await get<FlowListing>(flowUrl("src"));
      const project = await get<FlowListing>(flowUrl(""));
      expect(project.body).toMatchObject({ scope: "", kind: "project" });
      // stats.files counts every file of the scope (the linker gives each one a structure.file node, so
      // package.json and tsconfig.json count too). `files` lists only the files that have functions.
      expect(project.body.stats).toMatchObject({ calls: 3, resolved: 3, external: 0, unresolved: 0, inbound: 0, files: 5 });
      expect(project.body.files.map((f) => f.file)).toEqual(["lib/c.ts", "src/a.ts", "src/b.ts"]);
      expect(project.body.functions.map((f) => f.id)).toEqual(["lib/c.ts#c", "src/a.ts#a", "src/b.ts#b", "src/b.ts#d"]);
      expect(project.body.entries).toEqual(["src/b.ts#d"]);
      expect(file.body.stats.resolved).toBeLessThanOrEqual(folder.body.stats.resolved);
      expect(folder.body.stats.resolved).toBeLessThanOrEqual(project.body.stats.resolved);
      for (const r of [file, folder, project]) {
        const s = r.body.stats;
        expect(s.resolved + s.external + s.unresolved, r.body.scope).toBe(s.calls);
      }
    });

    it("reads the snapshot it names, and the same scope gives the same flow again", async () => {
      const latest = await get<FlowListing>(flowUrl("src"));
      const pinned = await get<FlowListing>(`${flowUrl("src")}&snapshot=${latest.body.snapshot}`);
      expect(pinned.status).toBe(200);
      expect(pinned.body.snapshot).toBe(latest.body.snapshot);
      expect(pinned.body).toEqual(latest.body);
    });
  });
});
