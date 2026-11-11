import { useEffect, useState } from "react";
import { hrefView } from "../router";
import {
  authMe,
  IndexRequestError,
  projectIdOf,
  readLatest,
  readPrivateLatest,
  readStatus,
  requestIndex,
  signInUrl,
  storageRoot,
  type HostedRef,
} from "../hostedApi";
import { canRetry, indexErrorText, phaseLabel } from "../hostedRepo";
import { watchIndex, type PollStatus } from "../indexPoll";

type View = { kind: "checking" } | { kind: "running"; status: PollStatus } | { kind: "failed"; code: string; message: string };

/** The progress of a run: its phase, and a bar when the run counts its work. */
function RunProgress({ status }: { status: PollStatus }) {
  const phase = phaseLabel(status.phase);
  const hasCount = status.total !== undefined && status.total > 0;
  const pct = hasCount ? Math.min(100, Math.round(((status.done ?? 0) / status.total!) * 100)) : undefined;
  return (
    <div className="panel index-run">
      <p className="index-phase">
        <strong>{phase}</strong>
        {hasCount && (
          <span className="muted">
            {" "}
            {status.done ?? 0} of {status.total}
          </span>
        )}
      </p>
      <div
        className="index-bar"
        role="progressbar"
        aria-label="Indexing progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-valuetext={pct === undefined ? phase : `${pct}%`}
      >
        <div className={pct === undefined ? "index-bar-fill indeterminate" : "index-bar-fill"} style={pct === undefined ? undefined : { width: `${pct}%` }} />
      </div>
      <p className="muted small">The page opens the index as soon as it is ready.</p>
    </div>
  );
}

/**
 * #/gh/<owner>/<repo> and #/gh/<owner>/<repo>@<sha>: opens the repository's index when there is one, or asks the server
 * to index it and follows the run until it is done (then opens it) or fails (then says why). A private index is found
 * only while signed in; a private repository asked for while signed out says so, with a sign-in link.
 */
export function HostedIndexPage({ owner, repo, sha }: { owner: string; repo: string; sha?: string }) {
  const [view, setView] = useState<View>({ kind: "checking" });
  const [attempt, setAttempt] = useState(0);
  const repoName = `${owner}/${repo}`;

  useEffect(() => {
    let cancelled = false;
    let stop: (() => void) | undefined;
    const root = storageRoot();

    const open = (ref: HostedRef) => {
      window.location.hash = hrefView(projectIdOf(ref), "flow");
    };
    const fail = (code: string, message?: string) => {
      setView({ kind: "failed", code, message: indexErrorText(code, repoName, message) });
    };
    const follow = (ref: HostedRef) => {
      stop = watchIndex({
        read: () => readStatus(ref),
        onProgress: (status) => {
          if (!cancelled) setView({ kind: "running", status });
        },
        onDone: () => {
          if (!cancelled) open(ref);
        },
        onFailed: (error) => {
          if (!cancelled) fail(error.code, error.message);
        },
        onError: () => {
          if (!cancelled) fail("network");
        },
      });
    };
    const settle = (reply: { state: "running" | "done" | "failed"; sha: string; error?: { code: string; message: string } }, isPrivate: boolean) => {
      const ref = { owner, repo, sha: reply.sha, private: isPrivate };
      if (reply.state === "done") return open(ref);
      if (reply.state === "failed") return fail(reply.error?.code ?? "index_failed", reply.error?.message);
      follow(ref);
    };
    const signedIn = async () => (await authMe()).signedIn;

    const run = async () => {
      setView({ kind: "checking" });
      try {
        if (sha) {
          const pub = { owner, repo, sha };
          const status = await readStatus(pub);
          if (cancelled) return;
          if (status) return settle(status, false);
          if (await signedIn()) {
            const priv = await readStatus({ ...pub, private: true });
            if (cancelled) return;
            if (priv) return settle(priv, true);
          }
          const reply = await requestIndex(repoName, sha);
          if (cancelled) return;
          return settle(reply, reply.visibility === "private");
        }
        const latest = await readLatest(root, owner, repo);
        if (cancelled) return;
        if (latest) return open({ owner, repo, sha: latest.sha });
        if (await signedIn()) {
          const priv = await readPrivateLatest(owner, repo);
          if (cancelled) return;
          if (priv) return open({ owner, repo, sha: priv.sha, private: true });
        }
        const reply = await requestIndex(repoName);
        if (cancelled) return;
        return settle(reply, reply.visibility === "private");
      } catch (err) {
        if (cancelled) return;
        if (err instanceof IndexRequestError) fail(err.code, err.message);
        else fail("network");
      }
    };
    void run();
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [owner, repo, sha, attempt]);

  return (
    <section className="home index-page">
      <p>
        <a href="#/">Home</a>
      </p>
      <h1>
        {repoName}
        {sha && <span className="muted index-sha"> @{sha.slice(0, 7)}</span>}
      </h1>

      {view.kind === "checking" && (
        <p className="muted" role="status">
          Looking for an index of {repoName}
        </p>
      )}

      {view.kind === "running" && <RunProgress status={view.status} />}

      {view.kind === "failed" && (
        <div className="panel index-error" role="alert">
          {view.code === "auth_required" ? (
            <p className="error">
              This repository is private. <a href={signInUrl(window.location.hash || "#/")}>Sign in with GitHub</a>
            </p>
          ) : (
            <p className="error">{view.message}</p>
          )}
          <div className="row">
            {canRetry(view.code) && (
              <button type="button" className="add-submit" onClick={() => setAttempt((n) => n + 1)}>
                Try again
              </button>
            )}
            <a href="#/">Back to home</a>
          </div>
        </div>
      )}
    </section>
  );
}
