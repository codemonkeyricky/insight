import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildServer, type InsightServer } from "../src/index.js";

// Two packages in one repo: apps/app calls a function in libs/util. The coupling route is the agent-facing view of the
// same footprint the flow route's coupling chart draws.
const SCRATCH = resolve(import.meta.dirname, "..", ".insight-test-coupling-api");
const PROJECT = join(SCRATCH, "mono");
const HOME = join(SCRATCH, "home");
const RUN_ID = "apps/app/src/main.ts#run";

function writePackages(dir: string): void {
  mkdirSync(join(dir, "libs/util/src"), { recursive: true });
  mkdirSync(join(dir, "apps/app/src"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "mono", version: "0.0.0", private: true }));
  writeFileSync(join(dir, "libs/util/package.json"), JSON.stringify({ name: "util", version: "0.0.0" }));
  writeFileSync(join(dir, "apps/app/package.json"), JSON.stringify({ name: "app", version: "0.0.0" }));
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true }, include: ["libs", "apps"] }),
  );
  writeFileSync(join(dir, "libs/util/src/u.ts"), `export function fetchIt(): number {\n  return 1;\n}\nexport function local(): number {\n  return fetchIt() + 1;\n}\n`);
  writeFileSync(
    join(dir, "apps/app/src/main.ts"),
    `import { local } from "../../../libs/util/src/u.js";\nexport function run(flag: boolean): number {\n  if (flag) {\n    return local();\n  }\n  return 0;\n}\n`,
  );
}

interface ReportFunction {
  id: string;
  name: string;
  file?: string;
  module: string;
  summary: string;
  cross: { label: string; target?: string; file?: string; line?: number }[];
  io: unknown[];
  state: unknown[];
  conc: unknown[];
  escape: unknown[];
}

describe("GET /api/projects/:id/coupling", () => {
  let server: InsightServer;
  let projectId: string;

  const get = (query: string) =>
    server.app.inject({ method: "GET", url: `/api/projects/${projectId}/coupling${query}` });

  beforeAll(async () => {
    rmSync(SCRATCH, { recursive: true, force: true });
    writePackages(PROJECT);
    server = await buildServer({ home: HOME, intervalMs: 0, webDist: null, autostart: false });
    const res = await server.app.inject({ method: "POST", url: "/api/projects", payload: { path: PROJECT, name: "Mono" } });
    projectId = res.json().project.id;
    server.jobs.trigger(projectId);
    await server.jobs.whenIdle(projectId);
  }, 120_000);

  afterAll(async () => {
    await server.close();
    rmSync(SCRATCH, { recursive: true, force: true });
  });

  it("returns the report object itself for a file scope", async () => {
    const res = await get("?scope=apps/app/src/main.ts");
    expect(res.statusCode).toBe(200);
    const body = res.json() as { functions: ReportFunction[] };
    expect(Object.keys(body)).toEqual(["functions"]);
    const run = body.functions.find((f) => f.id === RUN_ID);
    expect(run).toBeDefined();
    expect(Object.keys(run as object).sort()).toEqual(
      ["conc", "cross", "escape", "file", "id", "io", "module", "name", "state", "summary"].sort(),
    );
    expect(run?.name).toBe("run");
    expect(run?.file).toBe("apps/app/src/main.ts");
    expect(run?.module).toBe("apps/app");
    expect(run?.summary).toContain("⇄ 1 module");
    expect(run?.cross).toEqual([
      { label: "local()", target: "libs/util/src/u.ts#local", file: "libs/util/src/u.ts", line: 4 },
    ]);
    expect(run?.io).toEqual([]);
    expect(run?.state).toEqual([]);
    expect(run?.conc).toEqual([]);
    expect(run?.escape).toEqual([]);
  });

  it("selects one function with fn=, which takes precedence over scope", async () => {
    const res = await get(`?scope=libs/util/src/u.ts&fn=${encodeURIComponent(RUN_ID)}`);
    expect(res.statusCode).toBe(200);
    expect((res.json() as { functions: ReportFunction[] }).functions.map((f) => f.id)).toEqual([RUN_ID]);
  });

  it("defaults to the whole project, sorted by id", async () => {
    const res = await get("");
    expect(res.statusCode).toBe(200);
    const ids = (res.json() as { functions: ReportFunction[] }).functions.map((f) => f.id);
    expect(ids).toEqual(["apps/app/src/main.ts#run", "libs/util/src/u.ts#fetchIt", "libs/util/src/u.ts#local"]);
  });

  it("answers 404 for an unknown scope and an unknown function", async () => {
    const scope = await get("?scope=apps/nope");
    expect(scope.statusCode).toBe(404);
    expect(scope.json()).toEqual({ error: "no such scope" });
    const fn = await get("?fn=apps/app/src/main.ts%23nope");
    expect(fn.statusCode).toBe(404);
    expect(fn.json()).toEqual({ error: "no function apps/app/src/main.ts#nope" });
  });

  it("answers 400 for a repeated scope and rejects a path that leaves the project", async () => {
    const repeated = await get("?scope=apps&scope=libs");
    expect(repeated.statusCode).toBe(400);
    expect(repeated.json()).toEqual({ error: "scope must be given once" });
    const outside = await get("?scope=../outside");
    expect(outside.statusCode).toBe(400);
    expect(outside.json().error).toMatch(/must not leave/);
  });

  it("rejects an out-of-project or absolute scope even when fn= is present", async () => {
    for (const scope of ["../outside", "/apps"]) {
      const bare = await get(`?scope=${encodeURIComponent(scope)}`);
      expect(bare.statusCode).toBe(400);
      const withFn = await get(`?scope=${encodeURIComponent(scope)}&fn=${encodeURIComponent(RUN_ID)}`);
      expect(withFn.statusCode).toBe(400);
    }
    const absolute = await get("?scope=%2Fapps");
    expect(absolute.statusCode).toBe(400);
    expect(absolute.json().error).toMatch(/must be relative to the project/);
    const outside = await get("?scope=..%2Foutside");
    expect(outside.statusCode).toBe(400);
    expect(outside.json().error).toMatch(/must not leave the project/);
  });
});
