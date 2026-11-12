import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import frontend from "@insight/frontend-typescript";
import type { IREdge, IRNode } from "@insight/ir";
import { buildExecScene, execModel, programHeaderNames, programName, unscopedName, type ExecModel, type Scene, type SceneNode } from "../src/index.js";

describe("programName", () => {
  it("names a bin by its command", () => {
    expect(programName({ kind: "bin", pkg: "@insight/server", name: "insight-server" }, "apps/server/src/main.ts")).toBe("insight-server");
  });

  it("names a plain string bin by its package, without the scope", () => {
    expect(programName({ kind: "bin", pkg: "@insight/cli", name: "@insight/cli" }, "apps/cli/src/cli.ts")).toBe("cli");
  });

  it("names a script by its package and script name", () => {
    expect(programName({ kind: "script", pkg: "@insight/server", name: "start" }, "apps/server/src/main.ts")).toBe("server start");
  });

  it("names a file no package names by its stem", () => {
    expect(programName(undefined, "scripts/capture-demo.mjs")).toBe("capture-demo");
  });

  it("keeps an unscoped package name as it is", () => {
    expect(unscopedName("insight")).toBe("insight");
    expect(unscopedName("@insight/cli")).toBe("cli");
  });
});

describe("programHeaderNames", () => {
  it("names each program, a browser page by its file", () => {
    const names = programHeaderNames([
      { id: "entry:browser", name: "index.html", kind: "browser" },
      { id: "entry:node:apps/cli/src/cli.ts", name: "apps/cli/src/cli.ts", kind: "node", entry: { kind: "bin", pkg: "@insight/cli", name: "insight" } },
    ]);
    expect(names.get("entry:browser")).toBe("index.html");
    expect(names.get("entry:node:apps/cli/src/cli.ts")).toBe("insight");
  });

  it("leaves a build target out", () => {
    const names = programHeaderNames([{ id: "lib:app", name: "app" }]);
    expect(names.has("lib:app")).toBe(false);
  });

  it("appends the entry file stem when two programs would share a name", () => {
    const names = programHeaderNames([
      { id: "a", name: "apps/cli/src/cli.ts", kind: "node", entry: { kind: "bin", pkg: "@scope/cli", name: "@scope/cli" } },
      { id: "b", name: "packages/other/src/index.ts", kind: "node", entry: { kind: "bin", pkg: "@other/cli", name: "@other/cli" } },
    ]);
    expect(names.get("a")).toBe("cli (cli)");
    expect(names.get("b")).toBe("cli (index)");
  });

  it("falls back to the whole file path when the stem does not separate two programs", () => {
    const names = programHeaderNames([
      { id: "a", name: "packages/x/src/tool.ts", kind: "node", entry: { kind: "bin", pkg: "@x/tool", name: "tool" } },
      { id: "b", name: "packages/y/src/tool.ts", kind: "node", entry: { kind: "bin", pkg: "@y/tool", name: "tool" } },
    ]);
    expect(names.get("a")).toBe("packages/x/src/tool.ts");
    expect(names.get("b")).toBe("packages/y/src/tool.ts");
  });
});

// A workspace with no node_modules. The CLI is named by a string bin, the server by a bin map (its script `start` names the
// same file, and the bin wins), a second package by a script, and a root script runs the CLI again. The root's scripts/ file
// no package names is named by its stem. Two packages name a file "cli", so each gets its file's stem.
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const FILES: Record<string, string> = {
  "package.json": json({ name: "ws-labels", private: true, scripts: { start: "node apps/cli/dist/cli.js serve" } }),
  "scripts/capture-demo.mjs": "#!/usr/bin/env node\nconsole.log(process.argv[2] ?? 'demo');\n",
  "apps/cli/package.json": json({ name: "@scope/cli", version: "0.0.0", bin: "./dist/cli.js" }),
  "apps/cli/src/cli.ts": "function run(argv: string[]): number {\n  return argv.length;\n}\n\nconsole.log(run(process.argv.slice(2)));\n",
  "packages/server/package.json": json({ name: "@scope/server", version: "0.0.0", bin: { "scope-server": "./dist/main.js" }, scripts: { start: "node dist/main.js" } }),
  "packages/server/src/main.ts": "export function serve(): number {\n  return 1;\n}\n\nconsole.log(serve());\n",
  "packages/tool/package.json": json({ name: "@scope/tool", version: "0.0.0", scripts: { start: "node dist/run.js" } }),
  "packages/tool/src/run.ts": "export function go(): number {\n  return 2;\n}\n\nconsole.log(go());\n",
  "packages/other/package.json": json({ name: "@other/cli", version: "0.0.0", bin: "./dist/index.js" }),
  "packages/other/src/index.ts": "export function other(): number {\n  return 3;\n}\n\nconsole.log(other());\n",
};

describe("buildExecScene: program frame headers", () => {
  let scene: Scene;
  let headers: SceneNode[];

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "insight-program-names-"));
    try {
      for (const [file, text] of Object.entries(FILES)) {
        mkdirSync(dirname(join(dir, file)), { recursive: true });
        writeFileSync(join(dir, file), text);
      }
      const ctx = {
        root: { path: dir, name: "ws-labels", allowBuildTools: false },
        files: Object.keys(FILES),
        listFiles: () => Object.keys(FILES),
        readFile: async (rel: string) => FILES[rel] ?? "",
        log: () => undefined,
      };
      const nodes: IRNode[] = [];
      const edges: IREdge[] = [];
      for await (const batch of frontend.extract(ctx)) {
        for (const r of batch.records) {
          if ("node" in r) nodes.push(r.node);
          else if ("edge" in r) edges.push(r.edge);
        }
      }
      const model: ExecModel = execModel(nodes, edges, "");
      scene = buildExecScene(model);
      headers = [...scene.nodes.values()].filter((n) => n.kind === "program");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const header = (file: string): SceneNode | undefined => headers.find((n) => n.title === file);

  it("names each Node program by its package, with its entry file as the title", () => {
    expect(header("packages/server/src/main.ts")?.label).toBe("scope-server · Node — 1 thread");
    expect(header("packages/tool/src/run.ts")?.label).toBe("tool start · Node — 1 thread");
    expect(header("scripts/capture-demo.mjs")?.label).toBe("capture-demo · Node — 1 thread");
  });

  it("disambiguates two programs that would both read cli", () => {
    expect(header("packages/other/src/index.ts")?.label).toBe("cli (index) · Node — 1 thread");
    expect(header("apps/cli/src/cli.ts")?.label).toBe("cli (cli) · Node — 1 thread");
  });

  it("gives no two program frames the same header text", () => {
    const labels = headers.map((n) => n.label);
    expect(new Set(labels).size).toBe(labels.length);
  });
});
