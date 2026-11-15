import type { ResolveAnswer, Resolver } from "@insight/sdk";
import { indexIncludes, matchInclude, type IncludeIndex } from "./include-match.js";

/** Past this many matches a bare file name says nothing useful, so the include stays unresolved. */
const MAX_MATCHES = 8;

/**
 * The include index of each project's file list, keyed by the list's object. The core passes the same list on every
 * call. The cache assumes the list is never changed in place: a changed list must be a new array, which gets a new index.
 */
const indexes = new WeakMap<string[], IncludeIndex>();

/** How many include indexes the resolver has built. Tests read it to check the cache. */
export const resolveStats = { indexBuilds: 0 };

/** The include index of a file list, built on first use and reused for each later call with the same array. */
function indexFor(files: string[]): IncludeIndex {
  let index = indexes.get(files);
  if (index === undefined) {
    resolveStats.indexBuilds++;
    index = indexIncludes(files);
    indexes.set(files, index);
  }
  return index;
}

/**
 * Settles an `include without a build system: first relative to the including file, then by
 * file name among the project's files. Include directories (+incdir) are not modelled, so a
 * name that matches several files stays heuristic.
 */
export const resolver: Resolver = {
  scheme: "sv.include",
  priority: 10,
  async resolve(ref, ctx): Promise<ResolveAnswer | null> {
    const match = matchInclude(ctx.fromFile, ref.text, indexFor(ctx.listFiles()));
    if (match.exact !== undefined) return { targets: [match.exact], confidence: "inferred", note: "relative to the including file" };

    const matches = match.suffix;
    if (matches.length === 0 || matches.length > MAX_MATCHES) return null;
    if (matches.length === 1) return { targets: matches, confidence: "inferred", note: "unique file with this path suffix" };
    return { targets: matches, confidence: "heuristic", note: `${matches.length} files end with this path` };
  },
};

export default resolver;
