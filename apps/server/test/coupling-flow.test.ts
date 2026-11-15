import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildServer, type InsightServer } from "../src/index.js";

// Two packages in one repo: apps/app calls a function in libs/util. The flow chart of the caller must carry a coupling
// chart whose cross-package call survives pruning.
const SCRATCH = resolve(import.meta.dirname, "..", ".insight-test-coupling");
const PROJECT = join(SCRATCH, "mono");
const HOME = join(SCRATCH, "home");

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

describe("coupling chart on the file flow API", () => {
  let server: InsightServer;
  let projectId: string;

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

  it("gives each function a coupling summary and keeps the cross-package call in its coupling chart", async () => {
    const res = await server.app.inject({ method: "GET", url: `/api/projects/${projectId}/flow?path=apps/app/src/main.ts` });
    expect(res.statusCode).toBe(200);
    const fns = res.json().functions as {
      name: string;
      coupling?: { module: string; summary: string; chart: { nodes: { label: string; coupling?: string }[] }; rows: { all: number; coupling: number } };
    }[];
    const run = fns.find((f) => f.name === "run");
    expect(run?.coupling).toBeDefined();
    expect(run?.coupling?.module).toBe("apps/app");
    expect(run?.coupling?.summary).toContain("⇄ 1 module");
    expect(run?.coupling?.rows.coupling).toBeGreaterThan(0);
    expect(run?.coupling?.rows.all).toBeGreaterThan(0);
    expect(run?.coupling?.chart.nodes.some((n) => n.label.includes("local"))).toBe(true);
  });

  it("carries the coupling chart of a file's functions in the libs package too", async () => {
    const res = await server.app.inject({ method: "GET", url: `/api/projects/${projectId}/flow?path=libs/util/src/u.ts` });
    const local = (res.json().functions as { name: string; coupling?: { module: string } }[]).find((f) => f.name === "local");
    expect(local?.coupling?.module).toBe("libs/util");
  });
});
