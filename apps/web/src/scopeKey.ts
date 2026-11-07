// Names the demo's per-scope files. The static build (staticApi.ts) and the capture script
// (scripts/capture-demo.mjs) must agree on these names, so both use this module. It has no imports,
// so the capture script can load it directly with Node's type stripping.

/**
 * The key of the project scope. It cannot be a real scope's key: a key is each path segment passed
 * through encodeURIComponent, and that always escapes "@". The name "_root" is not safe, because a
 * top-level folder or file called "_root" would then share the project's files.
 */
export const ROOT_KEY = "@root";

/** A scope path in canonical form: forward slashes, no empty or "." segments. */
export function canonicalScope(scope: string): string {
  return scope
    .replace(/\\/g, "/")
    .split("/")
    .filter((p) => p !== "" && p !== ".")
    .join("/");
}

/** Why a scope path is refused, or undefined when it is fine. The messages match the server's. */
export function scopeProblem(scope: string): string | undefined {
  const raw = scope.replace(/\\/g, "/");
  if (raw.startsWith("/")) return `scope must be relative to the project: ${scope}`;
  if (raw.split("/").includes("..")) return `scope must not leave the project: ${scope}`;
  return undefined;
}

/**
 * The key of a scope's demo files: the canonical path with each segment URI-encoded, or ROOT_KEY for
 * the project. A path that the server would refuse throws, so no file is ever named from "..".
 */
export function scopeKey(scope: string): string {
  const problem = scopeProblem(scope);
  if (problem) throw new Error(problem);
  const canon = canonicalScope(scope);
  return canon === "" ? ROOT_KEY : canon.split("/").map(encodeURIComponent).join("/");
}
