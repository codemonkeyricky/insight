import { useEffect, useMemo, useRef, useState } from "react";
import { api, type FileEntry, type FileView } from "../api";
import { ProjectTabs } from "../components/ProjectTabs";
import { hrefFile, hrefProject } from "../router";

interface Dir {
  name: string;
  path: string;
  dirs: Dir[];
  files: FileEntry[];
}

function buildTree(files: FileEntry[]): Dir {
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
const humanSize = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

export function FilesPage({ id, path, line }: { id: string; path?: string; line?: number }) {
  const [files, setFiles] = useState<FileEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    let cancelled = false;
    api
      .files(id)
      .then((f) => !cancelled && setFiles(f))
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [id]);

  const shown = useMemo(() => {
    if (!files) return [];
    const needle = filter.trim().toLowerCase();
    return needle ? files.filter((f) => f.path.toLowerCase().includes(needle)) : files;
  }, [files, filter]);
  const tree = useMemo(() => buildTree(shown), [shown]);

  return (
    <section>
      <nav className="crumbs small">
        <a href={hrefProject(id)}>Project</a> / <span>Files</span>
      </nav>
      <ProjectTabs id={id} active="files" />
      {error && <p className="error" role="alert">{error}</p>}
      {!files && !error && <p className="muted">Loading</p>}
      {files && (
        <div className="files">
          <aside className="filetree" aria-label="Files">
            <input
              type="search"
              placeholder={`Filter ${files.length} files`}
              aria-label="Filter files"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            <DirNode dir={tree} id={id} selected={path} forceOpen={filter.trim() !== ""} top />
            {shown.length === 0 && <p className="muted small">No file matches.</p>}
          </aside>
          <div className="fileview">
            {path ? <FileViewer id={id} path={path} line={line} /> : <FilesHint files={files} id={id} />}
          </div>
        </div>
      )}
    </section>
  );
}

function FilesHint({ files, id }: { files: FileEntry[]; id: string }) {
  const byLang = new Map<string, number>();
  for (const f of files) byLang.set(f.language ?? "Other", (byLang.get(f.language ?? "Other") ?? 0) + 1);
  const busiest = [...files].sort((a, b) => b.functions - a.functions).slice(0, 8);
  return (
    <div className="panel">
      <h2>Pick a file</h2>
      <p className="muted">
        {files.length} files in this snapshot:{" "}
        {[...byLang.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([l, n]) => `${n} ${l}`)
          .join(", ")}
        .
      </p>
      <h3>Most functions</h3>
      <ul className="plain">
        {busiest.map((f) => (
          <li key={f.path}>
            <a className="mono" href={hrefFile(id, f.path)}>{f.path}</a> <span className="muted small">{f.functions} functions</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function DirNode({ dir, id, selected, forceOpen, top }: { dir: Dir; id: string; selected?: string; forceOpen: boolean; top?: boolean }) {
  const inner = (
    <>
      {dir.dirs.map((d) => (
        <DirNode key={d.path} dir={d} id={id} selected={selected} forceOpen={forceOpen} />
      ))}
      {dir.files.map((f) => (
        <a
          key={f.path}
          href={hrefFile(id, f.path)}
          className={f.path === selected ? "file on" : "file"}
          aria-current={f.path === selected ? "page" : undefined}
          title={f.path}
        >
          <span className="fname">{basename(f.path)}</span>
          {f.findings > 0 && <span className="count warn" title={`${f.findings} findings`}>{f.findings}</span>}
        </a>
      ))}
    </>
  );
  if (top) return <div className="dirs">{inner}</div>;
  const open = forceOpen || (selected !== undefined && selected.startsWith(`${dir.path}/`)) || dir.path.split("/").length === 1;
  return (
    // The key on open state makes the browser re-read `open` when the selection or filter changes.
    <details className="dir" open={open} key={`${dir.path}:${open}`}>
      <summary>
        {dir.name}
        <span className="muted small"> {countFiles(dir)}</span>
      </summary>
      <div className="dir-kids">{inner}</div>
    </details>
  );
}

function FileViewer({ id, path, line }: { id: string; path: string; line?: number }) {
  const [file, setFile] = useState<FileView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const hit = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    setFile(null);
    setError(null);
    api
      .file(id, path)
      .then((f) => !cancelled && setFile(f))
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [id, path]);

  useEffect(() => {
    if (file && line && hit.current) hit.current.scrollIntoView({ block: "center" });
    else if (file) window.scrollTo({ top: 0 });
  }, [file, line]);

  if (error) return <p className="error" role="alert">{error}</p>;
  if (!file) return <p className="muted">Loading</p>;
  const flagged = new Map<number, string>();
  for (const f of file.findings) if (f.span) flagged.set(f.span.start[0] + 1, f.message);
  return (
    <div className="panel viewer">
      <header className="viewer-head">
        <div>
          <strong className="mono">{file.file}</strong>
          <div className="muted small">
            {[file.language, `${file.totalLines} lines`, humanSize(file.size)].filter(Boolean).join(" · ")}
          </div>
        </div>
      </header>
      <div className="viewer-body">
        <pre className="code" data-testid="file-lines">
          {file.lines.map((text, i) => {
            const n = i + 1;
            const on = n === line;
            const note = flagged.get(n);
            return (
              <div key={n} ref={on ? hit : undefined} className={on ? "hit" : note ? "flag" : undefined} title={note}>
                <span className="gutter">{n}</span>
                {text}
              </div>
            );
          })}
        </pre>
        {(file.symbols.length > 0 || file.findings.length > 0) && (
          <aside className="outline" aria-label="Outline">
            {file.symbols.length > 0 && (
              <>
                <h3>Outline</h3>
                <ul className="plain">
                  {file.symbols.map((s) => (
                    <li key={s.id}>
                      <a href={hrefFile(id, file.file, s.span.start[0] + 1)}>
                        <span className="kind small">{s.kind.endsWith("type") ? "type" : "fn"}</span> {s.name}
                      </a>{" "}
                      <span className="muted small">{s.span.start[0] + 1}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {file.findings.length > 0 && (
              <>
                <h3>Findings</h3>
                <ul className="plain">
                  {file.findings.map((f) => (
                    <li key={f.id}>
                      <span className={`sev ${f.severity}`}>{f.severity}</span> {f.message}
                      {f.span && (
                        <>
                          {" "}
                          <a className="small" href={hrefFile(id, file.file, f.span.start[0] + 1)}>
                            line {f.span.start[0] + 1}
                          </a>
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </aside>
        )}
      </div>
    </div>
  );
}
