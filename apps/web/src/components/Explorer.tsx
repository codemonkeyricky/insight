import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { FileEntry } from "../api";
import { hrefView } from "../router";
import { fileTarget, targetPath, useCodeTarget } from "../codeTarget";
import { fuzzyScore, rankFiles } from "./sheet/fuzzy";

/** Most files a filter lists. */
const RESULT_LIMIT = 100;

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
  /** The tab a file opens in. Folders stay on `tab`. */
  fileTab: string;
  scope: string;
  isOpen: (dir: Dir) => boolean;
  setOpen: (path: string, open: boolean) => void;
  /** The file the code pane shows, marked in the tree when it is not the scope. */
  shownPath?: string;
  /** Shows a file in the code pane. The link still sets the scope, as before. */
  onFile: (path: string) => void;
}

/** A file row's classes: the scope's file is "on"; the file the code pane shows is "shown" when it is not the scope. */
function fileClass(path: string, links: Links): string {
  if (path === links.scope) return "file on";
  return path === links.shownPath ? "file shown" : "file";
}

/** Text with the characters at the indices in `at` wrapped in a mark. */
function Marked({ text, at }: { text: string; at: Set<number> }) {
  const parts: ReactNode[] = [];
  let i = 0;
  while (i < text.length) {
    const hit = at.has(i);
    let j = i + 1;
    while (j < text.length && at.has(j) === hit) j++;
    const chunk = text.slice(i, j);
    parts.push(hit ? <mark key={i}>{chunk}</mark> : <Fragment key={i}>{chunk}</Fragment>);
    i = j;
  }
  return <>{parts}</>;
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
            <span className="badge-count is-neutral">{countFiles(d)}</span>
          </summary>
          <div className="dir-kids">
            <Rows dir={d} links={links} />
          </div>
        </details>
      ))}
      {dir.files.map((f) => (
        <a
          key={f.path}
          href={hrefView(links.id, links.fileTab, { scope: f.path })}
          className={fileClass(f.path, links)}
          aria-current={f.path === links.scope ? "page" : undefined}
          title={f.path}
          onClick={() => links.onFile(f.path)}
        >
          <span className="fname">{basename(f.path)}</span>
          {f.findings > 0 && <span className="badge-count is-warn" title={`${f.findings} findings`}>{f.findings}</span>}
        </a>
      ))}
    </>
  );
}

/**
 * The source directory tree, kept on the left of every workspace view. Choosing a file or folder
 * sets the scope; the folders above the scope open by themselves.
 */
export function Explorer({ id, tab, fileTab = tab, scope, files }: { id: string; tab: string; fileTab?: string; scope: string; files: FileEntry[] }) {
  const [filter, setFilter] = useState("");
  const { target, showCode } = useCodeTarget();
  const shownPath = target ? targetPath(target) : undefined;
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

  const tree = useMemo(() => buildTree(files), [files]);
  const onPath = useMemo(() => new Set(prefixesOf(scope)), [scope]);
  const results = useMemo(() => rankFiles(files, filter, RESULT_LIMIT), [files, filter]);
  // Every file that matches, so the note under a full list can say how many there are.
  const total = useMemo(() => (needle ? files.filter((f) => fuzzyScore(needle, f.path) !== undefined).length : 0), [files, needle]);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  // Keeps the highlighted result in view while the arrow keys move it.
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: "nearest" });
  }, [active, results]);

  const links: Links = {
    id,
    tab,
    fileTab,
    scope,
    isOpen: (dir) => toggled[dir.path] ?? (!dir.path.includes("/") || onPath.has(dir.path)),
    setOpen: (path, open) => setToggled((prev) => (prev[path] === open ? prev : { ...prev, [path]: open })),
    ...(shownPath !== undefined ? { shownPath } : {}),
    onFile: (path) => showCode(fileTarget(path)),
  };

  // Opens a result the way clicking its row does: shows the file in the code pane, then sets the scope.
  const open = (path: string) => {
    links.onFile(path);
    window.location.href = hrefView(id, fileTab, { scope: path });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      setFilter("");
      setActive(0);
      return;
    }
    if (needle === "") return;
    const last = results.length - 1;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.max(0, Math.min(i + 1, last)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(0, Math.min(i - 1, last)));
    } else if (e.key === "Enter" && results[active]) {
      e.preventDefault();
      open(results[active].file.path);
    }
  };

  return (
    <nav className="explorer" aria-label="Source explorer">
      <input
        type="search"
        placeholder={`Filter ${files.length} files`}
        aria-label="Filter files"
        value={filter}
        onChange={(e) => {
          setFilter(e.target.value);
          setActive(0);
        }}
        onKeyDown={onKeyDown}
      />
      <a href={hrefView(id, tab)} className={scope === "" ? "node root on" : "node root"} aria-current={scope === "" ? "page" : undefined}>
        All files <span className="badge-count is-neutral">{files.length}</span>
      </a>
      {needle === "" ? (
        <Rows dir={tree} links={links} />
      ) : (
        <div className="fuzzy-results" role="listbox" aria-label="Matching files" ref={listRef}>
          {results.map(({ file, positions }, i) => {
            const slash = file.path.lastIndexOf("/");
            const nameStart = slash + 1;
            const nameAt = new Set(positions.filter((p) => p >= nameStart).map((p) => p - nameStart));
            const dirAt = new Set(positions.filter((p) => p < slash));
            return (
              <a
                key={file.path}
                role="option"
                aria-selected={i === active}
                href={hrefView(id, fileTab, { scope: file.path })}
                className={fileClass(file.path, links)}
                title={file.path}
                onClick={() => links.onFile(file.path)}
              >
                <span className="fname">
                  <Marked text={file.path.slice(nameStart)} at={nameAt} />
                </span>
                {slash >= 0 && (
                  <span className="fdir">
                    <Marked text={file.path.slice(0, slash)} at={dirAt} />
                  </span>
                )}
                {file.findings > 0 && <span className="badge-count is-warn" title={`${file.findings} findings`}>{file.findings}</span>}
              </a>
            );
          })}
        </div>
      )}
      {total > results.length && <p className="muted small">{`Showing top ${RESULT_LIMIT} of ${total} matches`}</p>}
      {(needle === "" ? files.length === 0 : results.length === 0) && <p className="muted small">No file matches.</p>}
    </nav>
  );
}
