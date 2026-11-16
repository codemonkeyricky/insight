/**
 * The one normalizer for a caller-supplied scope path, shared by the local server's coupling route, the hosted
 * Function's `/api/coupling` and the CLI's `insight coupling`. A scope is a project-relative path using `/`; `""` (or
 * `.`) is the whole project.
 *
 * Both routes used to normalize on their own and had already diverged: one stripped a leading `/`, the other refused
 * it. This one policy is therefore deliberately explicit: a leading slash is refused rather than stripped (`/apps` and
 * `apps` never name different things), and `..` is refused after backslash conversion, even when the request also
 * carries `fn=`. Prefer @insight/flow over @insight/indexer as the home: every caller already depends on flow, while
 * indexer would pull better-sqlite3 into the hosted Function's bundle.
 */
export class ScopeInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScopeInputError";
  }
}

/** The canonical scope, or a ScopeInputError when the path is absolute or leaves the project. */
export function normalizeScopeInput(scope: string): string {
  const raw = scope.replace(/\\/g, "/");
  if (raw.startsWith("/")) throw new ScopeInputError(`scope must be relative to the project: ${scope}`);
  const parts = raw.split("/").filter((part) => part !== "" && part !== ".");
  if (parts.includes("..")) throw new ScopeInputError(`scope must not leave the project: ${scope}`);
  return parts.join("/");
}
