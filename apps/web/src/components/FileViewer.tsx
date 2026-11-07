import { useEffect, useRef, useState } from "react";
import { api, type FileView } from "../api";
import { hrefFile } from "../router";

export const humanSize = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

/** One source file: its lines with the findings flagged, an outline of its symbols, and the line in `line` scrolled to. */
export function FileViewer({ id, path, line }: { id: string; path: string; line?: number }) {
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
