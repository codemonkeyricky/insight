import { useEffect, useState } from "react";
import { api, type FindingRow, type LensRecord, type LensView, type Project, type Span } from "../api";
import { GraphCanvas, type GraphPick } from "../components/GraphCanvas";
import { SourcePanel, type SelectedSpan } from "../components/SourcePanel";
import { hrefProject } from "../router";

export function LensPage({ id, lensId }: { id: string; lensId: string }) {
  const [project, setProject] = useState<Project | null>(null);
  const [lens, setLens] = useState<LensRecord | null>(null);
  const [findings, setFindings] = useState<FindingRow[]>([]);
  const [selected, setSelected] = useState<SelectedSpan | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSelected(null);
    setNote(null);
    Promise.all([api.project(id), api.lens(id, lensId), api.findings(id, { lens: lensId })])
      .then(([p, l, f]) => {
        if (cancelled) return;
        setProject(p);
        setLens(l);
        setFindings(f);
        setError(null);
      })
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [id, lensId]);

  const show = (span: Span, label: string) => {
    setNote(null);
    setSelected({ span, label });
  };

  const pick = (p: GraphPick) => {
    if (!p.span) {
      setSelected(null);
      setNote(p.kind === "edge" ? `${p.label}: this edge has no source line.` : `${p.label} selected.`);
      return;
    }
    show(p.span, p.label);
  };

  if (error) return <p className="error" role="alert">{error}</p>;
  if (!lens || !project) return <p className="muted">Loading</p>;

  return (
    <section>
      <nav className="crumbs small">
        <a href={hrefProject(id)}>{project.name}</a> / <span>{lens.title}</span>
      </nav>
      <h1>{lens.title}</h1>
      {lens.status !== "ok" && (
        <p className="muted" role="status">
          {lens.status}: {lens.reason}
        </p>
      )}
      <div className="split">
        <div className="main">
          {lens.result?.views.map((view) => (
            <ViewBlock key={view.id} view={view} onPick={pick} onShow={show} />
          ))}
          {lens.result && Object.keys(lens.result.metrics).length > 0 && (
            <>
              <h2>Metrics</h2>
              <table className="grid">
                <tbody>
                  {Object.entries(lens.result.metrics).map(([k, v]) => (
                    <tr key={k}>
                      <td>{k}</td>
                      <td className="mono">{String(v)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
          <h2>Findings</h2>
          {findings.length === 0 && <p className="muted">No findings from this lens.</p>}
          <ul className="findings">
            {findings.map((f) => (
              <li key={f.id}>
                <span className={`sev ${f.severity}`}>{f.severity}</span> {f.message}{" "}
                {f.span && (
                  <button type="button" className="link" onClick={() => show(f.span as Span, f.message)}>
                    show line
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
        <div className="side">
          {note && <p className="muted small" role="status">{note}</p>}
          <SourcePanel projectId={id} selected={selected} onClose={() => setSelected(null)} />
        </div>
      </div>
    </section>
  );
}

function ViewBlock({ view, onPick, onShow }: { view: LensView; onPick: (p: GraphPick) => void; onShow: (s: Span, label: string) => void }) {
  if (view.type === "graph") {
    const withSpan = view.edges.filter((e) => e.span !== undefined);
    return (
      <div className="view">
        <h2>{view.title}</h2>
        <GraphCanvas view={view} onPick={onPick} />
        <p className="muted small">
          Click an edge to see its line. Solid green edges have a source line; dashed edges are calls.
        </p>
        {withSpan.length > 0 && (
          <>
            <h3>Import edges</h3>
            <table className="grid">
              <thead>
                <tr>
                  <th>From</th>
                  <th>To</th>
                  <th>Line</th>
                </tr>
              </thead>
              <tbody>
                {withSpan.map((e, i) => (
                  <tr key={`${e.from}>${e.to}>${i}`}>
                    <td className="mono">{e.from}</td>
                    <td className="mono">{e.to}</td>
                    <td>
                      <button
                        type="button"
                        className="link"
                        onClick={() => onShow(e.span as Span, `${e.from} imports ${e.to}`)}
                      >
                        {(e.span as Span).file}:{(e.span as Span).start[0] + 1}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>
    );
  }
  if (view.type === "table") {
    return (
      <div className="view">
        <h2>{view.title}</h2>
        {view.rows.length === 0 ? (
          <p className="muted">None.</p>
        ) : (
          <table className="grid">
            <thead>
              <tr>
                {view.columns.map((c) => (
                  <th key={c}>{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {view.rows.map((row, i) => (
                <tr key={i}>
                  {row.map((cell, j) => (
                    <td key={j}>{String(cell ?? "")}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    );
  }
  return (
    <div className="view">
      <h2>{view.title}</h2>
      <TreeNode node={view.root} depth={0} />
    </div>
  );
}

function TreeNode({ node, depth }: { node: { label: string; children?: { label: string; children?: unknown[] }[] }; depth: number }) {
  return (
    <div style={{ marginLeft: depth * 16 }}>
      <div>{node.label}</div>
      {node.children?.map((c, i) => (
        <TreeNode key={`${c.label}-${i}`} node={c as typeof node} depth={depth + 1} />
      ))}
    </div>
  );
}
