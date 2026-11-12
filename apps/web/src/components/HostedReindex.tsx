import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  IndexRequestError,
  parseProjectId,
  readIndexMeta,
  readLatest,
  readStatus,
  requestIndex,
  storageRoot,
  type HostedRef,
} from "../hostedApi";
import { hrefHosted, indexErrorText, isRefName, phaseLabel, rateLimitText, REINDEXED_EVENT, relativeTime } from "../hostedRepo";
import { watchIndex, type PollStatus } from "../indexPoll";

export type ReindexState =
  | { kind: "idle" }
  | { kind: "posting" }
  | { kind: "running"; status: PollStatus }
  | { kind: "uptodate"; sha: string }
  | { kind: "error"; message: string };

export interface ReindexViewProps {
  sha: string;
  /** The ref the shown index came from, when known. */
  from?: string;
  indexedAt?: string;
  now: number;
  branch: string;
  state: ReindexState;
  onBranch: (value: string) => void;
  onSubmit: () => void;
}

/** "Indexed 0123456 from main · 3 days ago": the shown index, as far as it is known. */
export function indexedLine(sha: string, from: string | undefined, indexedAt: string | undefined, now: number): string {
  const when = indexedAt ? relativeTime(indexedAt, now) : "";
  return `Indexed ${sha.slice(0, 7)}${from ? ` from ${from}` : ""}${when ? ` · ${when}` : ""}`;
}

/** The hosted workspace's index strip: a branch field, Re-index latest, and one line on what is shown. Pure view. */
export function ReindexView({ sha, from, indexedAt, now, branch, state, onBranch, onSubmit }: ReindexViewProps) {
  const busy = state.kind === "posting" || state.kind === "running";
  const invalid = branch.trim() !== "" && !isRefName(branch.trim());
  const pct =
    state.kind === "running" && state.status.total !== undefined && state.status.total > 0
      ? Math.min(100, Math.round(((state.status.done ?? 0) / state.status.total) * 100))
      : undefined;
  return (
    <form
      className="idx-strip idx-hosted"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        if (!busy && !invalid) onSubmit();
      }}
    >
      <input
        className="idx-branch"
        value={branch}
        onChange={(e) => onBranch(e.target.value)}
        placeholder="default branch"
        aria-label="Branch to re-index"
        aria-invalid={invalid}
        disabled={busy}
        autoComplete="off"
        spellCheck={false}
      />
      <button type="submit" disabled={busy || invalid} title="Index the newest commit of this branch">
        {busy ? "Indexing" : "Re-index latest"}
      </button>
      {state.kind === "running" ? (
        <div className="idx idx-hosted-run" role="status">
          <span className="idx-label">{phaseLabel(state.status.phase)}</span>
          <div className="idx-bar" role="progressbar" aria-label="Indexing progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
            <div className={pct === undefined ? "idx-fill is-uncounted" : "idx-fill"} style={pct === undefined ? { width: "100%", opacity: 0.35 } : { width: `${pct}%` }} />
          </div>
        </div>
      ) : state.kind === "posting" ? (
        <span className="idx-note" role="status">Checking GitHub</span>
      ) : state.kind === "uptodate" ? (
        <span className="idx-note idx-uptodate" role="status">Already up to date · {state.sha.slice(0, 7)}</span>
      ) : state.kind === "error" ? (
        <span className="error small idx-error" role="alert">{state.message}</span>
      ) : (
        <span className="idx-rest" title={indexedLine(sha, from, indexedAt, now)}>{indexedLine(sha, from, indexedAt, now)}</span>
      )}
      {state.kind === "running" && <span className="idx-rest idx-hosted-line">{indexedLine(sha, from, indexedAt, now)}</span>}
    </form>
  );
}

/** Opens the latest of a branch: the page's @<branch> route (reloading it in place when it is already the one showing). */
function openBranch(ref: HostedRef, branch: string): void {
  const target = hrefHosted(ref.owner, ref.repo, undefined, branch);
  if (window.location.hash === target) window.dispatchEvent(new Event(REINDEXED_EVENT));
  else window.location.hash = target;
}

