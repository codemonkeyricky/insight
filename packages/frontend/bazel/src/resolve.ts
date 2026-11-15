import { readFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { externalsForInclude, type CppExternal, type ResolveAnswer, type ResolveContext, type Resolver } from "@insight/sdk";
import { buildModel, closureOf, isBuildFile, joinPath, ownersOf, type BazelModel, type BazelTarget } from "./model.js";
import { EXTERNAL_FILES, externalIdOf, mainRepoNames, parseExternals, repoOf, type Externals } from "./externals.js";

/** An external repository, by id, with the name and repo_name that an include path can match. */
export type ExternalName = CppExternal;

/**
 * The external repositories an include path names, by id. The rules are shared with the other build-system
 * frontends (see externalsForInclude in @insight/sdk): a path with one segment names none, and a known module
 * prefix matches the module's external before the first segment is tried as a name or repo_name.
 */
export function externalMatches(include: string, externals: ExternalName[]): string[] {
  return externalsForInclude(include, externals).map((m) => m.id);
}

/**
 * Loads a value once per link run when the run supplies runCache (see ResolveContext.runCache). The Promise is stored,
 * so resolves that run at once share one load, and a failed load is not kept. Without runCache it loads on every call.
 */
function memoPerRun<T>(ctx: ResolveContext, key: string, load: () => Promise<T>): Promise<T> {
  const cache = ctx.runCache;
  if (cache === undefined) return load();
  const hit = cache.get(key);
  if (hit !== undefined) return hit as Promise<T>;
  const pending = load().catch((err: unknown) => {
    cache.delete(key);
    throw err;
  });
  cache.set(key, pending);
  return pending;
}

/** Reads every BUILD file (and MODULE.bazel for the main repo's names) and builds the model. Once per link run when the run has a runCache. */
function loadModel(ctx: ResolveContext): Promise<BazelModel> {
  return memoPerRun(ctx, "frontend-bazel:model", async () => {
    const files = ctx.listFiles();
    const texts = new Map<string, string>();
    for (const f of files) {
      if (isBuildFile(f)) texts.set(f, await readFile(join(ctx.root.path, f), "utf8"));
    }
    const moduleTexts = new Map<string, string>();
    if (files.includes("MODULE.bazel")) moduleTexts.set("MODULE.bazel", await readFile(join(ctx.root.path, "MODULE.bazel"), "utf8"));
    return buildModel(texts, files, mainRepoNames(moduleTexts));
  });
}

/** Reads the declarations of the external repositories, as the frontend does. Once per link run with a runCache. */
function loadExternals(ctx: ResolveContext): Promise<Externals> {
  return memoPerRun(ctx, "frontend-bazel:externals", async () => {
    const texts = new Map<string, string>();
    const files = ctx.listFiles();
    for (const f of EXTERNAL_FILES) {
      if (files.includes(f)) texts.set(f, await readFile(join(ctx.root.path, f), "utf8"));
    }
    return parseExternals(texts);
  });
}

/**
 * The header a target exposes under an include path, through strip_include_prefix and include_prefix. Without
 * strip_include_prefix a header keeps its workspace-relative path (absl/base/config.h stays absl/base/config.h),
 * because the workspace root is on the include path. The exception: with include_prefix and no
 * strip_include_prefix, Bazel strips the package directory first (CcCompilationHelper defaults the strip to the
 * package), so third_party/z/x.h with include_prefix "zlib" is exposed as zlib/x.h.
 */
function exposedAs(t: BazelTarget, header: string): string {
  const strip = t.stripPrefix ?? (t.includePrefix !== undefined ? t.pkg : undefined);
  let rel = header;
  if (strip !== undefined && strip !== "" && header.startsWith(`${strip}/`)) rel = header.slice(strip.length + 1);
  return joinPath(t.includePrefix ?? "", rel);
}

/**
 * The external repositories that the targets of a closure depend on. Only cc targets record their external
 * dependencies as dep-edges, so only they count here, as the graph does.
 */
function externalsOfClosure(closure: BazelTarget[], externals: Externals): Set<string> {
  const ids = new Set<string>();
  for (const t of closure) {
    if (!t.cc) continue;
    for (const label of t.externalDeps) {
      const repo = repoOf(label);
      const id = repo === undefined ? undefined : externalIdOf(repo, externals);
      if (id !== undefined) ids.add(id);
    }
  }
  return ids;
}

/**
 * Answers a C++ include with the headers that the including file's Bazel targets can see. Include
 * directories and header prefixes come from the target and everything it depends on, which is how
 * Bazel itself builds the include path. When no in-repository header explains the include, it answers
 * with an external repository that the same targets depend on. Returns null when neither does.
 */
export const resolver: Resolver = {
  scheme: "cpp.include",
  priority: 90,
  async resolve(ref, ctx): Promise<ResolveAnswer | null> {
    const model = await loadModel(ctx);
    const owners = ownersOf(model, ctx.fromFile);
    const closure = closureOf(model, owners);
    const text = ref.text.replace(/^\.\//, "");
    const matches = new Set<string>();
    const notes = new Set<string>();
    for (const t of closure) {
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
    if (matches.size > 0) {
      return { targets: [...matches].sort(), confidence: "inferred", note: `via Bazel: ${[...notes].sort().join(", ")}` };
    }

    // No owner target: every declared external is a candidate. Otherwise, only those the closure depends on.
    const externals = await loadExternals(ctx);
    const scope = owners.length === 0 ? [...externals.entries.keys()] : [...externalsOfClosure(closure, externals)];
    const candidates: ExternalName[] = [];
    for (const id of scope) {
      const decl = externals.entries.get(id);
      if (decl === undefined || !ctx.hasNode(id)) continue;
      const repoName = decl.attrs.repoName;
      candidates.push({ id, name: String(decl.attrs.name), ...(repoName !== undefined ? { repoName: String(repoName) } : {}) });
    }
    const ids = externalMatches(text, candidates);
    if (ids.length === 0) return null;
    // Through an owner's dependency closure the external is declared as a dependency: inferred. With no
    // owner, any declared external may match, which is only a guess: heuristic.
    return {
      targets: ids,
      confidence: owners.length === 0 ? "heuristic" : "inferred",
      note: `external repository: ${ids.join(", ")}`,
    };
  },
};

export default resolver;
