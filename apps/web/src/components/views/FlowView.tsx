import { useEffect, useMemo, useState } from "react";
import { api, type FileEntry, type FileFlowSummary } from "../../api";
import { hrefFlow, hrefView, inScope, type FlowMode } from "../../router";
import { ZoomStore } from "../../zoom/scene";
import { scopeKind } from "../ScopeNote";
import { EntryMap } from "../zoom/EntryMap";
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

/**
 * The flow tab. Its default mode shows a scope's entry points: the functions nothing in the scope calls. The hierarchy
 * mode is the zoom map of the project, which opens from the project down to a function's chart; its URL keeps the
 * focus in step, and below it a folder or the project lists its files. Both modes share one store, so a flow loaded
 * for one is not loaded again for the other.
 */
export function FlowView({ id, files, scope, fn, mode }: { id: string; files: FileEntry[]; scope: string; fn?: string; mode: FlowMode }) {
  const store = useMemo(() => new ZoomStore(id), [id]);
  const kind = scopeKind(scope, files);
  if (kind === "missing") return <p className="muted">Nothing at this path in the snapshot, so there is no flow to chart.</p>;
  return (
    <div>
      <ModeSwitch id={id} scope={scope} fn={fn} mode={mode} />
      {mode === "hierarchy" ? (
        <>
          <ZoomMap id={id} store={store} scope={scope} fn={fn} />
          {kind !== "file" && <FlowFolders id={id} scope={scope} />}
        </>
      ) : (
        <EntryMap id={id} store={store} scope={scope} fn={fn} />
      )}
    </div>
  );
}

const MODES: { mode: FlowMode; label: string }[] = [
  { mode: "entries", label: "Entry points" },
  { mode: "hierarchy", label: "Hierarchy" },
];

/** The two ways to see a scope. Each link keeps the scope and function, so switching does not lose the place. */
function ModeSwitch({ id, scope, fn, mode }: { id: string; scope: string; fn?: string; mode: FlowMode }) {
  return (
    <nav className="em-modes" aria-label="Flow view">
      {MODES.map((m) => (
        <a
          key={m.mode}
          href={hrefView(id, "flow", { scope, mode: m.mode, ...(fn ? { fn } : {}) })}
          className={m.mode === mode ? "em-mode on" : "em-mode"}
          aria-current={m.mode === mode ? "page" : undefined}
        >
          {m.label}
        </a>
      ))}
    </nav>
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
