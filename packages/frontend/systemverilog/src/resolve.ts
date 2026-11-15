import type { ResolveAnswer, Resolver } from "@insight/sdk";
import { matchInclude } from "./include-match.js";

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
    const match = matchInclude(ctx.fromFile, ref.text, ctx.listFiles());
    if (match.exact !== undefined) return { targets: [match.exact], confidence: "inferred", note: "relative to the including file" };

    const matches = match.suffix;
    if (matches.length === 0 || matches.length > MAX_MATCHES) return null;
    if (matches.length === 1) return { targets: matches, confidence: "inferred", note: "unique file with this path suffix" };
    return { targets: matches, confidence: "heuristic", note: `${matches.length} files end with this path` };
  },
};

export default resolver;
