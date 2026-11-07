import { useEffect, useRef, useState } from "react";
import { api, type LensRecord, type LensView, type ScopeStats, type Span, type TargetType } from "../api";
import { AnnotationBox } from "../components/AnnotationBox";
import { GraphCanvas, type GraphPick } from "../components/GraphCanvas";
import { SourcePanel, type SelectedSpan } from "../components/SourcePanel";
import { TreeBlock } from "../components/TreeBlock";
import { canonicalScope } from "../scopeKey";
import { granularityOf, OUTSIDE_SCOPE, plainReason, resultHasContent, scopeBanner } from "../scopeLenses";

/** The node or edge last clicked in a graph view. Its notes are shown beside the source. */
interface Picked {
  type: Extract<TargetType, "node" | "edge">;
  key: string;
  label: string;
}

export interface LensPageProps {
  id: string;
  lensId: string;
  scope: string;
  projectName: string;
  /** The stats of the scope, once its listing has loaded. */
  stats: ScopeStats | null;
  /** Called once a lens has loaded, since running it can change which lenses have results. */
  onLoaded?: () => void;
}

/** One lens on one scope. The result is computed for the scope, so nothing is narrowed here. */
export function LensPage({ id, lensId, scope, projectName, stats, onLoaded }: LensPageProps) {
  const [lens, setLens] = useState<LensRecord | null>(null);
  const [selected, setSelected] = useState<SelectedSpan | null>(null);
  const [picked, setPicked] = useState<Picked | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const onLoadedRef = useRef(onLoaded);

  useEffect(() => {
    onLoadedRef.current = onLoaded;
  }, [onLoaded]);

  useEffect(() => {
    let cancelled = false;
    setLens(null);
    setError(null);
    setSelected(null);
    setPicked(null);
    setNote(null);
    api.scopeLens(id, scope, lensId).then(
      (run) => {
        if (cancelled) return;
        setLens(run.lens);
        onLoadedRef.current?.();
      },
      (e: Error) => {
        if (!cancelled) setError(e.message);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [id, lensId, scope]);

  if (error) return <p className="error" role="alert">{error}</p>;
  if (!lens) return <p className="muted">Loading</p>;

  const label = scope === "" ? projectName : canonicalScope(scope);
  const banner = stats && <p className="scope-banner mono">{scopeBanner(label, stats)}</p>;
  const head = (
    <>
      <h2>{lens.title}</h2>
      {banner}
    </>
  );

  if (lens.status !== "ok" || !lens.result) {
    const failed = lens.status === "error";
    return (
      <section>
        {head}
        <div className="lens-empty" role="status">
          <p>{failed ? "This lens could not run on this scope." : "This lens is not available for this scope."}</p>
          {lens.reason && <p className="muted small">{plainReason(lens.reason, lens.status)}</p>}
        </div>
      </section>
    );
  }

  const result = lens.result;
  const granularity = granularityOf(result.views);
  const metrics = Object.entries(result.metrics);

  const show = (span: Span, text: string) => {
    setNote(null);
    setSelected({ span, label: text });
  };

  const pick = (p: GraphPick) => {
    setPicked({ type: p.kind, key: p.key, label: p.label });
    if (!p.span) {
      setSelected(null);
      setNote(p.kind === "edge" ? `${p.label}: this edge has no source line.` : `${p.label} selected.`);
      return;
    }
    show(p.span, p.label);
  };

  return (
    <section>
      {head}
      {granularity && <p className="muted small">Granularity: {granularity}</p>}
      <div className="split">
        <div className="main">
          {!resultHasContent(result) ? (
            <div className="lens-empty">
              <p>Nothing to show for this scope.</p>
            </div>
          ) : (
            <>
              {result.views.map((view) => (
                <ViewBlock key={view.id} view={view} projectId={id} onPick={pick} onShow={show} />
              ))}
              <h3>Findings</h3>
              {result.findings.length === 0 && (
                <p className="muted">{scope === "" ? "No findings from this lens." : "No findings from this lens in this scope."}</p>
              )}
              <ul className="findings">
                {result.findings.map((f) => (
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
            </>
          )}
          {metrics.length > 0 && (
            <>
              <h3>Metrics</h3>
              <table className="grid">
                <tbody>
                  {metrics.map(([k, v]) => (
                    <tr key={k}>
                      <td>{k}</td>
                      <td className="mono">{String(v)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>
        <div className="side">
          {note && <p className="muted small" role="status">{note}</p>}
          <SourcePanel projectId={id} selected={selected} onClose={() => setSelected(null)} />
          {picked && <AnnotationBox projectId={id} type={picked.type} targetKey={picked.key} title={picked.label} />}
        </div>
      </div>
    </section>
  );
}

function ViewBlock({
  view,
  projectId,
  onPick,
  onShow,
}: {
  view: LensView;
  projectId: string;
  onPick: (p: GraphPick) => void;
  onShow: (s: Span, label: string) => void;
}) {
  if (view.type === "graph") {
    const withSpan = view.edges.filter((e) => e.span !== undefined);
    return (
      <div className="view">
        <h3>{view.title}</h3>
        <GraphCanvas view={view} onPick={onPick} />
        <p className="muted small">
          Click an edge to see its line. Solid green edges have a source line; dashed edges are calls.
        </p>
        {view.nodes.some((n) => n.group === OUTSIDE_SCOPE) && (
          <p className="muted small">
            <span className="swatch outside" aria-hidden="true" /> {OUTSIDE_SCOPE}: modules the scope imports but does not contain.
          </p>
        )}
        {withSpan.length > 0 && (
          <>
            <h4>Import edges</h4>
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
                    <td className="mono break-any">{e.from}</td>
                    <td className="mono break-any">{e.to}</td>
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
        <h3>{view.title}</h3>
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
                    <td key={j} className={String(cell ?? "").length > 30 ? "break-any" : undefined}>
                      {String(cell ?? "")}
                    </td>
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
      <h3>{view.title}</h3>
      <TreeBlock root={view.root} projectId={projectId} onShow={onShow} />
    </div>
  );
}
