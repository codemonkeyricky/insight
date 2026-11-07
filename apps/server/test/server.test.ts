import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { IndexReport } from "@insight/core";
import { buildServer, type InsightServer } from "../src/index.js";
import { resolveInside } from "../src/source.js";

const SCRATCH = resolve(import.meta.dirname, "..", ".insight-test");
const PROJECT = join(SCRATCH, "proj");
const HOME = join(SCRATCH, "home");

/** A tiny TypeScript project with an import cycle between a.ts and b.ts. */
function writeProject(dir: string): void {
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "proj", version: "0.0.0", private: true }));
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true }, include: ["src"] }),
  );
  writeFileSync(join(dir, "src/a.ts"), `import { b } from "./b.js";\nexport function a(): number {\n  return b() + 1;\n}\n`);
  writeFileSync(join(dir, "src/b.ts"), `import { a } from "./a.js";\nexport function b(): number {\n  return 2;\n}\nexport const c = () => a();\n`);
}

function fakeReport(snapshot: string): IndexReport {
  return {
    projectPath: "",
    durationMs: 1,
    snapshot,
    snapshotChanged: true,
    nodes: 0,
    edges: 0,
    findings: 0,
    resolved: 0,
    unresolved: 0,
    frontends: [],
    skipped: [],
    disabled: [],
    extracted: [],
    reused: 0,
    failed: [],
    removed: [],
    changes: { added: [], changed: [], removed: [] } as unknown as IndexReport["changes"],
    rehashed: 0,
    coverage: [],
    problems: [],
    logs: [],
    lenses: [],
  } as IndexReport;
}

async function readUntil(url: string, marker: string, timeoutMs = 10_000): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    while (!text.includes(marker)) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    await reader.cancel();
    return text;
  } finally {
    clearTimeout(timer);
  }
}

describe("path safety", () => {
  beforeAll(() => {
    rmSync(SCRATCH, { recursive: true, force: true });
    writeProject(PROJECT);
    writeFileSync(join(SCRATCH, "outside.txt"), "secret\n");
    symlinkSync(join(SCRATCH, "outside.txt"), join(PROJECT, "src", "escape.ts"));
  });
  afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

  it("accepts a file inside the project", () => {
    expect(resolveInside(PROJECT, "src/a.ts")).toBe(join(PROJECT, "src", "a.ts"));
  });
  it("rejects parent references, absolute paths and empty paths", () => {
    expect(() => resolveInside(PROJECT, "../outside.txt")).toThrow(/must not leave/);
    expect(() => resolveInside(PROJECT, "src/../../outside.txt")).toThrow(/must not leave/);
    expect(() => resolveInside(PROJECT, join(SCRATCH, "outside.txt"))).toThrow(/relative/);
    expect(() => resolveInside(PROJECT, "")).toThrow(/relative/);
  });
  it("rejects a symbolic link that leads outside the project", () => {
    expect(() => resolveInside(PROJECT, "src/escape.ts")).toThrow(/outside the project/);
  });
  it("reports a missing file as not found", () => {
    expect(() => resolveInside(PROJECT, "src/missing.ts")).toThrow(/no file/);
  });
});

