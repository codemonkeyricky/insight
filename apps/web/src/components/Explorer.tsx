import { useEffect, useMemo, useState } from "react";
import type { FileEntry } from "../api";
import { hrefView } from "../router";

/** A folder in the explorer: its subfolders and files, sorted by name. */
export interface Dir {
  name: string;
  path: string;
  dirs: Dir[];
  files: FileEntry[];
}

export function buildTree(files: FileEntry[]): Dir {
  const root: Dir = { name: "", path: "", dirs: [], files: [] };
  for (const f of files) {
    const parts = f.path.split("/");
    let cur = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const path = parts.slice(0, i + 1).join("/");
      let next = cur.dirs.find((d) => d.path === path);
      if (!next) {
        next = { name: parts[i] as string, path, dirs: [], files: [] };
        cur.dirs.push(next);
      }
      cur = next;
    }
    cur.files.push(f);
  }
  const sort = (d: Dir) => {
    d.dirs.sort((a, b) => a.name.localeCompare(b.name));
    d.files.sort((a, b) => a.path.localeCompare(b.path));
    d.dirs.forEach(sort);
  };
  sort(root);
  return root;
}

const countFiles = (d: Dir): number => d.files.length + d.dirs.reduce((n, c) => n + countFiles(c), 0);
const basename = (p: string) => p.slice(p.lastIndexOf("/") + 1);

/** Every folder on the way to a path, outermost first, and the path itself: "a/b.ts" gives ["a", "a/b.ts"]. */
export function prefixesOf(path: string): string[] {
  if (path === "") return [];
  const parts = path.split("/");
  return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
}

interface Links {
  id: string;
  tab: string;
  scope: string;
  isOpen: (dir: Dir) => boolean;
  setOpen: (path: string, open: boolean) => void;
}

function Rows({ dir, links }: { dir: Dir; links: Links }) {
  return (
    <>
      {dir.dirs.map((d) => (
        <details key={d.path} className="dir" open={links.isOpen(d)} onToggle={(e) => links.setOpen(d.path, e.currentTarget.open)}>
          <summary>
            <a
              href={hrefView(links.id, links.tab, { scope: d.path })}
              className={d.path === links.scope ? "node on" : "node"}
              aria-current={d.path === links.scope ? "page" : undefined}
            >
              {d.name}
            </a>{" "}
            <span className="count">{countFiles(d)}</span>
          </summary>
          <div className="dir-kids">
            <Rows dir={d} links={links} />
          </div>
        </details>
      ))}
      {dir.files.map((f) => (
        <a
          key={f.path}
          href={hrefView(links.id, links.tab, { scope: f.path })}
          className={f.path === links.scope ? "file on" : "file"}
          aria-current={f.path === links.scope ? "page" : undefined}
          title={f.path}
        >
          <span className="fname">{basename(f.path)}</span>
          {f.findings > 0 && <span className="count warn" title={`${f.findings} findings`}>{f.findings}</span>}
        </a>
      ))}
    </>
  );
}

/**
 * The source directory tree, kept on the left of every workspace view. Choosing a file or folder
 * sets the scope; the folders above the scope open by themselves.
 */
export function Explorer({ id, tab, scope, files }: { id: string; tab: string; scope: string; files: FileEntry[] }) {
  const [filter, setFilter] = useState("");
  // Folders the user opened or closed by hand. A folder without an entry is open when it lies on the path to the scope, or at the top.
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  const needle = filter.trim().toLowerCase();

  // Choosing a file or folder opens the folders above it, even ones closed by hand before.
  useEffect(() => {
    const above = prefixesOf(scope);
    setToggled((prev) => {
      if (!above.some((p) => p in prev)) return prev;
      const next: Record<string, boolean> = {};
      for (const [p, open] of Object.entries(prev)) if (!above.includes(p)) next[p] = open;
      return next;
    });
  }, [scope]);

  const shown = useMemo(() => (needle ? files.filter((f) => f.path.toLowerCase().includes(needle)) : files), [files, needle]);
  const tree = useMemo(() => buildTree(shown), [shown]);
  const onPath = useMemo(() => new Set(prefixesOf(scope)), [scope]);

  const links: Links = {
    id,
    tab,
    scope,
    // A filter opens every folder so the matches are visible.
    isOpen: (dir) => needle !== "" || (toggled[dir.path] ?? (!dir.path.includes("/") || onPath.has(dir.path))),
    setOpen: (path, open) => setToggled((prev) => (prev[path] === open ? prev : { ...prev, [path]: open })),
  };

  return (
    <nav className="explorer" aria-label="Source explorer">
      <input
        type="search"
        placeholder={`Filter ${files.length} files`}
        aria-label="Filter files"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      <a href={hrefView(id, tab)} className={scope === "" ? "node root on" : "node root"} aria-current={scope === "" ? "page" : undefined}>
        All files <span className="count">{files.length}</span>
      </a>
      <Rows dir={tree} links={links} />
      {shown.length === 0 && <p className="muted small">No file matches.</p>}
    </nav>
  );
}
