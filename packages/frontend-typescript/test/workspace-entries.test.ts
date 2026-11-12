import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IREdge, IRNode } from "@insight/ir";
import type { IRBatch } from "@insight/sdk";
import frontend from "../src/index.js";
import { isWorkspaceManifest, workspacePackages, workspaceSource } from "../src/packages.js";

/**
 * A workspace with no node_modules, as the hosted indexer sees a GitHub tarball. `@scope/a` names its build output as
 * `main` and has source beside it. `@scope/c` has an exports map with a subpath. `@scope/b` imports both and calls them.
 */
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

const FIXTURE: Record<string, string> = {
  "packages/a/package.json": json({ name: "@scope/a", version: "0.0.0", main: "dist/index.js" }),
  "packages/a/src/index.ts": "export function greet(name: string): string {\n  return `hi ${name}`;\n}\n",
  "packages/a/dist/index.js": "export function greet(name) { return `hi ${name}`; }\n",
  "packages/a/dist/index.d.ts": "export declare function greet(name: string): string;\n",
  "packages/c/package.json": json({
    name: "@scope/c",
    version: "0.0.0",
    exports: {
      ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
      "./sub": { types: "./dist/sub.d.ts", import: "./dist/sub.js" },
    },
  }),
  "packages/c/src/index.ts": 'export const VERSION = "1";\n',
  "packages/c/src/sub.ts": "export function sum(a: number, b: number): number {\n  return a + b;\n}\n",
  "packages/c/dist/sub.d.ts": "export declare function sum(a: number, b: number): number;\n",
  "packages/b/package.json": json({ name: "@scope/b", version: "0.0.0" }),
  "packages/b/src/main.ts":
    'import { greet } from "@scope/a";\nimport { sum } from "@scope/c/sub";\nimport { missing } from "left-pad";\n\n' +
    "export function run(): string {\n  return greet(String(sum(1, missing(2))));\n}\n",
};

const SOURCES = ["packages/a/src/index.ts", "packages/c/src/index.ts", "packages/c/src/sub.ts", "packages/b/src/main.ts"];
const MANIFESTS = ["packages/a/package.json", "packages/b/package.json", "packages/c/package.json"];

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "insight-ws-entries-"));
  for (const [rel, text] of Object.entries(FIXTURE)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

interface Extracted {
  batches: IRBatch[];
  edges: IREdge[];
  nodes: IRNode[];
}

/** Every record the frontend emits for the fixture's source files. The package.json files are listed, as the scanner lists them. */
async function extract(): Promise<Extracted> {
  const files = [...SOURCES, ...MANIFESTS];
  const ctx = {
    root: { path: root, name: "ws-entries", allowBuildTools: false },
    files: SOURCES,
    listFiles: () => [...files],
    readFile: async (rel: string) => readFileSync(join(root, rel), "utf8"),
    log: () => undefined,
  };
  const out: Extracted = { batches: [], edges: [], nodes: [] };
  for await (const batch of frontend.extract(ctx)) {
    out.batches.push(batch);
    for (const record of batch.records) {
      if ("edge" in record) out.edges.push(record.edge);
      if ("node" in record) out.nodes.push(record.node);
    }
  }
  return out;
}

describe("workspace package map", () => {
  const manifests = (): Map<string, string> => new Map(MANIFESTS.map((m) => [m, readFileSync(join(root, m), "utf8")] as const));

  it("keys packages by name with their directory and fields", () => {
    const packages = workspacePackages(manifests());
    expect(packages.get("@scope/a")).toMatchObject({ dir: "packages/a", main: "dist/index.js" });
    expect(packages.get("@scope/c")?.exports).toBeDefined();
    expect(packages.has("left-pad")).toBe(false);
  });

  it("skips fixture, sample, dependency and worktree manifests", () => {
    expect(isWorkspaceManifest("packages/a/package.json")).toBe(true);
    expect(isWorkspaceManifest("package.json")).toBe(true);
    expect(isWorkspaceManifest("packages/x/test/fixtures/y/package.json")).toBe(false);
    expect(isWorkspaceManifest("samples/benchmark/package.json")).toBe(false);
    expect(isWorkspaceManifest("node_modules/left-pad/package.json")).toBe(false);
    expect(isWorkspaceManifest(".claude/worktrees/w/package.json")).toBe(false);
  });

  it("maps a main build output to its source, and an exports subpath to its source", () => {
    const packages = workspacePackages(manifests());
    const rels = new Set(SOURCES);
    expect(workspaceSource(packages, "@scope/a", rels)).toBe("packages/a/src/index.ts");
    expect(workspaceSource(packages, "@scope/c", rels)).toBe("packages/c/src/index.ts");
    expect(workspaceSource(packages, "@scope/c/sub", rels)).toBe("packages/c/src/sub.ts");
    // A subpath with no source is not guessed at, and a bare name no workspace package has resolves to nothing here.
    expect(workspaceSource(packages, "@scope/c/missing", rels)).toBeUndefined();
    expect(workspaceSource(packages, "left-pad", rels)).toBeUndefined();
  });
});

describe("bare imports of workspace packages without node_modules", () => {
  it("resolves an import of a workspace package's root to its source file", async () => {
    const { edges } = await extract();
    const imp = edges.find((e) => e.kind === "packaging.import" && e.from === "packages/b/src/main.ts" && e.to === "packages/a/src/index.ts");
    expect(imp).toBeDefined();
  });

  it("resolves a subpath import through an exports map to the subpath's source file", async () => {
    const { edges } = await extract();
    const imp = edges.find((e) => e.kind === "packaging.import" && e.from === "packages/b/src/main.ts" && e.to === "packages/c/src/sub.ts");
    expect(imp).toBeDefined();
  });

  it("keeps an import no workspace package matches unresolved, with its specifier as text", async () => {
    const { edges } = await extract();
    const imp = edges.find((e) => e.kind === "packaging.import" && e.from === "packages/b/src/main.ts" && typeof e.to === "object" && "unresolved" in e.to && e.to.unresolved.text === "left-pad");
    expect(imp).toBeDefined();
    expect(JSON.stringify(imp?.to)).not.toContain("object Object");
  });

  it("gives calls through a workspace import an edge to the source function", async () => {
    const { edges } = await extract();
    const toGreet = edges.find((e) => e.kind === "calls.call" && e.from === "packages/b/src/main.ts#run" && e.to === "packages/a/src/index.ts#greet");
    const toSum = edges.find((e) => e.kind === "calls.call" && e.from === "packages/b/src/main.ts#run" && e.to === "packages/c/src/sub.ts#sum");
    expect(toGreet).toBeDefined();
    expect(toSum).toBeDefined();
  });

  it("never stores an object as an import target text", async () => {
    const { edges } = await extract();
    for (const e of edges) {
      if (e.kind !== "packaging.import") continue;
      expect(typeof e.to === "string" || "candidates" in (e.to as object) || "unresolved" in (e.to as object)).toBe(true);
    }
  });
});
