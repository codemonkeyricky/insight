import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, type FileEntry, type FileFlowSummary, type FunctionFlow, type ScopeFlow, type ScopeFlowStats, type ScopeFunction } from "../../api";
import {
  callGraph,
  callLinks,
  callPath,
  fileOfId,
  fnKey,
  outsideSteps,
  resolutionPercent,
  type CallGraph,
  type CallLink,
  type OutsideStep,
} from "../../flowGraph";
import { hrefFile, hrefFlow, hrefView, inScope } from "../../router";
import { CallGraphView } from "../CallGraph";
import { FlowChart } from "../FlowChart";
import { scopeKind } from "../ScopeNote";

type Loaded<T> = { status: "loading" } | { status: "ready"; data: T } | { status: "error"; message: string };

/** Runs `load` when `key` changes. An answer that arrives for a key no longer shown is dropped. */
function useLoaded<T>(key: string, load: () => Promise<T>): Loaded<T> {
  const [done, setDone] = useState<{ key: string; state: Loaded<T> } | null>(null);
  useEffect(() => {
    let cancelled = false;
    load().then(
      (data) => {
        if (!cancelled) setDone({ key, state: { status: "ready", data } });
      },
      (e: unknown) => {
        if (!cancelled) setDone({ key, state: { status: "error", message: e instanceof Error ? e.message : String(e) } });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [key]);
  return done?.key === key ? done.state : { status: "loading" };
}

/**
 * The flow tab. Every scope opens with how many of its calls resolve inside it. A file charts its
 * functions, a folder or the project draws its call graph, and a function opens its own chart with the
 * calls that reach it and leave it.
 */
export function FlowView({ id, files, scope, fn }: { id: string; files: FileEntry[]; scope: string; fn?: string }) {
  const kind = scopeKind(scope, files);
  const flow = useLoaded(`${id}\0${scope}`, () => api.scopeFlow(id, scope));
  if (kind === "missing") return <p className="muted">Nothing at this path in the snapshot, so there is no flow to chart.</p>;
  if (flow.status === "error") return <p className="error" role="alert">{flow.message}</p>;
  if (flow.status === "loading") return <p className="muted">Loading</p>;
  const data = flow.data;
  return (
    <div>
      <ResolutionMeter stats={data.stats} />
      {fn !== undefined ? (
        <FunctionView id={id} scope={scope} fn={fn} isFile={kind === "file"} flow={data} />
      ) : kind === "file" ? (
        <FileView id={id} path={scope} />
      ) : (
        <ScopeGraph id={id} scope={scope} flow={data} />
      )}
    </div>
  );
}

function ResolutionMeter({ stats }: { stats: ScopeFlowStats }) {
  const pct = resolutionPercent(stats);
  if (pct === undefined) return <p className="muted small">No calls start in this scope.</p>;
  return (
    <div className="meter">
      <p className="small">
        Resolution: {stats.resolved} of {stats.calls} calls resolved in this scope · {stats.external} leave the scope
      </p>
      <div
        className="meter-bar"
        role="meter"
        aria-label="Calls resolved in this scope"
        aria-valuemin={0}
        aria-valuemax={stats.calls}
        aria-valuenow={stats.resolved}
        aria-valuetext={`${pct}% resolved`}
      >
        <span style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/** A folder or the project with no function picked: its call graph, and the table of its files below. */
function ScopeGraph({ id, scope, flow }: { id: string; scope: string; flow: ScopeFlow }) {
  const graph = useMemo(() => callGraph(id, flow, scope), [id, flow, scope]);
  return (
    <section>
      {graph.nodes.length === 0 ? (
        <p className="muted">No function in this scope has a flow to chart.</p>
      ) : (
        <CallGraphView graph={graph} title={scope === "" ? "Project" : scope} />
      )}
      <FlowFolders id={id} scope={scope} />
    </section>
  );
}

function busiest(fns: FunctionFlow[]): FunctionFlow {
  return fns.reduce((best, f) => (f.stats.decisions + f.stats.loops > best.stats.decisions + best.stats.loops ? f : best));
}

/** A file with no function picked: the chart of its busiest function, and a pill for each function. */
function FileView({ id, path }: { id: string; path: string }) {
  const flow = useLoaded(`${id}\0file\0${path}`, () => api.flow(id, path));
  if (flow.status === "error") return <p className="error" role="alert">{flow.message}</p>;
  if (flow.status === "loading") return <p className="muted">Loading</p>;
  const fns = flow.data.functions;
  if (fns.length === 0) return <p className="muted">{path} has no functions, so there is no flow to chart.</p>;
  const selected = busiest(fns);
  return (
    <div>
      <nav className="chips" aria-label="Functions in this file">
        {fns.map((f) => (
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
      <ChartPanel id={id} scope={path} fn={selected} />
    </div>
  );
}

/** One function picked: its chart, the path from a root of the call graph to it, and the calls that reach it and leave it. */
function FunctionView({ id, scope, fn, isFile, flow }: { id: string; scope: string; fn: string; isFile: boolean; flow: ScopeFlow }) {
  const file = fileOfId(fn);
  const chart = useLoaded(`${id}\0fn\0${file}`, () => api.flow(id, file));
  const graph = useMemo(() => callGraph(id, flow, scope), [id, flow, scope]);
  const row = flow.functions.find((f) => f.id === fn);
  const back = (
    <a className="back small" href={hrefView(id, "flow", { scope })}>
      {isFile ? "← file" : "← call graph"}
    </a>
  );
  if (chart.status === "error") {
    return (
      <div>
        {back}
        <p className="error" role="alert">{chart.message}</p>
      </div>
    );
  }
  if (chart.status === "loading") return <p className="muted">Loading</p>;
  const node = chart.data.functions.find((f) => f.id === fn);
  if (!node) {
    return (
      <div>
        {back}
        <p className="muted">{fn} is not in {file}, so there is no flow to chart.</p>
      </div>
    );
  }
  return (
    <div>
      {back}
      <Trail id={id} graph={graph} fn={fn} />
      <ChartPanel id={id} scope={scope} fn={node}>
        {flow.granularity === "files" ? (
          <p className="muted small">This scope is too large to list calls one by one. Select a smaller folder to see who calls this function and what it calls.</p>
        ) : (
          <CallLists graph={graph} fn={fn} row={row} />
        )}
      </ChartPanel>
    </div>
  );
}

/** The path from a root of the call graph down to a function, so a reader sees how the call is reached. */
function Trail({ id, graph, fn }: { id: string; graph: CallGraph; fn: string }) {
  const key = fnKey(fn);
  const path = callPath(graph.roots, graph.edges, key).flatMap((k) => {
    const n = graph.byKey.get(k);
    return n ? [n] : [];
  });
  if (path.length < 2) return null;
  return (
    <nav className="trail small" aria-label="Call path">
      {path.map((n, i) => (
        <span key={n.key}>
          {i > 0 && <span className="sep"> › </span>}
          {n.key === key ? <strong>{n.name}</strong> : <a href={n.href}>{n.name}</a>}
        </span>
      ))}
    </nav>
  );
}

function CallLists({ graph, fn, row }: { graph: CallGraph; fn: string; row?: ScopeFunction }) {
  const { calls, calledBy } = callLinks(graph, fnKey(fn));
  return (
    <section className="calls-grid" aria-label="Calls">
      <div>
        <h3>Calls</h3>
        <LinkList items={calls} empty="Calls nothing in this scope." />
      </div>
      <div>
        <h3>Called by</h3>
        <LinkList items={calledBy} empty="Nothing in this scope calls it." />
        {row?.calledFromOutside && <p className="muted small">Also called from outside this scope.</p>}
      </div>
    </section>
  );
}

function LinkList({ items, empty }: { items: CallLink[]; empty: string }) {
  if (items.length === 0) return <p className="muted small">{empty}</p>;
  return (
    <ul className="call-list">
      {items.map((c) => {
        const external = c.node.kind === "external";
        return (
          <li key={c.node.key}>
            <a href={c.node.href}>{c.node.name}</a>
            {external && " ↗"}
            {c.count > 1 && <span className="muted small"> × {c.count}</span>}
            {c.candidate && <span className="muted small"> may call</span>}
            {external && (
              <span className="muted small">
                {" "}
                · outside this scope, resolved in {c.node.resolvedIn ? <span className="mono">{c.node.resolvedIn}</span> : "the project"}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** A function's chart, with its stats, the calls that leave the scope, and the legend. Children go under them. */
function ChartPanel({ id, scope, fn, children }: { id: string; scope: string; fn: FunctionFlow; children?: ReactNode }) {
  const s = fn.stats;
  const scroller = useRef<HTMLDivElement>(null);
  // The entry sits in the middle of a wide chart, so the scroll box opens there rather than at its left edge.
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollLeft = (el.scrollWidth - el.clientWidth) / 2;
  }, [fn.id]);
  const steps = outsideSteps(fn, scope);
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
          <FlowChart id={id} fn={fn} scope={scope} />
        </div>
      )}
      {steps.length > 0 && <OutsideList id={id} steps={steps} />}
      <ChartLegend />
      {children}
    </section>
  );
}

/** The calls in a chart that name a function outside this scope, each with the scope that resolves it. */
function OutsideList({ id, steps }: { id: string; steps: OutsideStep[] }) {
  return (
    <section className="outside-list" aria-label="Calls outside this scope">
      <h3>Calls outside this scope</h3>
      <ul>
        {steps.map((s) => (
          <li key={s.node.id}>
            calls <code>{s.name}</code> in <span className="mono">{s.file}</span> — outside this scope.{" "}
            <a href={hrefView(id, "flow", { scope: s.scope, fn: s.target })} title={`Resolved in ${s.scope || "the project"}`}>
              Select a parent folder to resolve it.
            </a>
            {s.node.span && (
              <>
                {" "}
                <a className="small" href={hrefFile(id, s.node.span.file, s.node.span.start[0] + 1)}>
                  Line {s.node.span.start[0] + 1}
                </a>
              </>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function ChartLegend() {
  return (
    <div className="legend">
      <p className="muted small">
        Rounded: start or end. Box: step. Diamond: decision. Hexagon: loop. Dot: join. Red outline: return, throw, break or continue.
        Dashed box: await or spawn. Green arrow: true. Amber arrow: false. Dashed arrow: loop back. A call into this scope opens the
        function it calls. Click any other step to see its line.
      </p>
      <ul className="legend-keys small" aria-label="Legend">
        <li>
          <span className="key key-resolves" aria-hidden="true" />
          Call into this scope
        </li>
        <li>
          <span className="key key-unresolved" aria-hidden="true" />
          ↗ Unresolved: calls a function outside this scope
        </li>
      </ul>
    </div>
  );
}

function FlowFolders({ id, scope }: { id: string; scope: string }) {
  const rows = useLoaded(`${id}\0summary`, () => api.flowSummary(id));
  if (rows.status === "error") return <p className="error" role="alert">{rows.message}</p>;
  if (rows.status === "loading") return <p className="muted">Loading</p>;
  const shown = rows.data.filter((r) => inScope(r.file, scope));
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
          <FileTable id={id} rows={shown} />
        </>
      )}
    </section>
  );
}

function FileTable({ id, rows }: { id: string; rows: FileFlowSummary[] }) {
  return (
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
        {rows.map((r) => (
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
