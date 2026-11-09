import { useEffect, useRef, useState, type CSSProperties } from "react";
import { api, type FileView } from "../api";
import { hrefFile } from "../router";
import type { LineRange } from "../zoom/chart";

export const humanSize = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

/** A rendered line's class: a range's lines are tinted, the single `line` is marked, and a flagged line keeps its flag. */
export function lineClass(n: number, opts: { line?: number; range?: LineRange; note?: string }): string | undefined {
  if (opts.range !== undefined) {
    if (n >= opts.range.start && n <= opts.range.end) return "hit-range";
  } else if (n === opts.line) return "hit";
  return opts.note !== undefined ? "flag" : undefined;
}

/**
 * One source file: its lines with the findings flagged, an outline of its symbols, and the line in `line` scrolled to. A
 * `range` (1-based, inclusive) is tinted line by line instead, and its first line is scrolled to.
 */
export function FileViewer({ id, path, line, range }: { id: string; path: string; line?: number; range?: LineRange }) {
  const [file, setFile] = useState<FileView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const hit = useRef<HTMLDivElement | null>(null);
  const rangeStart = range?.start;
  const rangeEnd = range?.end;
  const top = rangeStart ?? line;

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
    if (file && top && hit.current) {
      // A range taller than about 80% of the window (19 px a line) starts at its top, so its first line is not cut off.
      const tall = rangeStart !== undefined && rangeEnd !== undefined && rangeEnd - rangeStart + 1 > (window.innerHeight * 0.8) / 19;
      hit.current.scrollIntoView({ block: tall ? "start" : "center" });
    } else if (file && rangeStart === undefined) window.scrollTo({ top: 0 });
  }, [file, top, rangeStart, rangeEnd]);

  if (error) return <p className="error" role="alert">{error}</p>;
  if (!file) return <p className="muted">Loading</p>;
  // The gutter fits the widest line number, so a 1000-line file shows all its digits.
  const digits = String(file.lines.length).length;
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
        <pre className="code" data-testid="file-lines" style={{ "--gutter-ch": digits + 1 } as CSSProperties}>
          {file.lines.map((text, i) => {
            const n = i + 1;
            const note = flagged.get(n);
            return (
              <div key={n} ref={n === top ? hit : undefined} className={lineClass(n, { line, ...(range ? { range } : {}), ...(note ? { note } : {}) })} title={note}>
                <span className="gutter">{n}</span>
                {text}
              </div>
            );
          })}
        </pre>
        {(file.symbols.length > 0 || file.findings.length > 0) && (
          <aside className="outline" aria-label="Outline">
            <details open>
            <summary>Outline</summary>
            {file.symbols.length > 0 && (
              <>
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
            </details>
          </aside>
        )}
      </div>
    </div>
  );
}
