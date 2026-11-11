import { useEffect, useState } from "react";
import { api, NO_SERVER, type Project, type SnapshotSummary } from "../api";
import { hrefView } from "../router";
import type { IndexRun } from "../useIndexProgress";
import { IndexProgress } from "./IndexProgress";

/** How long the done state stays before the strip returns to rest. */
const DONE_MS = 2000;

/** "just now", "12 min ago", "3 h ago" or "2 d ago". */
export function relativeAgo(iso: string, now: number): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "at an unknown time";
  const min = Math.floor(Math.max(0, now - t) / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

export interface IndexStripProps {
  id: string;
  project: Project;
  snapshot: SnapshotSummary | null;
  run: IndexRun;
  /** Called once a run is requested, so the workspace reloads its overview. */
  onRequested: () => void;
}

/**
 * The workspace strip under the layer tabs: the Index button and the last index at rest, the run's bar while it runs, the
 * settled summary for two seconds after a run, and the error with Retry after a failed one.
 */
export function IndexStrip({ id, project, snapshot, run, onRequested }: IndexStripProps) {
  const [full, setFull] = useState(false);
  const [lastFull, setLastFull] = useState(false);
  const [busy, setBusy] = useState(false);
  const [requestError, setRequestError] = useState<string>();
  const [showDone, setShowDone] = useState(false);

  useEffect(() => {
    if (run.finishedAt === undefined) return;
    setShowDone(true);
    const timer = setTimeout(() => setShowDone(false), DONE_MS);
    return () => clearTimeout(timer);
  }, [run.finishedAt]);

  if (NO_SERVER) return null;

  const running = run.running || project.status === "indexing";
  const failed = !running && run.lastError !== undefined;
  const done = !running && !failed && showDone;

  const start = async (all: boolean) => {
    setBusy(true);
    setRequestError(undefined);
    setLastFull(all);
    try {
      await api.reindex(id, all);
      onRequested();
    } catch (e) {
      setRequestError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const rest = snapshot
    ? `Indexed ${relativeAgo(snapshot.createdAt, Date.now())}${snapshot.commit ? ` · ${snapshot.commit.slice(0, 7)}` : ""}`
    : "Not indexed yet";

  return (
    <div className={`idx-strip${done ? " is-done" : ""}`}>
      <button
        type="button"
        onClick={(e) => void start(full || e.altKey)}
        disabled={busy || running}
        title="Index the project. Alt-click for a full re-index."
      >
        {running ? "Indexing" : "Index"}
      </button>
      <label className="check small">
        <input type="checkbox" checked={full} disabled={running} onChange={(e) => setFull(e.target.checked)} /> Full
      </label>
      {running ? (
        <>
          <div className="idx-strip-main">
            <IndexProgress progress={run.progress} fraction={run.progress ? run.fraction : undefined} />
          </div>
          {project.queued && <span className="idx-note">One more queued</span>}
          <a className="small" href={hrefView(id, "overview", { full: true })}>
            Log
          </a>
        </>
      ) : failed ? (
        <>
          <div className="idx-strip-main">
            <IndexProgress error={`Indexing failed: ${run.lastError}`} fraction={run.fraction} />
          </div>
          <button type="button" onClick={() => void start(run.progress?.full ?? lastFull)} disabled={busy}>
            Retry
          </button>
        </>
      ) : done ? (
        <div className="idx-strip-main idx-done">
          <IndexProgress fraction={1} label={`Indexed · ${(snapshot?.nodes ?? 0).toLocaleString()} nodes`} />
        </div>
      ) : (
        <span className="idx-rest" title={rest}>{rest}</span>
      )}
      {requestError && (
        <span className="error small" role="alert">
          {requestError}
        </span>
      )}
    </div>
  );
}

/** The center stage of a project with no snapshot yet: the first run's progress at full size, in place of the empty views. */
export function FirstIndex({ name, run, running }: { name: string; run: IndexRun; running: boolean }) {
  return (
    <div className="sh-stage idx-first">
      <h2>{running ? `Indexing ${name}…` : `${name} has no index yet`}</h2>
      {running ? (
        <IndexProgress progress={run.progress} fraction={run.progress ? run.fraction : undefined} />
      ) : run.lastError ? (
        <p className="error">Indexing failed: {run.lastError}</p>
      ) : (
        <p className="muted">Use Index above to build the first index.</p>
      )}
    </div>
  );
}
