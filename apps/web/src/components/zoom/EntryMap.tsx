// The entry view of the flow tab: the functions that nothing in a scope calls, as boxes in file frames, with the ladder
// of the scope's ancestors above them. A plain grid, so it needs no camera or layout worker. Each box links to its
// function, and an open function's chart and detail sit below the grid.
import { useEffect, useMemo, useState, type KeyboardEvent as KeyEvent } from "react";
import {
  ZOOM_SIZE,
  entrySummary,
  ladderOf,
  layoutEntries,
  scopeChain,
  type EntryCount,
  type EntryLayout,
  type EntrySummary,
  type FunctionFlow,
  type PlacedEntryBox,
  type PlacedEntryFrame,
  type ScopeFlow,
} from "@insight/flow";
import { hrefView } from "../../router";
import type { ZoomStore } from "../../zoom/scene";
import { FlowChart } from "../FlowChart";
import { FunctionDetail } from "./FunctionDetail";

interface ChartState {
  fn: string;
  flow?: FunctionFlow;
  error?: string;
}

interface Props {
  id: string;
  /** The flow tab's store, shared with the hierarchy map. */
  store: ZoomStore;
  /** The URL's scope: a folder, or a file. Empty is the project. */
  scope: string;
  /** The URL's function, when one is picked. Its chart opens below the grid. */
  fn?: string;
}

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
const rungName = (name: string) => (name === "project" ? "Project" : name);
/** The file path, cut from the front when it would not fit in its frame's header. */
const shortPath = (file: string) => (file.length > 44 ? `…${file.slice(-43)}` : file);
const shortName = (name: string) => (name.length > 26 ? `${name.slice(0, 25)}…` : name);

const countsOf = (flow: ScopeFlow | undefined): EntryCount | undefined =>
  flow === undefined ? undefined : { unreferenced: flow.stats.unreferenced, tests: flow.stats.unreferencedTests };

const countText = (c: EntryCount) =>
  `${c.unreferenced} entry ${plural(c.unreferenced, "point", "points")}${c.tests > 0 ? `, ${c.tests} in tests` : ""}`;

function summaryText(s: EntrySummary): string {
  const outside = s.outside > 0 ? `, ${s.outside} also called from outside this scope` : "";
  return `${s.shown} entry ${plural(s.shown, "point", "points")} in ${s.files} ${plural(s.files, "file", "files")}${outside}`;
}

/** Why the grid is empty. A scope whose only unreferenced functions are tests says so, and points at the toggle. */
function emptyText(flow: ScopeFlow): string {
  if (flow.stats.functionsTotal === 0) return "No function in this scope.";
  if (flow.stats.unreferenced === 0 && flow.stats.unreferencedTests === 0) return "Every function in this scope is called from inside it.";
  return "The only unreferenced functions here are in test files. Include tests to see them.";
}