/**
 * The hosted workspace's index control. It reads which ref the shown commit came from (meta.json, else latest.json), asks the
 * server to index the branch's newest commit (POST /api/index {repo, ref}), follows the run, and then opens #/gh/o/r@<ref>.
 */
export function HostedReindex({ id }: { id: string }) {
  const ref = parseProjectId(id);
  const [from, setFrom] = useState<string>();
  const [indexedAt, setIndexedAt] = useState<string>();
  const [branch, setBranch] = useState("");
  const [state, setState] = useState<ReindexState>({ kind: "idle" });
  const touched = useRef(false);
  const stop = useRef<(() => void) | undefined>(undefined);

  useEffect(() => {
    if (!ref) return;
    let live = true;
    touched.current = false;
    void (async () => {
      try {
        const root = storageRoot();
        const meta = await readIndexMeta(root, ref).catch(() => undefined);
        const latest = ref.private ? undefined : await readLatest(root, ref.owner, ref.repo).catch(() => undefined);
        if (!live) return;
        const same = latest?.sha === ref.sha ? latest : undefined;
        const found = meta?.ref ?? same?.ref;
        setFrom(found);
        setIndexedAt(meta?.capturedAt ?? same?.indexedAt);
        // The field starts at the index's ref, else the default branch (latest.json's ref is the default branch of its run).
        if (!touched.current) setBranch(found ?? latest?.ref ?? "");
      } catch {
        /* the line just shows what it knows */
      }
    })();
    return () => {
      live = false;
      stop.current?.();
    };
  }, [id]);

  if (!ref) return null;

  const submit = async () => {
    const wanted = branch.trim();
    setState({ kind: "posting" });
    try {
      const reply = await requestIndex(`${ref.owner}/${ref.repo}`, wanted === "" ? undefined : wanted);
      const target = reply.ref ?? wanted;
      if (reply.state === "failed") {
        setState({ kind: "error", message: indexErrorText(reply.error?.code ?? "index_failed", `${ref.owner}/${ref.repo}`, reply.error?.message, wanted || undefined) });
        return;
      }
      if (reply.state === "done") {
        if (reply.upToDate) setState({ kind: "uptodate", sha: reply.sha });
        else {
          setState({ kind: "idle" });
          openBranch(ref, target);
        }
        return;
      }
      const run: HostedRef = { owner: ref.owner, repo: ref.repo, sha: reply.sha, private: reply.visibility === "private" };
      setState({ kind: "running", status: { state: "running" } });
      stop.current = watchIndex({
        read: () => readStatus(run),
        onProgress: (status) => setState({ kind: "running", status }),
        onDone: () => {
          setState({ kind: "idle" });
          openBranch(ref, target);
        },
        onFailed: (error) => setState({ kind: "error", message: indexErrorText(error.code, `${ref.owner}/${ref.repo}`, error.message) }),
        onError: () => setState({ kind: "error", message: indexErrorText("network", `${ref.owner}/${ref.repo}`) }),
      });
    } catch (err) {
      if (err instanceof IndexRequestError) {
        const message =
          err.code === "rate_limited"
            ? rateLimitText(err.message, err.retryAfterSeconds)
            : indexErrorText(err.code, `${ref.owner}/${ref.repo}`, err.message, wanted || undefined);
        setState({ kind: "error", message });
      } else setState({ kind: "error", message: indexErrorText("network", `${ref.owner}/${ref.repo}`) });
    }
  };

  return (
    <ReindexView
      sha={ref.sha}
      from={from}
      indexedAt={indexedAt}
      now={Date.now()}
      branch={branch}
      state={state}
      onBranch={(value) => {
        touched.current = true;
        setBranch(value);
        if (state.kind === "uptodate" || state.kind === "error") setState({ kind: "idle" });
      }}
      onSubmit={() => void submit()}
    />
  );
}
