import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ExtractContext, Frontend, IRBatch, ProjectRoot } from "@insight/sdk";
import { emitUnit } from "./extract.js";
import { buildProject, FRONTEND_ID, SV_RE } from "./project.js";

export { resolver } from "./resolve.js";

/** Source text past which files are not indexed together. Each file is then resolved on its own, and the run says so. */
export const MAX_CROSS_FILE_BYTES = 64 * 1024 * 1024;

const SKIP_DIRS = new Set(["node_modules", ".git", ".insight", "dist", "build"]);

/** Finds a Verilog or SystemVerilog file within a few levels of the root. */
function findSource(dir: string, depth: number): string | undefined {
  if (depth < 0 || !existsSync(dir)) return undefined;
  const entries = readdirSync(dir, { withFileTypes: true });
  const file = entries.find((e) => e.isFile() && SV_RE.test(e.name));
  if (file) return file.name;
  for (const entry of entries) {
    if (!entry.isDirectory() || SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
    const hit = findSource(join(dir, entry.name), depth - 1);
    if (hit) return `${entry.name}/${hit}`;
  }
  return undefined;
}

/**
 * Emits the facts of the files in `ctx.files`. The cross-file index is built once for the project, unless the
 * SystemVerilog text is over `limitBytes`; then each file is indexed on its own, so only same-file calls resolve.
 */
export async function* extractFiles(ctx: ExtractContext, limitBytes: number = MAX_CROSS_FILE_BYTES): AsyncGenerator<IRBatch> {
  const rels = ctx.listFiles().filter((f) => SV_RE.test(f));
  const texts = new Map<string, string>();
  for (const rel of rels) texts.set(rel, await ctx.readFile(rel));
  let bytes = 0;
  for (const text of texts.values()) bytes += Buffer.byteLength(text);
  if (bytes > limitBytes) {
    ctx.log(
      `systemverilog: ${bytes} bytes of source is over the ${limitBytes}-byte cross-file limit; each file is resolved on its own, so calls into other files stay unresolved`,
    );
    for (const rel of ctx.files) {
      const project = await buildProject(new Map([[rel, texts.get(rel) ?? ""]]));
      yield await emitUnit(project, rel);
    }
    return;
  }
  const project = await buildProject(texts);
  for (const rel of ctx.files) yield await emitUnit(project, rel);
}

export const frontend: Frontend = {
  id: FRONTEND_ID,
  version: "0.2.1",
  provides: ["structure", "packaging", "flow", "calls", "effects"],

  async detect(root: ProjectRoot) {
    const hit = findSource(root.path, 3);
    return hit ? { reason: `found ${hit}` } : null;
  },

  async *extract(ctx: ExtractContext) {
    yield* extractFiles(ctx);
  },
};

export default frontend;
