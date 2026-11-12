import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ExtractContext, Frontend, ProjectRoot } from "@insight/sdk";
import { emitUnit } from "./extract.js";
import { buildProject, CPP_RE, disposeProject, FRONTEND_ID } from "./project.js";

export { resolver } from "./resolve.js";

const SKIP_DIRS = new Set(["node_modules", ".git", ".insight", "dist", "build"]);

/** Finds a C or C++ source file within a few levels of the root. */
function findSource(dir: string, depth: number): string | undefined {
  if (depth < 0 || !existsSync(dir)) return undefined;
  const entries = readdirSync(dir, { withFileTypes: true });
  const file = entries.find((e) => e.isFile() && CPP_RE.test(e.name));
  if (file) return file.name;
  for (const entry of entries) {
    if (!entry.isDirectory() || SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
    const hit = findSource(join(dir, entry.name), depth - 1);
    if (hit) return `${entry.name}/${hit}`;
  }
  return undefined;
}

export const frontend: Frontend = {
  id: FRONTEND_ID,
  version: "0.1.0",
  provides: ["structure", "packaging", "flow", "calls", "effects", "concurrency", "sync"],

  async detect(root: ProjectRoot) {
    const hit = findSource(root.path, 3);
    return hit ? { reason: `found ${hit}` } : null;
  },

  async *extract(ctx: ExtractContext) {
    const rels = ctx.listFiles().filter((f) => CPP_RE.test(f));
    const texts = new Map<string, string>();
    for (const rel of rels) texts.set(rel, await ctx.readFile(rel));
    const project = await buildProject(texts);
    try {
      for (const rel of ctx.files) yield emitUnit(project, rel);
    } finally {
      disposeProject(project);
    }
  },
};

export default frontend;
