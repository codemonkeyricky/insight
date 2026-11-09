import { useEffect, useMemo, useState } from "react";
import { api, type FileEntry, type FileFlowSummary } from "../../api";
import { hrefFlow, hrefView, inScope } from "../../router";
import { ExecStore } from "../../zoom/execStore";
import { ZoomStore } from "../../zoom/scene";
import { scopeKind } from "../ScopeNote";
import { ExecContainerPanel } from "../zoom/ExecContainerPanel";
import { ExecFunctionPanel } from "../zoom/ExecFunctionPanel";
import { Stat } from "../zoom/FunctionDetail";
import { ZoomMap } from "../zoom/ZoomMap";

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

interface Props {
  id: string;
  files: FileEntry[];
  scope: string;
  fn?: string;
  /** The canvas shows only the functions each thread starts in. */
  roots: boolean;
}

/**
 * The flow tab: the execution canvas of the scope, a zoom map of its threads, coroutines, file groups and functions.
 * Below it, the panel of the focus: for a function, its trail, chart, and Calls and Called by lists; for a container,
 * its functions as pills and as a table. For a folder or the project, the table of its files comes last. The roots-only
 * switch cuts the canvas to the functions each thread starts in. The canvas and the panel share one flow store, so a
 * chart or a scope's flow loaded for one is not loaded again for the other.
 */
export function FlowView({ id, files, scope, fn, roots }: Props) {
  const store = useMemo(() => new ZoomStore(id), [id]);
  const exec = useMemo(() => new ExecStore(id, roots), [id, roots]);
  const kind = scopeKind(scope, files);
  if (kind === "missing") return <p className="muted">Nothing at this path in the snapshot, so there is no flow to chart.</p>;
  return (
    <div>
      <RootsOnly id={id} scope={scope} fn={fn} roots={roots} />
      <ZoomMap
        key={roots ? "roots" : "all"}
        id={id}
        source={exec}
        scope={scope}
        fn={fn}
        charts={{ id, scope, store }}
        detail={(build, open) => {
          const view = exec.viewOf(build);
          if (view === undefined) return null;
          const panel = { id, scope: build.path, roots, store, index: view.index, nodeId: build.nodeId, onOpen: open };
          return build.selected ? (
            <ExecFunctionPanel {...panel} selected={build.selected} />
          ) : (
            <ExecContainerPanel {...panel} rootKind={kind} />
          );
        }}
      />
      {kind !== "file" && <FlowFolders id={id} scope={scope} />}
    </div>
  );
}

/** The roots-only switch above the canvas. Turning it on or off changes the URL, and the canvas follows the URL. */
function RootsOnly({ id, scope, fn, roots }: { id: string; scope: string; fn?: string; roots: boolean }) {
  return (
    <label className="zm-roots">
      <input
        type="checkbox"
        checked={roots}
        onChange={(e) => {
          window.location.hash = hrefView(id, "flow", { scope, ...(fn ? { fn } : {}), roots: e.target.checked });
        }}
      />{" "}
      Roots only
      <span className="muted small"> shows only the functions each thread starts in</span>
    </label>
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
          <div className="flow-table">
            <FileTable id={id} rows={shown} />
          </div>
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
