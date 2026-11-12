import { readFile } from "node:fs/promises";
import { join, posix } from "node:path";
import type { ResolveAnswer, ResolveContext, Resolver } from "@insight/sdk";
import { buildModel, closureOf, isBuildFile, joinPath, ownersOf, type BazelTarget } from "./model.js";

/** Reads every BUILD file of the project. Each lookup re-reads them, so an edit is seen at once. */
async function loadModel(ctx: ResolveContext) {
  const texts = new Map<string, string>();
  for (const f of ctx.listFiles()) {
    if (isBuildFile(f)) texts.set(f, await readFile(join(ctx.root.path, f), "utf8"));
  }
  return buildModel(texts, ctx.listFiles());
}

/** The header a target exposes under an include path, through strip_include_prefix and include_prefix. */
function exposedAs(t: BazelTarget, header: string): string {
  let rel = header;
  if (t.stripPrefix !== undefined && header.startsWith(`${t.stripPrefix}/`)) rel = header.slice(t.stripPrefix.length + 1);
  else if (t.pkg !== "" && header.startsWith(`${t.pkg}/`)) rel = header.slice(t.pkg.length + 1);
  return joinPath(t.includePrefix ?? "", rel);
}

/**
 * Answers a C++ include with the headers that the including file's Bazel targets can see. Include
 * directories and header prefixes come from the target and everything it depends on, which is how
 * Bazel itself builds the include path. Returns null when no target explains the include.
 */
export const resolver: Resolver = {
  scheme: "cpp.include",
  priority: 90,
  async resolve(ref, ctx): Promise<ResolveAnswer | null> {
    const model = await loadModel(ctx);
    const owners = ownersOf(model, ctx.fromFile);
    if (owners.length === 0) return null;
    const text = ref.text.replace(/^\.\//, "");
    const matches = new Set<string>();
    const notes = new Set<string>();
    for (const t of closureOf(model, owners)) {
      for (const dir of t.includes) {
        const candidate = posix.normalize(posix.join(dir, text));
        if (ctx.hasFile(candidate)) {
          matches.add(candidate);
          notes.add(`include dir of ${t.id}`);
        }
      }
      for (const header of t.hdrs) {
        if (exposedAs(t, header) === text) {
          matches.add(header);
          notes.add(`header of ${t.id}`);
        }
      }
    }
    if (matches.size === 0) return null;
    return { targets: [...matches].sort(), confidence: "inferred", note: `via Bazel: ${[...notes].sort().join(", ")}` };
  },
};

export default resolver;
