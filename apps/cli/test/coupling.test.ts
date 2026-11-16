import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { couplingIndex, couplingReport, type CouplingReport } from "@insight/flow";
import { loadState, projectPaths, readSnapshot, runIndex } from "@insight/indexer";
import type { IREdge, IRNode } from "@insight/ir";
import { main } from "../src/command.js";

const here = dirname(fileURLToPath(import.meta.url));
const SCRATCH = join(here, "..", ".insight-test", `coupling-${process.pid}`);
const PROJECT = join(SCRATCH, "mono");

function writeProject(dir: string): void {
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
  // A file whose top-level code makes a flow: its id is the file path, and it also has a named function. This is the
  // selector shape that used to match the top-level flow id and miss the file's functions.
  mkdirSync(join(dir, "native"), { recursive: true });
  writeFileSync(join(dir, "native/top.cc"), `#include <fstream>\nint g() { return 1; }\nstd::ifstream in("/dev/null");\n`);
}

/** Runs the CLI in-process, capturing stdout and stderr. */
async function run(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...args: unknown[]) => out.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => err.push(args.map(String).join(" "));
  try {
    const code = await main(argv);
    return { code, out: out.join("\n"), err: err.join("\n") };
  } finally {
    console.log = log;
    console.error = error;
  }
}

/** The report the CLI should print, from the same builder. The server route wraps the same function. */
function builderReport(root: string, opts: { ids?: string[]; scope?: string } = {}): CouplingReport {
  const paths = projectPaths(root);
  const state = loadState(paths);
  const snapshot = state.latest ?? state.snapshots.at(-1)?.id;
  if (snapshot === undefined) throw new Error("no snapshot");
  const nodes: IRNode[] = [];
  const edges: IREdge[] = [];
  for (const r of readSnapshot(paths, snapshot)) {
    if ("node" in r) nodes.push(r.node);
    else if ("edge" in r) edges.push(r.edge);
  }
  return couplingReport(couplingIndex(nodes, edges), opts);
}

describe("insight coupling", () => {
  beforeAll(async () => {
    rmSync(SCRATCH, { recursive: true, force: true });
    writeProject(PROJECT);
    await runIndex({ projectPath: PROJECT });
  }, 120_000);

  // Remove only this file's scratch folder: incremental.test.ts shares the .insight-test parent and runs in parallel.
  afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

  it("--json prints exactly the builder's JSON for the whole project", async () => {
    const result = await run(["coupling", ".", "--path", PROJECT, "--json"]);
    expect(result.code).toBe(0);
    expect(result.err).toBe("");
    expect(result.out).toBe(JSON.stringify(builderReport(PROJECT)));
    const report = JSON.parse(result.out) as CouplingReport;
    expect(report.functions.map((f) => f.id)).toEqual([
      "apps/app/src/main.ts#run",
      "libs/util/src/u.ts#fetchIt",
      "libs/util/src/u.ts#local",
      "native/top.cc",
      "native/top.cc#g",
    ]);
    const run0 = report.functions[0]!;
    expect(run0.cross).toEqual([{ label: "local()", target: "libs/util/src/u.ts#local", file: "libs/util/src/u.ts", line: 4 }]);
  });

  it("takes a file, a folder, or a function id as the selector", async () => {
    const file = await run(["coupling", "apps/app/src/main.ts", "--path", PROJECT, "--json"]);
    expect(file.code).toBe(0);
    expect(JSON.parse(file.out)).toEqual(builderReport(PROJECT, { scope: "apps/app/src/main.ts" }));

    const folder = await run(["coupling", "libs", "--path", PROJECT, "--json"]);
    expect(folder.code).toBe(0);
    expect((JSON.parse(folder.out) as CouplingReport).functions.map((f) => f.name)).toEqual(["fetchIt", "local"]);

    const id = await run(["coupling", "libs/util/src/u.ts#local", "--path", PROJECT, "--json"]);
    expect(id.code).toBe(0);
    expect((JSON.parse(id.out) as CouplingReport).functions.map((f) => f.name)).toEqual(["local"]);

    const name = await run(["coupling", "local", "--path", PROJECT, "--json"]);
    expect(name.code).toBe(0);
    expect((JSON.parse(name.out) as CouplingReport).functions.map((f) => f.id)).toEqual(["libs/util/src/u.ts#local"]);
  });

  it("returns the top-level flow and every function of a file whose top-level flow id is the path", async () => {
    const result = await run(["coupling", "native/top.cc", "--path", PROJECT, "--json"]);
    expect(result.code).toBe(0);
    expect(result.err).toBe("");
    const report = JSON.parse(result.out) as CouplingReport;
    expect(report.functions.map((f) => f.id)).toEqual(["native/top.cc", "native/top.cc#g"]);
    // Exactly the file scope's set, so the CLI and the HTTP route agree.
    expect(report).toEqual(builderReport(PROJECT, { scope: "native/top.cc" }));
  });

  it("prints a text report grouped by class by default", async () => {
    const result = await run(["coupling", "apps/app/src/main.ts", "--path", PROJECT]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("run  apps/app/src/main.ts#run");
    expect(result.out).toContain("module apps/app");
    expect(result.out).toContain("⇄ 1 module");
    expect(result.out).toContain("  cross");
    expect(result.out).toContain("→ libs/util/src/u.ts#local");
    expect(result.out).toContain("(libs/util/src/u.ts:4)");
  });

  it("exits nonzero for an unknown scope and says so", async () => {
    const result = await run(["coupling", "apps/nope", "--path", PROJECT, "--json"]);
    expect(result.code).toBe(1);
    expect(result.out).toBe("");
    expect(result.err).toMatch(/no such function, file or scope: apps\/nope/);
  });

  it("refuses an absolute selector or one with .. before reading a snapshot", async () => {
    const bare = join(SCRATCH, "bare-syntax");
    writeProject(bare);
    const outside = await run(["coupling", "../outside", "--path", bare, "--json"]);
    expect(outside.code).toBe(1);
    expect(outside.out).toBe("");
    expect(outside.err).toMatch(/scope must not leave the project/);
    const absolute = await run(["coupling", "/apps", "--path", bare, "--json"]);
    expect(absolute.code).toBe(1);
    expect(absolute.out).toBe("");
    expect(absolute.err).toMatch(/scope must be relative to the project/);
  });

  it("exits nonzero without a snapshot instead of indexing", async () => {
    const bare = join(SCRATCH, "bare");
    writeProject(bare);
    const result = await run(["coupling", ".", "--path", bare, "--json"]);
    expect(result.code).toBe(1);
    expect(result.out).toBe("");
    expect(result.err).toMatch(/no snapshot in .*\.insight; index the project first: insight index /);
  });
});
