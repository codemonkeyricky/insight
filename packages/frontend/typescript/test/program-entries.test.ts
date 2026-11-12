import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import frontend from "../src/index.js";
import { workspaceProgramEntries, workspaceProgramFiles } from "../src/packages.js";

const json = (value: unknown): string => `${JSON.stringify(value)}\n`;

describe("workspaceProgramEntries", () => {
  it("names a string bin by its package name, and a map bin by its command", () => {
    const manifests = new Map([
      ["packages/cli/package.json", json({ name: "@insight/cli", bin: "./dist/cli.js" })],
      ["packages/server/package.json", json({ name: "@insight/server", bin: { "insight-server": "./dist/main.js" } })],
    ]);
    const rels = new Set(["packages/cli/src/cli.ts", "packages/server/src/main.ts"]);
    const entries = workspaceProgramEntries(manifests, rels);
    expect(entries.get("packages/cli/src/cli.ts")).toEqual({ kind: "bin", pkg: "@insight/cli", name: "@insight/cli" });
    expect(entries.get("packages/server/src/main.ts")).toEqual({ kind: "bin", pkg: "@insight/server", name: "insight-server" });
  });

  it("names a script by its package and script name", () => {
    const manifests = new Map([["packages/tool/package.json", json({ name: "@insight/tool", scripts: { go: "tsx src/run.ts" } })]]);
    const entries = workspaceProgramEntries(manifests, new Set(["packages/tool/src/run.ts"]));
    expect(entries.get("packages/tool/src/run.ts")).toEqual({ kind: "script", pkg: "@insight/tool", name: "go" });
  });

  it("names a file a bin and a script both start by the bin, whichever package lists it", () => {
    const manifests = new Map([
      ["package.json", json({ name: "root", scripts: { start: "node packages/cli/dist/cli.js serve" } })],
      ["packages/cli/package.json", json({ name: "@insight/cli", bin: { insight: "./dist/cli.js" } })],
    ]);
    const entries = workspaceProgramEntries(manifests, new Set(["packages/cli/src/cli.ts"]));
    expect(entries.get("packages/cli/src/cli.ts")).toEqual({ kind: "bin", pkg: "@insight/cli", name: "insight" });
  });

  it("leaves out a target with no source file and a library field", () => {
    const manifests = new Map([["packages/lib/package.json", json({ name: "@insight/lib", main: "./dist/index.js", bin: "./dist/gone.js" })]]);
    const entries = workspaceProgramEntries(manifests, new Set(["packages/lib/src/index.ts"]));
    expect(entries.size).toBe(0);
  });

  it("keeps the set of program files the same as its keys", () => {
    const manifests = new Map([["packages/cli/package.json", json({ name: "@insight/cli", bin: "./dist/cli.js" })]]);
    const rels = new Set(["packages/cli/src/cli.ts"]);
    expect([...workspaceProgramFiles(manifests, rels)]).toEqual(["packages/cli/src/cli.ts"]);
  });
});

describe("frontend program entry facts", () => {
  it("puts the program entry on the module's function fact, and only on a package's program", async () => {
    const FILES: Record<string, string> = {
      "package.json": json({ name: "ws-facts", private: true }),
      "packages/cli/package.json": json({ name: "@insight/cli", bin: "./dist/cli.js" }),
      "packages/cli/src/cli.ts": "console.log(process.argv.length);\n",
      "scripts/capture-demo.mjs": "#!/usr/bin/env node\nconsole.log(process.argv[2]);\n",
    };
    const dir = mkdtempSync(join(tmpdir(), "insight-program-facts-"));
    try {
      for (const [file, text] of Object.entries(FILES)) {
        mkdirSync(dirname(join(dir, file)), { recursive: true });
        writeFileSync(join(dir, file), text);
      }
      const ctx = {
        root: { path: dir, name: "ws-facts", allowBuildTools: false },
        files: Object.keys(FILES),
        listFiles: () => Object.keys(FILES),
        readFile: async (rel: string) => readFileSync(join(dir, rel), "utf8"),
        log: () => undefined,
      };
      const attrs = new Map<string, Record<string, unknown>>();
      for await (const batch of frontend.extract(ctx)) {
        for (const r of batch.records) if ("node" in r && r.node.kind === "structure.function") attrs.set(r.node.id, r.node.attrs ?? {});
      }
      const cli = attrs.get("packages/cli/src/cli.ts#(module)");
      expect(cli?.packageEntry).toBe(true);
      expect(cli?.programEntry).toEqual({ kind: "bin", pkg: "@insight/cli", name: "@insight/cli" });
      const demo = attrs.get("scripts/capture-demo.mjs#(module)");
      expect(demo?.nodeEntry).toBe(true);
      expect(demo?.programEntry).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
