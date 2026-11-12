import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IREdge, IRNode } from "@insight/ir";
import type { IRBatch } from "@insight/sdk";
import frontend from "../src/index.js";

/**
 * A workspace of four packages, as pnpm links them. A package imports another by name, through a symlink in
 * node_modules, and the other package's `types` names its built `dist` declarations. `dist` is not indexed, the
 * way the repository's .gitignore leaves it out, so only the source files are listed.
 */
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

const FIXTURE: Record<string, string> = {
  // pkg-a: built with an explicit rootDir and outDir. `extra` is declared in dist but has no source.
  "pkg-a/package.json": json({ name: "pkg-a", version: "0.0.0", type: "module", types: "./dist/index.d.ts" }),
  "pkg-a/tsconfig.json": json({
    compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, rootDir: "src", outDir: "dist" },
    include: ["src"],
  }),
  "pkg-a/src/index.ts": "export function helper(): number {\n  return 1;\n}\n\nexport class Store {\n  save(): void {}\n}\n",
  "pkg-a/dist/index.d.ts": "export declare function helper(): number;\nexport declare class Store {\n    save(): void;\n}\nexport declare function extra(): void;\n",
  // pkg-b: the caller. It imports from pkg-a, pkg-c and pkg-d, and from tool by a relative path to its built file.
  "pkg-b/package.json": json({ name: "pkg-b", version: "0.0.0", type: "module" }),
  "pkg-b/src/main.ts":
    'import { extra, helper, Store } from "pkg-a";\nimport { orphan } from "pkg-c";\nimport { util } from "pkg-d";\nimport { tool } from "../../tool/dist/x.js";\n\n' +
    "export function main(): void {\n  helper();\n  new Store().save();\n  extra();\n}\n\n" +
    "export function other(): void {\n  orphan();\n  util();\n  tool();\n}\n",
  // tool: a folder with a tsconfig.json and no package.json, so only the config marks it as the owner of its output.
  "tool/tsconfig.json": json({
    compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, rootDir: "src", outDir: "dist" },
    include: ["src"],
  }),
  "tool/src/x.ts": 'export function tool(): string {\n  return "t";\n}\n',
  "tool/dist/x.d.ts": "export declare function tool(): string;\n",
  // pkg-c: a built declaration with no source file at all. Today's behaviour: no edge.
  "pkg-c/package.json": json({ name: "pkg-c", version: "0.0.0", type: "module", types: "./dist/index.d.ts" }),
  "pkg-c/dist/index.d.ts": "export declare function orphan(): void;\n",
  // pkg-d: no tsconfig.json, so the output is dist and the source is src.
  "pkg-d/package.json": json({ name: "pkg-d", version: "0.0.0", type: "module", types: "./dist/util.d.ts" }),
  "pkg-d/src/util.ts": "export function util(): void {}\n",
  "pkg-d/dist/util.d.ts": "export declare function util(): void;\n",
};

/** The source files the frontend is given, as core lists them: built output is never among them. */
const SOURCES = ["pkg-a/src/index.ts", "pkg-b/src/main.ts", "pkg-d/src/util.ts", "tool/src/x.ts"];

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "insight-decl-"));
  for (const [rel, text] of Object.entries(FIXTURE)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  // pnpm's layout: each workspace package is a symlink in node_modules, pointing at its package folder.
  mkdirSync(join(root, "node_modules"), { recursive: true });
  for (const name of ["pkg-a", "pkg-c", "pkg-d"]) symlinkSync(join("..", name), join(root, "node_modules", name), "dir");
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

interface Extracted {
  batches: IRBatch[];
  edges: IREdge[];
  nodes: IRNode[];
}

/** Every batch, edge and node the frontend emits for the fixture's source files. */
async function extract(): Promise<Extracted> {
  const readFile = async (rel: string) => readFileSync(join(root, rel), "utf8");
  const ctx = {
    root: { path: root, name: "decl-fixture", allowBuildTools: false },
    files: SOURCES,
    listFiles: () => [...SOURCES],
    readFile,
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

/** `from -> to` for each calls.call edge, sorted. */
function calls(all: IREdge[]): string[] {
  return all
    .filter((e) => e.kind === "calls.call")
    .map((e) => `${e.from} -> ${typeof e.to === "string" ? e.to : JSON.stringify(e.to)}`)
    .sort();
}

describe("calls through a workspace package's built declarations", () => {
  it("maps each call to the function or method its source declares, and to nothing else", async () => {
    const { edges } = await extract();
    expect(calls(edges)).toEqual(
      [
        "pkg-b/src/main.ts#main -> pkg-a/src/index.ts#helper",
        "pkg-b/src/main.ts#main -> pkg-a/src/index.ts#Store.save",
        "pkg-b/src/main.ts#other -> pkg-d/src/util.ts#util",
        "pkg-b/src/main.ts#other -> tool/src/x.ts#tool",
      ].sort(),
    );
  });

  it("points the call at a function node that the source file emits", async () => {
    const { nodes } = await extract();
    const helper = nodes.find((n) => n.id === "pkg-a/src/index.ts#helper");
    expect(helper?.kind).toBe("structure.function");
    expect(nodes.find((n) => n.id === "pkg-a/src/index.ts#Store.save")?.kind).toBe("structure.function");
  });

  it("makes the calling file depend on the source file it now calls, so an edit there re-extracts the caller", async () => {
    const { batches } = await extract();
    const main = batches.find((b) => b.file === "pkg-b/src/main.ts");
    expect(main?.dependsOn).toEqual(expect.arrayContaining(["pkg-a/src/index.ts", "pkg-d/src/util.ts", "tool/src/x.ts"]));
  });

  it("keeps today's behaviour for a declaration with no indexed source: no edge, and none into dist", async () => {
    const { edges } = await extract();
    const unmapped = calls(edges).filter((c) => c.includes("orphan") || c.includes("extra") || c.includes("/dist/"));
    expect(unmapped).toEqual([]);
  });
});
