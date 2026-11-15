import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ExtractContext, Frontend, IRBatch, ProjectRoot } from "@insight/sdk";
import { emitUnit } from "./extract.js";
import { buildProject, FRONTEND_ID, indexProject, isHdlText, SV_RE, type Project } from "./project.js";

export { resolver } from "./resolve.js";

/** Source text past which files are not indexed together. Each file is then resolved on its own, and the run says so. */
export const MAX_CROSS_FILE_BYTES = 64 * 1024 * 1024;

const SKIP_DIRS = new Set(["node_modules", ".git", ".insight", "dist", "build"]);

/** How many `.v` files detection reads to tell Verilog from another language. Past this, a `.v` file does not count. */
const MAX_V_READS = 4;

/**
 * Finds the first Verilog or SystemVerilog file within a few levels of the root that `accept` takes. `accept` gets
 * the file's path on disk, and `prefix` is the path of `dir` relative to the root.
 */
function findSource(dir: string, depth: number, accept: (path: string) => boolean, prefix = ""): string | undefined {
  if (depth < 0 || !existsSync(dir)) return undefined;
  const entries = readdirSync(dir, { withFileTypes: true });
  const file = entries.find((e) => e.isFile() && SV_RE.test(e.name) && accept(join(dir, e.name)));
  if (file) return `${prefix}${file.name}`;
  for (const entry of entries) {
    if (!entry.isDirectory() || SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
    const hit = findSource(join(dir, entry.name), depth - 1, accept, `${prefix}${entry.name}/`);
    if (hit) return hit;
  }
  return undefined;
}

/** Total size of the sources from the file system, or undefined when any file cannot be statted. */
function statBytes(ctx: ExtractContext, rels: string[]): number | undefined {
  let total = 0;
  for (const rel of rels) {
    try {
      total += statSync(join(ctx.root.path, rel)).size;
    } catch {
      return undefined;
    }
  }
  return total;
}

/** Each file on its own. Only same-file calls resolve. These indexes are not cached, so they do not evict the project's. */
async function* perFile(ctx: ExtractContext, limitBytes: number, bytes: number): AsyncGenerator<IRBatch> {
  ctx.log(
    `systemverilog: ${bytes} bytes of source is over the ${limitBytes}-byte cross-file limit; each file is resolved on its own, so calls into other files stay unresolved`,
  );
  for (const rel of ctx.files) {
    const text = SV_RE.test(rel) ? await ctx.readFile(rel) : "";
    const project = await indexProject(new Map([[rel, text]]));
    yield await emitUnit(project, rel, text);
  }
}

/**
 * Reads every file and indexes the project. The texts are dropped when this returns, so only the index lives on.
 * Returns the byte count instead when the text is over `limitBytes`, which stops the read early.
 */
async function indexRun(ctx: ExtractContext, rels: string[], limitBytes: number): Promise<{ over: number } | { project: Project }> {
  const texts = new Map<string, string>();
  let bytes = 0;
  for (const rel of rels) {
    const text = await ctx.readFile(rel);
    bytes += Buffer.byteLength(text);
    if (bytes > limitBytes) return { over: bytes };
    texts.set(rel, text);
  }
  return { project: await buildProject(texts) };
}

/**
 * Emits the facts of the files in `ctx.files`. The cross-file index is built once for the project, unless the
 * SystemVerilog text is over `limitBytes`; then each file is indexed on its own, so only same-file calls resolve.
 * The size is taken from the file system first, so an over-limit project is never read whole. The index is kept
 * between runs, keyed by the files' contents, so a retry of the same project (one file at a time) does not parse
 * the project again. Only the index is kept; each file's text is read again when it is emitted.
 */
export async function* extractFiles(ctx: ExtractContext, limitBytes: number = MAX_CROSS_FILE_BYTES): AsyncGenerator<IRBatch> {
  const rels = ctx.listFiles().filter((f) => SV_RE.test(f));
  const known = statBytes(ctx, rels);
  if (known !== undefined && known > limitBytes) {
    yield* perFile(ctx, limitBytes, known);
    return;
  }
  // Sizes not known up front: sum while reading, and stop reading once over the limit.
  const run = await indexRun(ctx, rels, limitBytes);
  if ("over" in run) {
    yield* perFile(ctx, limitBytes, run.over);
    return;
  }
  for (const rel of ctx.files) {
    const text = run.project.units.has(rel) ? await ctx.readFile(rel) : "";
    yield await emitUnit(run.project, rel, text);
  }
}

export const frontend: Frontend = {
  id: FRONTEND_ID,
  version: "0.1.0",
  provides: ["structure", "packaging", "flow", "calls", "effects"],

  async detect(root: ProjectRoot) {
    // A `.v` file counts only when its text is HDL (see isHdlText). Coq also uses `.v`, so the first few are read.
    let vReads = 0;
    const accept = (path: string): boolean => {
      if (!/\.v$/i.test(path)) return true;
      if (vReads >= MAX_V_READS) return false;
      vReads++;
      return isHdlText(path, readFileSync(path, "utf8"));
    };
    const hit = findSource(root.path, 6, accept);
    return hit ? { reason: `found ${hit}` } : null;
  },

  async *extract(ctx: ExtractContext) {
    yield* extractFiles(ctx);
  },
};

export default frontend;
