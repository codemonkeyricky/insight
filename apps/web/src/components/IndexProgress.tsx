import { useEffect, useState } from "react";
import type { RunProgress } from "../api";
import { progressFraction } from "../indexProgress";

/** m:ss for a length in milliseconds. */
export const fmtClock = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** The rough time left, from the last successful run's length. Shown only once the run is past 15 % and a previous run exists. */
export function etaText(progress: RunProgress, fraction: number): string | undefined {
  if (progress.previousMs === undefined || fraction <= 0.15) return undefined;
  return `~${fmtClock(progress.previousMs * (1 - fraction))} left`;
}

export interface IndexProgressProps {
  progress?: RunProgress;
  /** The furthest fraction the run has shown (see useIndexProgress). Defaults to the progress's own. */
  fraction?: number;
  /** Replaces the text built from the progress: the done state's summary. */
  label?: string;
  /** A failed run: the bar turns red and the text is the error. */
  error?: string;
  compact?: boolean;
  /** The clock for the elapsed time, for tests. The component ticks once a second otherwise. */
  now?: number;
}

/**
 * A run's progress: a 3 px bar and a line of text such as "Extracting · typescript 312 / 491 · 0:21". A phase that does not count
 * its work shows a shimmer instead of a moving count; reduced motion turns the shimmer off (styles.css).
 */
export function IndexProgress({ progress, fraction, label, error, compact = false, now }: IndexProgressProps) {
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    if (now !== undefined) return;
    const timer = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [now]);

  const f = Math.min(1, Math.max(0, fraction ?? (progress ? progressFraction(progress) : 0)));
  const counted = progress
    ? (progress.done !== undefined && progress.total !== undefined) || progress.phase === "save"
    : fraction !== undefined;
  const shimmer = error === undefined && !counted && f < 1;

  const clock = now ?? tick;
  const started = progress ? Date.parse(progress.startedAt) : Number.NaN;
  const elapsed = Number.isFinite(started) ? fmtClock(Math.max(0, clock - started)) : undefined;
  const head = progress
    ? `${progress.label}${progress.done !== undefined && progress.total !== undefined ? ` ${progress.done} / ${progress.total}` : ""}`
    : "Starting";
  const eta = progress && error === undefined ? etaText(progress, f) : undefined;
  const text = error ?? label ?? [head, elapsed, eta].filter(Boolean).join(" · ");

  return (
    <div className={["idx", compact ? "idx-compact" : "", error !== undefined ? "is-failed" : ""].filter(Boolean).join(" ")}>
      <div
        className={`idx-bar${shimmer ? " is-uncounted" : ""}`}
        role="progressbar"
        aria-label="Indexing progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(f * 100)}
        aria-valuetext={text}
      >
        <span className="idx-fill" style={{ width: `${(f * 100).toFixed(1)}%` }} />
      </div>
      <div className={`idx-label small ${error !== undefined ? "error" : "muted"}`} title={text}>
        {text}
      </div>
    </div>
  );
}
