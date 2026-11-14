import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ExtractContext, Frontend, ProjectRoot } from "@insight/sdk";

const FRONTEND_ID = "frontend-systemverilog";
const RTL_RE = /\.(v|sv|svh|vh)$/;
const SKIP_DIRS = new Set(["node_modules", ".git", ".insight", "dist", "build"]);

/** Finds a Verilog or SystemVerilog file within a few levels of the root. */
function findSource(dir: string, depth: number): string | undefined {
  if (depth < 0 || !existsSync(dir)) return undefined;
  const entries = readdirSync(dir, { withFileTypes: true });
  const file = entries.find((e) => e.isFile() && RTL_RE.test(e.name));
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
  provides: ["structure"],

  async detect(root: ProjectRoot) {
    const hit = findSource(root.path, 3);
    return hit ? { reason: `found ${hit}` } : null;
  },

  async *extract(ctx: ExtractContext) {
    // Records are filled in a later task; for now each requested file yields an empty batch.
    for (const file of ctx.files) yield { file, records: [] };
  },
};

export default frontend;
