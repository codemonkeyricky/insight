import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ExtractContext, Frontend, IRBatch, ProjectRoot } from "@insight/sdk";
import { buildProject, emitFile, FRONTEND_ID, SOURCE_RE } from "./extract.js";
import { apiDigest } from "./digest.js";
import { isWorkspaceManifest } from "./packages.js";

const SKIP_DIRS = new Set(["node_modules", ".git", ".insight", "dist"]);

/** Finds a TypeScript or JavaScript source file within a few levels of the root. */
function findSource(dir: string, depth: number): string | undefined {
  if (depth < 0) return undefined;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && SOURCE_RE.test(entry.name)) return entry.name;
  }
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
    const hit = findSource(join(dir, entry.name), depth - 1);
    if (hit) return `${entry.name}/${hit}`;
  }
  return undefined;
}

export const frontend: Frontend = {
  id: FRONTEND_ID,
  version: "0.2.0",
  provides: ["structure", "packaging", "flow", "calls", "effects", "concurrency"],

  async detect(root: ProjectRoot) {
    for (const name of ["tsconfig.json", "jsconfig.json", "package.json"]) {
      if (existsSync(join(root.path, name))) return { reason: `found ${name}` };
    }
    const hit = findSource(root.path, 2);
    return hit ? { reason: `found ${hit}` } : null;
  },

  async *extract(ctx: ExtractContext): AsyncIterable<IRBatch> {
    const rels = ctx.listFiles().filter((f) => SOURCE_RE.test(f));
    const texts = new Map<string, string>();
    for (const rel of rels) texts.set(join(ctx.root.path, rel), await ctx.readFile(rel));
    // The pages whose script tags load a module's entry: the project's index.html and public/index.html.
    const html = new Map<string, string>();
    for (const page of ["index.html", "public/index.html"]) {
      if (existsSync(join(ctx.root.path, page))) html.set(page, await ctx.readFile(page));
    }
    // The root package.json names the Node scripts of "bin" and "scripts" (see nodeEntryFiles).
    const manifests = new Map<string, string>();
    if (existsSync(join(ctx.root.path, "package.json"))) manifests.set("package.json", await ctx.readFile("package.json"));
    // Every workspace package.json, so a bare import of a workspace package resolves to its source (see packages.ts).
    const packageJsons = new Map<string, string>();
    for (const f of ctx.listFiles()) {
      if (isWorkspaceManifest(f)) packageJsons.set(f, await ctx.readFile(f));
    }
    const project = buildProject(ctx.root.path, rels, texts, html, manifests, packageJsons);
    for (const rel of ctx.files) {
      yield emitFile(project, rel);
    }
  },

  apiDigest,
};

export default frontend;