/** The entry view of one scope. Its ladder, summary and grid come from the flows the store has loaded. */
export function EntryMap({ id, store, scope, fn }: Props) {
  const [includeTests, setIncludeTests] = useState(false);
  const [chain, setChain] = useState<{ scope: string; error?: string }>();
  const [chart, setChart] = useState<ChartState>();

  // The scope's flow and each ancestor's, for the grid and the ladder counts.
  useEffect(() => {
    let cancelled = false;
    store.ensureChain(scope).then(
      () => {
        if (!cancelled) setChain({ scope });
      },
      (e: unknown) => {
        if (!cancelled) setChain({ scope, error: messageOf(e) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [store, scope]);

  // The open function's chart, which loads its file's charts.
  useEffect(() => {
    if (fn === undefined) return;
    let cancelled = false;
    store.chartOf(fn).then(
      (flow) => {
        if (!cancelled) setChart({ fn, flow });
      },
      (e: unknown) => {
        if (!cancelled) setChart({ fn, error: messageOf(e) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [store, fn]);

  const ready = chain?.scope === scope ? chain : undefined;
  const flow = ready !== undefined && ready.error === undefined ? store.flowOf(scope) : undefined;
  const layout = useMemo(() => (flow ? layoutEntries(flow, { includeTests }) : undefined), [flow, includeTests]);
  const summary = flow ? entrySummary(flow, includeTests) : undefined;
  const rungs = ladderOf(scope, (s) => countsOf(store.flowOf(s)));
  const fromOutside = flow?.unreferenced.some((f) => f.id === fn && f.calledFromOutside) ?? false;
  const parent = scopeChain(scope)[1];

  // Escape closes the open function first, then goes up one scope.
  const onKey = (e: KeyEvent<HTMLDivElement>) => {
    if (e.key !== "Escape") return;
    const next = fn !== undefined ? hrefView(id, "flow", { scope }) : parent !== undefined ? hrefView(id, "flow", { scope: parent }) : undefined;
    if (next === undefined) return;
    e.preventDefault();
    window.location.hash = next;
  };

  return (
    <div className="em" onKeyDown={onKey}>
      <nav className="em-ladder" aria-label="Scopes from the project down to this one">
        <ol>
          {rungs.map((r) => (
            <li key={r.scope || "project"}>
              {r.current ? (
                <strong aria-current="page">{rungName(r.name)}</strong>
              ) : (
                <a href={hrefView(id, "flow", { scope: r.scope })}>{rungName(r.name)}</a>
              )}
              {r.counts && <span className="muted small"> {countText(r.counts)}</span>}
            </li>
          ))}
        </ol>
      </nav>
      {ready?.error && (
        <p className="error" role="alert">
          {ready.error}
        </p>
      )}
      {!flow && !ready?.error && <p className="muted">Loading</p>}
      {flow && layout && summary && (
        <>
          <div className="em-bar">
            <p className="small em-summary">{summaryText(summary)}</p>
            <label className="em-toggle">
              <input type="checkbox" checked={includeTests} onChange={(e) => setIncludeTests(e.target.checked)} />
              Include tests ({summary.tests})
            </label>
          </div>
          {layout.frames.length === 0 ? (
            <p className="muted">{emptyText(flow)}</p>
          ) : (
            <EntryGrid id={id} scope={scope} layout={layout} selected={fn} />
          )}
          {fn !== undefined && <ChartPanel id={id} scope={scope} state={chart?.fn === fn ? chart : undefined} fromOutside={fromOutside} />}
        </>
      )}
    </div>
  );
}

function EntryGrid({ id, scope, layout, selected }: { id: string; scope: string; layout: EntryLayout; selected?: string }) {
  return (
    <div className="em-stage" role="region" aria-label="Entry points in this scope" tabIndex={0}>
      <svg width={layout.width} height={layout.height} className="em-svg">
        {layout.frames.map((frame) => (
          <FrameShape key={frame.file} frame={frame} id={id} scope={scope} selected={selected} />
        ))}
      </svg>
    </div>
  );
}

function FrameShape({ frame, id, scope, selected }: { frame: PlacedEntryFrame; id: string; scope: string; selected?: string }) {
  return (
    <g className={frame.test ? "em-frame em-test" : "em-frame"}>
      <title>{frame.file}</title>
      <rect x={frame.x} y={frame.y} width={frame.w} height={frame.h} rx={10} className="em-frame-body" />
      <text x={frame.x + 12} y={frame.y + ZOOM_SIZE.head / 2} dominantBaseline="central" className="em-frame-label">
        {shortPath(frame.file)}
      </text>
      {frame.boxes.map((b) => (
        <BoxLink key={b.id} box={b} id={id} scope={scope} selected={b.id === selected} />
      ))}
    </g>
  );
}

function BoxLink({ box, id, scope, selected }: { box: PlacedEntryBox; id: string; scope: string; selected: boolean }) {
  const reach = box.reach > 0 ? `reaches ${box.reach} ${plural(box.reach, "function", "functions")} in this scope` : "reaches no other function in this scope";
  const note = [`${box.name}, line ${box.line}`, reach, box.calledFromOutside ? "also called from outside this scope" : undefined]
    .filter((s) => s !== undefined)
    .join(". ");
  return (
    <a
      href={hrefView(id, "flow", { scope, fn: box.id })}
      className={`em-box${box.test ? " em-test" : ""}${selected ? " on" : ""}`}
      aria-current={selected ? "true" : undefined}
    >
      <title>{note}</title>
      <rect x={box.x} y={box.y} width={box.w} height={box.h} rx={8} className="em-box-body" />
      <text x={box.x + 12} y={box.y + box.h / 2} dominantBaseline="central" className="em-label">
        {shortName(box.name)}
      </text>
      {box.calledFromOutside && (
        <circle cx={box.x + box.w - 12} cy={box.y + 12} r={4} className="em-outside">
          <title>Called from outside this scope</title>
        </circle>
      )}
    </a>
  );
}

function ChartPanel({ id, scope, state, fromOutside }: { id: string; scope: string; state?: ChartState; fromOutside: boolean }) {
  if (state?.error) return <p className="error" role="alert">{state.error}</p>;
  if (!state) return <p className="muted">Loading</p>;
  const f = state.flow;
  if (!f) return <p className="muted">That function is not in the snapshot.</p>;
  return (
    <>
      {!f.tooLarge && f.nodes.length > 0 && (
        <div className="em-chart">
          <FlowChart id={id} fn={f} scope={scope} />
        </div>
      )}
      <FunctionDetail id={id} fn={f} scope={scope} calledFromOutside={fromOutside} />
    </>
  );
}