describe("API against a real index", () => {
  let server: InsightServer;
  let projectId: string;

  beforeAll(async () => {
    writeProject(PROJECT);
    server = await buildServer({ home: HOME, intervalMs: 0, webDist: null, autostart: false });
  });
  afterAll(async () => {
    await server.close();
    rmSync(SCRATCH, { recursive: true, force: true });
  });

  it("reports health", async () => {
    const res = await server.app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true });
  });

  it("validates the add request", async () => {
    const none = await server.app.inject({ method: "POST", url: "/api/projects", payload: { name: "x" } });
    expect(none.statusCode).toBe(400);
    const both = await server.app.inject({ method: "POST", url: "/api/projects", payload: { path: PROJECT, url: "https://example.com/r.git" } });
    expect(both.statusCode).toBe(400);
    const badUrl = await server.app.inject({ method: "POST", url: "/api/projects", payload: { url: "ftp://example.com/r" } });
    expect(badUrl.statusCode).toBe(400);
    const missing = await server.app.inject({ method: "POST", url: "/api/projects", payload: { path: join(SCRATCH, "nope") } });
    expect(missing.statusCode).toBe(400);
  });

  it("adds a project by path and indexes it", async () => {
    const res = await server.app.inject({ method: "POST", url: "/api/projects", payload: { path: PROJECT, name: "Proj" } });
    expect(res.statusCode).toBe(201);
    const project = res.json().project;
    projectId = project.id;
    expect(project.allowBuildTools).toBe(false);
    expect(project.name).toBe("Proj");

    const dup = await server.app.inject({ method: "POST", url: "/api/projects", payload: { path: PROJECT } });
    expect(dup.statusCode).toBe(409);

    server.jobs.trigger(projectId);
    await server.jobs.whenIdle(projectId);
    const after = await server.app.inject({ method: "GET", url: `/api/projects/${projectId}` });
    expect(after.json().project.status).toBe("idle");
    expect(after.json().project.last.nodes).toBeGreaterThan(0);
  });

  it("lists projects", async () => {
    const res = await server.app.inject({ method: "GET", url: "/api/projects" });
    expect(res.json().projects.map((p: { id: string }) => p.id)).toContain(projectId);
  });

  it("gives an overview with coverage, lens statuses and findings", async () => {
    const res = await server.app.inject({ method: "GET", url: `/api/projects/${projectId}/overview` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.snapshot.latest).toBe(true);
    expect(body.snapshot.commit).toBeUndefined();
    const dependencies = body.lenses.find((l: { id: string }) => l.id === "lens-dependencies");
    expect(dependencies.status).toBe("ok");
    expect(body.findings.byLens["lens-dependencies"]).toBeGreaterThanOrEqual(1);
    expect(body.findings.bySeverity.warning).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(body.coverage)).toBe(true);
  });

  it("lists findings and filters them by lens", async () => {
    const res = await server.app.inject({ method: "GET", url: `/api/projects/${projectId}/findings?lens=lens-dependencies` });
    const findings = res.json().findings;
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.every((f: { lens: string }) => f.lens === "lens-dependencies")).toBe(true);
    expect(findings.some((f: { message: string }) => /Import cycle/.test(f.message))).toBe(true);
  });

  it("returns a lens result with a graph whose import edge carries a span", async () => {
    const res = await server.app.inject({ method: "GET", url: `/api/projects/${projectId}/lenses/lens-dependencies` });
    expect(res.statusCode).toBe(200);
    const graph = res.json().lens.result.views.find((v: { type: string }) => v.type === "graph");
    const importEdge = graph.edges.find((e: { kind: string; span?: unknown }) => e.kind === "import" && e.span);
    expect(importEdge).toBeDefined();
    expect(importEdge.span.file).toMatch(/^src\/(a|b)\.ts$/);
  });

  it("returns 404 for an unknown lens and an unknown snapshot", async () => {
    const lens = await server.app.inject({ method: "GET", url: `/api/projects/${projectId}/lenses/nope` });
    expect(lens.statusCode).toBe(404);
    const snap = await server.app.inject({ method: "GET", url: `/api/projects/${projectId}/overview?snapshot=0000000000000000` });
    expect(snap.statusCode).toBe(404);
  });

  it("returns node facts with outgoing and incoming edges", async () => {
    const overview = (await server.app.inject({ method: "GET", url: `/api/projects/${projectId}/overview` })).json();
    const res = await server.app.inject({ method: "GET", url: `/api/projects/${projectId}/nodes/src/a.ts` });
    expect(res.statusCode).toBe(200);
    const facts = res.json();
    expect(facts.snapshot).toBe(overview.snapshot.id);
    expect(facts.node.kind).toBe("structure.file");
    expect(facts.outgoing.some((e: { kind: string }) => e.kind === "packaging.import")).toBe(true);
    expect(facts.incoming.some((e: { kind: string }) => e.kind === "packaging.import")).toBe(true);
  });

  it("returns a source slice around a span and refuses unsafe paths", async () => {
    const ok = await server.app.inject({ method: "GET", url: `/api/projects/${projectId}/source?file=src/a.ts&start=1&end=1&context=0` });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().lines).toEqual([`import { b } from "./b.js";`]);
    expect(ok.json().highlight).toEqual({ start: 1, end: 1 });

    const traversal = await server.app.inject({ method: "GET", url: `/api/projects/${projectId}/source?file=../outside.txt&start=1` });
    expect(traversal.statusCode).toBe(400);
    const badLine = await server.app.inject({ method: "GET", url: `/api/projects/${projectId}/source?file=src/a.ts&start=0` });
    expect(badLine.statusCode).toBe(400);
  });

  it("lists the indexed files with their symbol counts", async () => {
    const res = await server.app.inject({ method: "GET", url: `/api/projects/${projectId}/files` });
    expect(res.statusCode).toBe(200);
    const files = res.json().files as { path: string; language?: string; functions: number; size: number }[];
    const a = files.find((f) => f.path === "src/a.ts");
    expect(a).toMatchObject({ language: "TypeScript", functions: 1 });
    expect(a?.size).toBeGreaterThan(0);
    expect(files.map((f) => f.path)).toEqual([...files.map((f) => f.path)].sort((x, y) => x.localeCompare(y)));
  });

  it("returns a whole file with its outline, and refuses unsafe or missing paths", async () => {
    const ok = await server.app.inject({ method: "GET", url: `/api/projects/${projectId}/file?path=src/b.ts` });
    expect(ok.statusCode).toBe(200);
    const body = ok.json();
    expect(body.totalLines).toBe(5);
    expect(body.lines[0]).toBe(`import { a } from "./a.js";`);
    expect(body.language).toBe("TypeScript");
    expect(body.symbols.map((s: { name: string }) => s.name)).toContain("b");

    expect((await server.app.inject({ method: "GET", url: `/api/projects/${projectId}/file` })).statusCode).toBe(400);
    expect((await server.app.inject({ method: "GET", url: `/api/projects/${projectId}/file?path=../outside.txt` })).statusCode).toBe(400);
    expect((await server.app.inject({ method: "GET", url: `/api/projects/${projectId}/file?path=src/nope.ts` })).statusCode).toBe(404);
  });

  it("charts a file's control flow and summarises flow per file", async () => {
    const res = await server.app.inject({ method: "GET", url: `/api/projects/${projectId}/flow?path=src/b.ts` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.file).toBe("src/b.ts");
    const fns = body.functions as { name: string; nodes: { role: string }[]; edges: unknown[] }[];
    expect(fns.map((f) => f.name)).toContain("b");
    const b = fns.find((f) => f.name === "b");
    expect(b?.nodes[0]?.role).toBe("start");

    expect((await server.app.inject({ method: "GET", url: `/api/projects/${projectId}/flow` })).statusCode).toBe(400);
    const none = await server.app.inject({ method: "GET", url: `/api/projects/${projectId}/flow?path=src/nope.ts` });
    expect(none.statusCode).toBe(200);
    expect(none.json().functions).toEqual([]);

    const sum = await server.app.inject({ method: "GET", url: `/api/projects/${projectId}/flow-summary` });
    expect(sum.statusCode).toBe(200);
    const files = sum.json().files as { file: string; functions: number }[];
    expect(files.find((f) => f.file === "src/b.ts")?.functions).toBeGreaterThanOrEqual(1);
  });

  it("serves the event stream with the current status", async () => {
    await server.app.listen({ port: 0, host: "127.0.0.1" });
    const address = server.app.server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const text = await readUntil(`http://127.0.0.1:${port}/api/projects/${projectId}/events`, "event: status");
    expect(text).toContain("event: status");
    expect(text).toContain(`"projectId":"${projectId}"`);
  });

  it("deletes a project from the registry", async () => {
    const res = await server.app.inject({ method: "DELETE", url: `/api/projects/${projectId}` });
    expect(res.statusCode).toBe(204);
    const gone = await server.app.inject({ method: "GET", url: `/api/projects/${projectId}` });
    expect(gone.statusCode).toBe(404);
  });
});

