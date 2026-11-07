import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type FindingRow, type Overview } from "../api";
import { useProjectEvents, type RunEvent } from "../useEvents";
import { hrefLens } from "../router";
import { StatusBadge } from "./Projects";

const LOG_LIMIT = 200;

export function ProjectOverviewPage({ id }: { id: string }) {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [findings, setFindings] = useState<FindingRow[]>([]);
  const [log, setLog] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [full, setFull] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [o, f] = await Promise.all([api.overview(id), api.findings(id)]);
      setOverview(o);
      setFindings(f);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [id]);

  useEffect(() => {
    setLog([]);
    void load();
  }, [id, load]);

  useProjectEvents(id, (event: RunEvent) => {
    if (event.type === "progress" && event.line) {
      setLog((prev) => [...prev.slice(-(LOG_LIMIT - 1)), `${event.at.slice(11, 19)}  ${event.line}`]);
    }
    if (event.type === "done" || event.type === "failed" || event.type === "status") {
      void load();
    }
  });

  const grouped = useMemo(() => {
    const byLens = new Map<string, FindingRow[]>();
    for (const f of findings) {
      const list = byLens.get(f.lens) ?? [];
      list.push(f);
      byLens.set(f.lens, list);
    }
    return [...byLens.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [findings]);

  if (error && !overview) return <p className="error" role="alert">{error}</p>;
  if (!overview) return <p className="muted">Loading</p>;
  const p = overview.project;
  const sourceText = p.source.kind === "path" ? p.source.path : p.source.url;

  const reindex = async () => {
    setBusy(true);
    try {
      await api.reindex(id, full);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <div className="head">
        <div>
          <h1>{p.name}</h1>
          <div className="mono muted small">{sourceText}</div>
        </div>
        <div className="actions">
          <StatusBadge project={p} />
          <label className="check small">
            <input type="checkbox" checked={full} onChange={(e) => setFull(e.target.checked)} /> full
          </label>
          <button type="button" onClick={() => void reindex()} disabled={busy}>
            Re-index
          </button>
        </div>
      </div>
      {p.error && <p className="error" role="alert">Last run failed: {p.error}</p>}
      {error && <p className="error" role="alert">{error}</p>}

      <div className="stats">
        <Stat label="Nodes" value={overview.snapshot?.nodes} />
        <Stat label="Edges" value={overview.snapshot?.edges} />
        <Stat label="Findings" value={overview.findings.total} />
        <Stat
          label="Commit"
          value={
            overview.snapshot?.commit
              ? `${overview.snapshot.commit.slice(0, 10)}${p.last?.dirty ? " + uncommitted changes" : ""}`
              : "none"
          }
        />
        <Stat label="Indexed" value={p.last ? new Date(p.last.finishedAt).toLocaleString() : "never"} />
      </div>

      <h2>Run log</h2>
      <pre className="log" aria-live="polite" data-testid="run-log">
        {log.length === 0 ? "No run in this session yet. Re-index to see progress." : log.join("\n")}
      </pre>

      <h2>Lenses</h2>
      <table className="grid">
        <thead>
          <tr>
            <th>Lens</th>
            <th>Status</th>
            <th>Findings</th>
            <th>Detail</th>
          </tr>
        </thead>
        <tbody>
          {overview.lenses.map((l) => (
            <tr key={l.id}>
              <td>{l.title}</td>
              <td>
                <span className={`badge ${l.status}`}>{l.status}</span>
                {l.reused && <span className="muted small"> reused</span>}
              </td>
              <td>{l.findings}</td>
              <td>
                {l.status === "ok" ? (
                  <a href={hrefLens(id, l.id)}>Open</a>
                ) : (
                  <span className="muted small">{l.reason}</span>
                )}
              </td>
            </tr>
          ))}
          {overview.lenses.length === 0 && (
            <tr>
              <td colSpan={4} className="muted">No lens results yet.</td>
            </tr>
          )}
        </tbody>
      </table>

      <h2>Coverage</h2>
      {overview.coverage.length === 0 ? (
        <p className="muted">Coverage is shown for the run that wrote the current snapshot.</p>
      ) : (
        <table className="grid">
          <thead>
            <tr>
              <th>Facet</th>
              <th>Provided by</th>
              <th>Files</th>
              <th>With records</th>
              <th>Errors</th>
              <th>Nodes</th>
              <th>Edges</th>
            </tr>
          </thead>
          <tbody>
            {overview.coverage.map((c) => (
              <tr key={c.facet}>
                <td className="mono">{c.facet}</td>
                <td>{c.providers.length > 0 ? c.providers.join(", ") : <span className="muted">none</span>}</td>
                <td>{c.filesScanned}</td>
                <td>{c.filesWithRecords}</td>
                <td>{c.filesWithErrors}</td>
                <td>{c.nodes}</td>
                <td>{c.edges}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {overview.problems.length > 0 && (
        <>
          <h3>Validator problems</h3>
          <ul className="problems">
            {overview.problems.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        </>
      )}

      <h2>Findings</h2>
      {grouped.length === 0 && <p className="muted">No findings.</p>}
      {grouped.map(([lens, rows]) => (
        <div key={lens} className="group">
          <h3>
            {lens === "index" ? "Index" : (overview.lenses.find((l) => l.id === lens)?.title ?? lens)}{" "}
            <span className="muted small">({rows.length})</span>
          </h3>
          <ul className="findings">
            {rows.slice(0, 25).map((f) => (
              <li key={f.id}>
                <span className={`sev ${f.severity}`}>{f.severity}</span> {f.message}
                {f.span && (
                  <span className="mono muted small">
                    {" "}
                    {f.span.file}:{f.span.start[0] + 1}
                  </span>
                )}
              </li>
            ))}
          </ul>
          {rows.length > 25 && lens !== "index" && (
            <a href={hrefLens(id, lens)}>All {rows.length} findings</a>
          )}
        </div>
      ))}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string | number | undefined }) {
  return (
    <div className="stat">
      <div className="muted small">{label}</div>
      <div className="value">{value ?? "none"}</div>
    </div>
  );
}
