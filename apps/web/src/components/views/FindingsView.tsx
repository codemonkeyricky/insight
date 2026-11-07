import { useEffect, useState } from "react";
import { api, type FindingRow } from "../../api";
import { hrefFile, inScope } from "../../router";

const LIMIT = 300;

/** Findings whose source line lies in the scope. Findings with no line only show at project scope. */
export function FindingsView({ id, scope }: { id: string; scope: string }) {
  const [rows, setRows] = useState<FindingRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .findings(id)
      .then((r) => !cancelled && setRows(r))
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (error) return <p className="error" role="alert">{error}</p>;
  if (!rows) return <p className="muted">Loading</p>;
  const shown = rows.filter((f) => scope === "" || (f.span !== undefined && inScope(f.span.file, scope)));
  return (
    <section>
      <p className="muted small">
        {shown.length} of {rows.length} findings {scope === "" ? "in the project" : "in this scope"}.
      </p>
      {shown.length === 0 ? (
        <p className="muted">No findings here.</p>
      ) : (
        <table className="grid">
          <thead>
            <tr>
              <th>Severity</th>
              <th>Lens</th>
              <th>Finding</th>
              <th>Where</th>
            </tr>
          </thead>
          <tbody>
            {shown.slice(0, LIMIT).map((f) => (
              <tr key={`${f.lens}:${f.id}`}>
                <td>
                  <span className={`sev ${f.severity}`}>{f.severity}</span>
                </td>
                <td className="mono small">{f.lens}</td>
                <td>{f.message}</td>
                <td>
                  {f.span ? (
                    <a className="mono small" href={hrefFile(id, f.span.file, f.span.start[0] + 1)}>
                      {f.span.file}:{f.span.start[0] + 1}
                    </a>
                  ) : (
                    <span className="muted small">project</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {shown.length > LIMIT && <p className="muted small">Showing the first {LIMIT}.</p>}
    </section>
  );
}
