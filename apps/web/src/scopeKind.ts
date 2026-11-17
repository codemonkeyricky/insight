import type { FileEntry } from "./api";
import { inScope } from "./router";

export type ScopeKind = "project" | "folder" | "file" | "missing";

/** What a scope names in this snapshot: the whole project, a folder, one file, or nothing at all. */
export function scopeKind(scope: string, files: FileEntry[]): ScopeKind {
  if (scope === "") return "project";
  if (files.some((f) => f.path === scope)) return "file";
  return files.some((f) => inScope(f.path, scope)) ? "folder" : "missing";
}
