import { posix } from "node:path";
import type { ResolveAnswer, Resolver } from "@insight/sdk";

/** Past this many matches a bare file name says nothing useful, so the include stays unresolved. */
const MAX_MATCHES = 8;

/**
 * Settles an `include without a build system: first relative to the including file, then by
 * file name among the project's files. Include directories (+incdir) are not modelled, so a
 * name that matches several files stays heuristic.
 */
export const resolver: Resolver = {
  scheme: "sv.include",
  priority: 10,
  async resolve(ref, ctx): Promise<ResolveAnswer | null> {
    const text = ref.text.replace(/^\.\//, "");
    const local = posix.normalize(posix.join(posix.dirname(ctx.fromFile), text));
    if (ctx.hasFile(local)) return { targets: [local], confidence: "inferred", note: "relative to the including file" };

    const matches = ctx.listFiles().filter((f) => f === text || f.endsWith(`/${text}`));
    if (matches.length === 0 || matches.length > MAX_MATCHES) return null;
    if (matches.length === 1) return { targets: matches, confidence: "inferred", note: "unique file with this path suffix" };
    return { targets: matches, confidence: "heuristic", note: `${matches.length} files end with this path` };
  },
};

export default resolver;
