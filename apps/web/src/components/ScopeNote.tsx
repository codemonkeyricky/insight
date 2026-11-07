import type { FileEntry } from "../api";
import { hrefView, inScope } from "../router";

export type ScopeKind = "project" | "folder" | "file" | "missing";

/** What a scope names in this snapshot: the whole project, a folder, one file, or nothing at all. */
export function scopeKind(scope: string, files: FileEntry[]): ScopeKind {
  if (scope === "") return "project";
  if (files.some((f) => f.path === scope)) return "file";
  return files.some((f) => inScope(f.path, scope)) ? "folder" : "missing";
}

const DESCRIBE: Record<ScopeKind, (files: number) => string> = {
  project: (n) => `The whole project, ${n} files.`,
  folder: (n) => `A folder with ${n} files.`,
  file: () => "One file.",
  missing: () => "Nothing at this path in the snapshot.",
};

/** The breadcrumb for the explorer scope, shown above each view that the scope narrows. */
export function ScopeNote({ id, tab, scope, kind, files }: { id: string; tab: string; scope: string; kind: ScopeKind; files: FileEntry[] }) {
  const parts = scope === "" ? [] : scope.split("/");
  const inside = kind === "folder" ? files.filter((f) => inScope(f.path, scope)).length : files.length;
  return (
    <div className="scope">
      <nav className="crumbs small" aria-label="Scope">
        {parts.length === 0 ? <strong>All files</strong> : <a href={hrefView(id, tab)}>All files</a>}
        {parts.map((seg, i) => {
          const path = parts.slice(0, i + 1).join("/");
          const last = i === parts.length - 1;
          return (
            <span key={path}>
              <span className="sep"> / </span>
              {last ? <strong className="mono">{seg}</strong> : <a className="mono" href={hrefView(id, tab, { scope: path })}>{seg}</a>}
            </span>
          );
        })}
      </nav>
      <p className="muted small">{DESCRIBE[kind](inside)}</p>
    </div>
  );
}
