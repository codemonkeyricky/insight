import { useEffect, useRef, useState } from "react";
import { api, type FileEntry, type FileFlow, type FileFlowSummary, type FunctionFlow } from "../../api";
import { hrefFile, hrefFlow, hrefView, inScope } from "../../router";
import { FlowChart } from "../FlowChart";
import { scopeKind } from "../ScopeNote";

/** The flow tab: the control-flow chart of one file's function, or a table of flow totals for a folder. */
export function FlowView({ id, files, scope, fn }: { id: string; files: FileEntry[]; scope: string; fn?: string }) {
  if (scopeKind(scope, files) === "file") return <FileFlowView id={id} path={scope} fn={fn} />;
  return <FlowFolders id={id} scope={scope} />;
}

function busiest(fns: FunctionFlow[]): FunctionFlow {
  return fns.reduce((best, f) => (f.stats.decisions + f.stats.loops > best.stats.decisions + best.stats.loops ? f : best));
}

function FileFlowView({ id, path, fn }: { id: string; path: string; fn?: string }) {
  const [flow, setFlow] = useState<FileFlow | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setFlow(null);
    setError(null);
    api
      .flow(id, path)
      .then((f) => !cancelled && setFlow(f))
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [id, path]);

  if (error) return <p className="error" role="alert">{error}</p>;
  if (!flow) return <p className="muted">Loading</p>;
  if (flow.functions.length === 0) return <p className="muted">{path} has no functions, so there is no flow to chart.</p>;
  const selected = flow.functions.find((f) => f.id === fn) ?? busiest(flow.functions);
  return (
    <div>
      <nav className="chips" aria-label="Functions in this file">
        {flow.functions.map((f) => (
          <a
            key={f.id}
            href={hrefView(id, "flow", { scope: path, fn: f.id })}
            className={f.id === selected.id ? "chip on" : "chip"}
            aria-current={f.id === selected.id ? "true" : undefined}
          >
            {f.name} <span className="muted small">{f.stats.decisions + f.stats.loops} branches</span>
          </a>
        ))}
      </nav>
      <FunctionPanel id={id} fn={selected} />
    </div>
  );
}

function FunctionPanel({ id, fn }: { id: string; fn: FunctionFlow }) {
  const s = fn.stats;
  const scroller = useRef<HTMLDivElement>(null);
  // The entry sits in the middle of a wide chart, so the scroll box opens there rather than at its left edge.
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollLeft = (el.scrollWidth - el.clientWidth) / 2;
  }, [fn.id]);
  return (
    <section className="flow-panel">
      <h2>
        {fn.name}
        {fn.async && <span className="kind">async</span>}
      </h2>
      {fn.span && (
        <p className="small">
          <a className="mono" href={hrefFile(id, fn.span.file, fn.span.start[0] + 1)}>
            {fn.span.file}:{fn.span.start[0] + 1}
          </a>
        </p>
      )}
      <div className="stats">
        <Stat label="Steps" value={s.steps} />
        <Stat label="Decisions" value={s.decisions} />
        <Stat label="Loops" value={s.loops} />
        <Stat label="Try blocks" value={s.tries} />
        <Stat label="Exits" value={s.exits} />
        <Stat label="Depth" value={s.depth} />
      </div>
      {fn.tooLarge ? (
        <p className="muted">This function has too many steps to chart. Its source is still one click away.</p>
      ) : fn.nodes.length === 0 ? (
        <p className="muted">No steps to chart.</p>
      ) : (
        <div className="flow-scroll" ref={scroller}>
          <FlowChart id={id} fn={fn} />
        </div>
      )}
      <p className="muted small legend">
        Rounded: start or end. Box: step. Diamond: decision. Hexagon: loop. Dot: join. Red outline: return, throw, break or continue.
        Dashed box: await or spawn. Green arrow: true. Amber arrow: false. Dashed arrow: loop back. Click a step to see its line.
      </p>
    </section>
  );
}

function FlowFolders({ id, scope }: { id: string; scope: string }) {
  const [rows, setRows] = useState<FileFlowSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .flowSummary(id)
      .then((r) => !cancelled && setRows(r))
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (error) return <p className="error" role="alert">{error}</p>;
  if (!rows) return <p className="muted">Loading</p>;
  const shown = rows.filter((r) => inScope(r.file, scope));
  const sum = (k: "functions" | "decisions" | "loops" | "exits") => shown.reduce((n, r) => n + r[k], 0);
  return (
    <section>
      <p className="muted small">Pick a file in the explorer, or a row below, to draw its control flow.</p>
      {shown.length === 0 ? (
        <p className="muted">No function in this scope has a flow to chart.</p>
      ) : (
        <>
          <div className="stats">
            <Stat label="Files with functions" value={shown.length} />
            <Stat label="Functions" value={sum("functions")} />
            <Stat label="Decisions" value={sum("decisions")} />
            <Stat label="Loops" value={sum("loops")} />
            <Stat label="Exits" value={sum("exits")} />
          </div>
          <table className="grid">
            <thead>
              <tr>
                <th>File</th>
                <th>Functions</th>
                <th>Steps</th>
                <th>Decisions</th>
                <th>Loops</th>
                <th>Exits</th>
                <th>Busiest function</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.file}>
                  <td>
                    <a className="mono small" href={hrefFlow(id, r.file)}>
                      {r.file}
                    </a>
                  </td>
                  <td>{r.functions}</td>
                  <td>{r.steps}</td>
                  <td>{r.decisions}</td>
                  <td>{r.loops}</td>
                  <td>{r.exits}</td>
                  <td>
                    {r.busiest ? (
                      <>
                        <a href={hrefView(id, "flow", { scope: r.file, fn: r.busiest.id })}>{r.busiest.name}</a>{" "}
                        <span className="muted small">{r.busiest.branches} branches</span>
                      </>
                    ) : (
                      <span className="muted">none</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="stat">
      <div className="muted small">{label}</div>
      <div className="value">{value}</div>
    </div>
  );
}
