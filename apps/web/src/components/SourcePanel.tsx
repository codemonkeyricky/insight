import { useEffect, useState } from "react";
import { hrefFile } from "../router";
import { api, type SourceSlice, type Span } from "../api";

export interface SelectedSpan {
  span: Span;
  /** What the user clicked, for the panel heading. */
  label: string;
}

/** Shows the lines of a span with a little context. Lines are shown 1-based; spans in the IR are 0-based. */
export function SourcePanel({ projectId, selected, onClose }: { projectId: string; selected: SelectedSpan | null; onClose: () => void }) {
  const [slice, setSlice] = useState<SourceSlice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!selected) {
      setSlice(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    const start = selected.span.start[0] + 1;
    const end = selected.span.end[0] + 1;
    api
      .source(projectId, selected.span.file, start, end, 3)
      .then((s) => !cancelled && setSlice(s))
      .catch((e: Error) => !cancelled && (setError(e.message), setSlice(null)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [projectId, selected]);

  if (!selected) {
    return (
      <aside className="source empty" aria-label="Source">
        <p>Select a tree node, dependency edge or finding to see the line it comes from.</p>
      </aside>
    );
  }

  const { span } = selected;
  const line = span.start[0] + 1;
  return (
    <aside className="source" aria-label="Source">
      <header>
        <div>
          <strong>{selected.label}</strong>
          <div className="mono muted">
            {span.file}:{line}
          </div>
          <a className="small" href={hrefFile(projectId, span.file, line)}>
            Open in Source
          </a>
        </div>
        <button type="button" onClick={onClose} aria-label="Close source">
          Close
        </button>
      </header>
      {loading && <p className="muted">Loading</p>}
      {error && <p className="error" role="alert">{error}</p>}
      {slice && (
        <pre className="code" data-testid="source-lines">
          {slice.lines.map((text, i) => {
            const n = slice.firstLine + i;
            const hit = n >= slice.highlight.start && n <= slice.highlight.end;
            return (
              <div key={n} className={hit ? "hit" : undefined}>
                <span className="gutter">{n}</span>
                {text}
              </div>
            );
          })}
        </pre>
      )}
    </aside>
  );
}
