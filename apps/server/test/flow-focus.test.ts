import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildServer, type InsightServer } from "../src/index.js";

// One file with a same-file call and a kernel effect (fs), and a second file that calls the first file's exported
// function. The inter-module focus keeps the cross-file call and drops the same-file call and the fs effect.
const SCRATCH = resolve(import.meta.dirname, "..", ".insight-test-flow-focus");
const PROJECT = join(SCRATCH, "proj");
const HOME = join(SCRATCH, "home");

function writeProject(dir: string): void {
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "focus", version: "0.0.0", private: true }));
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true }, include: ["src"] }),
  );
  writeFileSync(
    join(dir, "src/a.ts"),
    `import { readFileSync } from "node:fs";\nexport function helper(): number {\n  return 1;\n}\nexport function run(flag: boolean): number {\n  if (flag) {\n    helper();\n  }\n  readFileSync("x.txt");\n  return 0;\n}\n`,
  );
  writeFileSync(join(dir, "src/b.ts"), `import { helper } from "./a.js";\nexport function other(): number {\n  return helper();\n}\n`);
}

/** The labels of every row of every chart in a file flow payload. */
function labelsOf(payload: { functions: { name: string; nodes: { label: string }[] }[] }, name: string): string[] {
  const fn = payload.functions.find((f) => f.name === name);
  if (!fn) throw new Error(`no function ${name}`);
  return fn.nodes.map((n) => n.label);
}

describe("inter-module focus on the file flow API", () => {
  let server: InsightServer;
  let projectId: string;

  beforeAll(async () => {
    rmSync(SCRATCH, { recursive: true, force: true });
    writeProject(PROJECT);
    server = await buildServer({ home: HOME, intervalMs: 0, webDist: null, autostart: false });
    const res = await server.app.inject({ method: "POST", url: "/api/projects", payload: { path: PROJECT, name: "Focus" } });
    projectId = res.json().project.id;
    server.jobs.trigger(projectId);
    await server.jobs.whenIdle(projectId);
  }, 120_000);

  afterAll(async () => {
    await server.close();
    rmSync(SCRATCH, { recursive: true, force: true });
  });

  const flow = (path: string, focus?: string) =>
    server.app.inject({ method: "GET", url: `/api/projects/${projectId}/flow?path=${encodeURIComponent(path)}${focus === undefined ? "" : `&focus=${focus}`}` });

  it("keeps the same-file call and the fs effect in /flow, and drops both with focus=intermodule", async () => {
    const all = await flow("src/a.ts");
    expect(all.statusCode).toBe(200);
    const allLabels = labelsOf(all.json(), "run");
    expect(allLabels.some((l) => l.includes("helper"))).toBe(true);
    expect(allLabels.some((l) => l.startsWith("fs.read"))).toBe(true);

    const focused = await flow("src/a.ts", "intermodule");
    expect(focused.statusCode).toBe(200);
    const focusLabels = labelsOf(focused.json(), "run");
    expect(focusLabels.some((l) => l.includes("helper"))).toBe(false);
    expect(focusLabels.some((l) => l.startsWith("fs.read"))).toBe(false);
  });

  it("keeps the call to an exported function of another file under focus", async () => {
    const focused = await flow("src/b.ts", "intermodule");
    expect(labelsOf(focused.json(), "other").some((l) => l.includes("helper"))).toBe(true);
  });

  it("omits the coupling chart under focus, and keeps it for the default", async () => {
    const all = await flow("src/a.ts");
    const focused = await flow("src/a.ts", "intermodule");
    const allRun = (all.json().functions as { name: string; coupling?: unknown }[]).find((f) => f.name === "run");
    const focusRun = (focused.json().functions as { name: string; coupling?: unknown }[]).find((f) => f.name === "run");
    expect(allRun?.coupling).toBeDefined();
    expect(focusRun?.coupling).toBeUndefined();
  });

  it("caches the two answers separately: each request returns its own focus, in either order", async () => {
    const first = await flow("src/a.ts");
    const second = await flow("src/a.ts", "intermodule");
    const again = await flow("src/a.ts");
    const againFocus = await flow("src/a.ts", "intermodule");
    expect(again.json()).toEqual(first.json());
    expect(againFocus.json()).toEqual(second.json());
    expect(second.json()).not.toEqual(first.json());
  });

  it("answers 400 for a focus that is neither intermodule nor all, and treats all as the default", async () => {
    const bad = await flow("src/a.ts", "sideways");
    expect(bad.statusCode).toBe(400);
    const explicitAll = await flow("src/a.ts", "all");
    expect(explicitAll.json()).toEqual((await flow("src/a.ts")).json());
  });

  it("keeps the exec model's threads and functions under focus: only the chart sizes are the focus's", async () => {
    const all = await server.app.inject({ method: "GET", url: `/api/projects/${projectId}/scope/exec?path=src` });
    const focused = await server.app.inject({ method: "GET", url: `/api/projects/${projectId}/scope/exec?path=src&focus=intermodule` });
    expect(all.statusCode).toBe(200);
    expect(focused.statusCode).toBe(200);
    expect(focused.json().threads).toEqual(all.json().threads);
    expect(focused.json().functions.map((f: { id: string }) => f.id)).toEqual(all.json().functions.map((f: { id: string }) => f.id));
  });

  it("rejects a bad focus on the exec routes with a 400", async () => {
    const bad = await server.app.inject({ method: "GET", url: `/api/projects/${projectId}/scope/exec?path=src&focus=sideways` });
    expect(bad.statusCode).toBe(400);
  });
});
