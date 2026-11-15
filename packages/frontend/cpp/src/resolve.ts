import { posix } from "node:path";
import type { ResolveAnswer, Resolver } from "@insight/sdk";

/** Past this many matches a header name says nothing useful, so the include stays unresolved. */
const MAX_MATCHES = 8;

/**
 * Settles a C or C++ include without a build system. A quoted include is first looked up relative to the
 * including file, then by path suffix among the project's files. An angle-bracket include is not searched
 * relative to the including file (the compiler looks only in the include directories), so it is settled by
 * its exact workspace-root path, or by a suffix match when the name has a directory part (an include
 * directory is then implied). A bare <time.h> names a system header, not a project file. Build-aware frontends
 * (Bazel, CMake) answer with include directories and win when they agree or when this one only guesses.
 */
export const resolver: Resolver = {
  scheme: "cpp.include",
  priority: 10,
  async resolve(ref, ctx): Promise<ResolveAnswer | null> {
    const text = ref.text.replace(/^\.\//, "");
    const system = ctx.attrs?.system === true;
    if (!system) {
      const local = posix.normalize(posix.join(posix.dirname(ctx.fromFile), text));
      if (ctx.hasFile(local)) return { targets: [local], confidence: "inferred", note: "relative to the including file" };
    } else if (ctx.hasFile(text)) {
      return { targets: [text], confidence: "inferred", note: "exact workspace-root path of a system include" };
    }

    if (system && !text.includes("/")) return null;
    const matches = ctx.listFiles().filter((f) => f === text || f.endsWith(`/${text}`));
    if (matches.length === 0 || matches.length > MAX_MATCHES) return null;
    if (matches.length === 1) return { targets: matches, confidence: "inferred", note: "unique header with this path suffix" };
    return { targets: matches, confidence: "heuristic", note: `${matches.length} headers end with this path` };
  },
};

export default resolver;
