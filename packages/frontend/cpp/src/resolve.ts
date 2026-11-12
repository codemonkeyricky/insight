import { posix } from "node:path";
import type { ResolveAnswer, Resolver } from "@insight/sdk";

/** Past this many matches a header name says nothing useful, so the include stays unresolved. */
const MAX_MATCHES = 8;

/**
 * Settles a C or C++ include without a build system: first relative to the including file, then
 * by path suffix among the project's files. Build-aware frontends (Bazel, CMake) answer with
 * include directories and win when they agree or when this one only guesses.
 */
export const resolver: Resolver = {
  scheme: "cpp.include",
  priority: 10,
  async resolve(ref, ctx): Promise<ResolveAnswer | null> {
    const text = ref.text.replace(/^\.\//, "");
    const local = posix.normalize(posix.join(posix.dirname(ctx.fromFile), text));
    if (ctx.hasFile(local)) return { targets: [local], confidence: "inferred", note: "relative to the including file" };

    const matches = ctx.listFiles().filter((f) => f === text || f.endsWith(`/${text}`));
    if (matches.length === 0 || matches.length > MAX_MATCHES) return null;
    if (matches.length === 1) return { targets: matches, confidence: "inferred", note: "unique header with this path suffix" };
    return { targets: matches, confidence: "heuristic", note: `${matches.length} headers end with this path` };
  },
};

export default resolver;
