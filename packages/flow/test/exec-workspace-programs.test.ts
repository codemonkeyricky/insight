import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import frontend from "@insight/frontend-typescript";
import type { IREdge, IRNode } from "@insight/ir";
import { execModel, type ExecModel, type ExecThread } from "../src/index.js";

// A workspace with no node_modules. The CLI's bin is dist/cli.js (its source calls a library function through
// @scope/lib). The server starts dist/main.js by script. The library names only `main`, so it is no program.
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const FILES: Record<string, string> = {
  "package.json": json({ name: "ws-programs", private: true }),
  "packages/lib/package.json": json({ name: "@scope/lib", version: "0.0.0", main: "dist/index.js" }),
  "packages/lib/src/index.ts": "export function indexProject(path: string): number {\n  return path.length + 1;\n}\n",
  "packages/lib/dist/index.js": "export function indexProject(path) { return path.length + 1; }\n",
  "packages/cli/package.json": json({ name: "@scope/cli", version: "0.0.0", bin: { scope: "./dist/cli.js" } }),
  "packages/cli/src/cli.ts":
    'import { indexProject } from "@scope/lib";\n\nfunction run(argv: string[]): number {\n  return indexProject(argv[0] ?? ".");\n}\n\nconsole.log(run(process.argv.slice(2)));\n',
  "packages/server/package.json": json({ name: "@scope/server", version: "0.0.0", scripts: { start: "node dist/main.js" } }),
  "packages/server/src/main.ts": 'import { indexProject } from "@scope/lib";\n\nexport function serve(): number {\n  return indexProject("/");\n}\n\nconsole.log(serve());\n',
  // The CLI also starts the server as a process, from its build output, as packages/cli/src/serve.ts does.
  "packages/cli/src/serve.ts":
    'import { spawn } from "node:child_process";\nimport { dirname, join, resolve } from "node:path";\nimport { fileURLToPath } from "node:url";\n\nconst HERE = dirname(fileURLToPath(import.meta.url));\nconst REPO_ROOT = resolve(HERE, "..", "..", "..");\nconst SERVER_MAIN = join(REPO_ROOT, "packages", "server", "dist", "main.js");\n\nexport function runServer(): void {\n  spawn(process.execPath, [SERVER_MAIN], { stdio: "inherit" });\n}\n',
};
const CLI = "entry:node:packages/cli/src/cli.ts";
const SERVER = "entry:node:packages/server/src/main.ts";
const CLI_MODULE = "packages/cli/src/cli.ts#(module)";
const SERVER_MODULE = "packages/server/src/main.ts#(module)";
const LIB_FN = "packages/lib/src/index.ts#indexProject";

let nodes: IRNode[];
let edges: IREdge[];

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "insight-ws-programs-"));
  try {
    for (const [file, text] of Object.entries(FILES)) {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      writeFileSync(join(dir, file), text);
    }
    const files = Object.keys(FILES);
    const ctx = {
      root: { path: dir, name: "ws-programs", allowBuildTools: false },
      files: files.filter((f) => /\.(ts|js)$/.test(f)),
      listFiles: () => files,
      readFile: async (rel: string) => FILES[rel] ?? "",
      log: () => undefined,
    };
    nodes = [];
    edges = [];
    for await (const batch of frontend.extract(ctx)) {
      for (const r of batch.records) {
        if ("node" in r) nodes.push(r.node);
        else if ("edge" in r) edges.push(r.edge);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const threadOf = (m: ExecModel, program: string): ExecThread | undefined => m.threads.find((t) => t.id === `main:${program}`);
const runtimeOf = (m: ExecModel, id: string): string => m.functions.find((f) => f.id === id)?.runtime ?? "none";

describe("workspace packages as program entries", () => {
  it("makes the CLI's bin and the server's started file programs, and no library a program", () => {
    const m = execModel(nodes, edges, "");
    expect(m.programs.map((p) => p.id).sort()).toEqual([CLI, SERVER].sort());
    expect(m.programs.every((p) => p.kind === "node")).toBe(true);
    expect(m.programs.some((p) => p.name.includes("packages/lib"))).toBe(false);
  });

  it("keeps the server's started file a program when the CLI also spawns it", () => {
    const m = execModel(nodes, edges, "");
    expect(m.programs.map((p) => p.id)).toContain(SERVER);
    expect(threadOf(m, SERVER)?.roots).toEqual([SERVER_MODULE]);
    expect(m.threads.some((t) => t.spawn?.file === "packages/cli/src/serve.ts" && t.spawn.how === "process")).toBe(true);
  });

  it("puts the library function on the CLI's main thread at whole-project scope", () => {
    const m = execModel(nodes, edges, "");
    const main = threadOf(m, CLI);
    expect(main?.grounded).toBe(true);
    expect(main?.roots).toEqual([CLI_MODULE]);
    expect(main?.reached).toContain(LIB_FN);
    expect(runtimeOf(m, LIB_FN)).toBe("thread");
    expect(m.unthreaded).not.toContain(LIB_FN);
  });

  it("keeps the library function on the CLI's main thread at the library file's scope", () => {
    const m = execModel(nodes, edges, "packages/lib/src/index.ts");
    expect(m.programs.map((p) => p.id)).toContain(CLI);
    const main = threadOf(m, CLI);
    expect(main?.reached).toContain(LIB_FN);
    expect(runtimeOf(m, LIB_FN)).toBe("thread");
    expect(m.unthreaded).not.toContain(LIB_FN);
  });

  it("keeps the library function on the CLI's main thread at its package's scope", () => {
    const m = execModel(nodes, edges, "packages/lib");
    expect(threadOf(m, CLI)?.reached).toContain(LIB_FN);
    expect(runtimeOf(m, LIB_FN)).toBe("thread");
  });

  it("lists only the programs in the scope, with threads computed from the whole project", () => {
    const m = execModel(nodes, edges, "packages/server");
    expect(m.programs.map((p) => p.id)).toEqual([SERVER]);
    expect(m.threads.some((t) => t.id === `main:${CLI}`)).toBe(false);
    expect(runtimeOf(m, LIB_FN)).toBe("thread");
  });
});