describe("job runner", () => {
  beforeAll(() => {
    rmSync(SCRATCH, { recursive: true, force: true });
    writeProject(PROJECT);
  });
  afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

  it("runs at most one job per project and merges queued triggers into one follow-up", async () => {
    const home = join(SCRATCH, "jobs-home");
    const calls: boolean[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const server = await buildServer({
      home,
      intervalMs: 0,
      webDist: null,
      autostart: false,
      index: async (opts) => {
        calls.push(opts.full === true);
        await gate;
        return fakeReport("snap000000000000");
      },
    });
    try {
      const id = server.registry.add({ path: PROJECT }).id;
      expect(server.jobs.trigger(id)).toBe("started");
      expect(server.jobs.trigger(id)).toBe("queued");
      expect(server.jobs.trigger(id, { full: true })).toBe("queued");
      expect(server.jobs.trigger(id)).toBe("queued");
      expect(server.jobs.trigger("missing")).toBe("missing");
      release();
      await server.jobs.whenIdle(id);
      expect(calls).toEqual([false, true]);
      expect(server.registry.get(id)?.status).toBe("idle");
      expect(server.registry.get(id)?.last?.snapshot).toBe("snap000000000000");
    } finally {
      await server.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("records a failed run as an error without stopping later runs", async () => {
    const home = join(SCRATCH, "fail-home");
    let attempt = 0;
    const server = await buildServer({
      home,
      intervalMs: 0,
      webDist: null,
      autostart: false,
      index: async () => {
        attempt++;
        if (attempt === 1) throw new Error("frontend exploded");
        return fakeReport("snapfixed00000000");
      },
    });
    try {
      const id = server.registry.add({ path: PROJECT }).id;
      server.jobs.trigger(id);
      await server.jobs.whenIdle(id);
      expect(server.registry.get(id)?.status).toBe("error");
      expect(server.registry.get(id)?.error).toBe("frontend exploded");
      server.jobs.trigger(id);
      await server.jobs.whenIdle(id);
      expect(server.registry.get(id)?.status).toBe("idle");
      expect(server.registry.get(id)?.error).toBeUndefined();
    } finally {
      await server.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("refuses to delete a project while it is indexing", async () => {
    const home = join(SCRATCH, "busy-home");
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const server = await buildServer({
      home,
      intervalMs: 0,
      webDist: null,
      autostart: false,
      index: async () => {
        await gate;
        return fakeReport("snapbusy0000000");
      },
    });
    try {
      const id = server.registry.add({ path: PROJECT }).id;
      server.jobs.trigger(id);
      const res = await server.app.inject({ method: "DELETE", url: `/api/projects/${id}` });
      expect(res.statusCode).toBe(409);
      release();
      await server.jobs.whenIdle(id);
    } finally {
      await server.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("web app serving", () => {
  const WEB = join(SCRATCH, "web-dist");
  beforeAll(() => {
    mkdirSync(join(WEB, "assets"), { recursive: true });
    writeFileSync(join(WEB, "index.html"), "<!doctype html><title>shell</title>");
    writeFileSync(join(WEB, "assets", "app.js"), "console.log(1);");
  });
  afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

  it("serves real assets, the app shell for client routes, and 404 JSON for unknown API paths", async () => {
    const server = await buildServer({ home: join(SCRATCH, "web-home"), intervalMs: 0, webDist: WEB, autostart: false });
    try {
      const asset = await server.app.inject({ method: "GET", url: "/assets/app.js" });
      expect(asset.statusCode).toBe(200);
      expect(asset.body).toContain("console.log");
      const shell = await server.app.inject({ method: "GET", url: "/#/projects/abc" });
      expect(shell.statusCode).toBe(200);
      expect(shell.headers["content-type"]).toMatch(/text\/html/);
      expect(shell.body).toContain("shell");
      const api = await server.app.inject({ method: "GET", url: "/api/nope" });
      expect(api.statusCode).toBe(404);
      expect(api.headers["content-type"]).toMatch(/application\/json/);
    } finally {
      await server.close();
    }
  });
});
