// The index run's progress as a bar: which share of a run each phase takes, and the reducer that folds the run's events into
// what the UI shows. Pure, so the tests can replay a recorded run without a DOM or an event stream.
import type { IndexPhase, PhaseProgress, RunProgress } from "./api";
import type { RunEvent } from "./useEvents";

/** How much of a run each phase takes, in run order. The weights sum to 1. */
export const PHASE_WEIGHTS: Readonly<Record<IndexPhase, number>> = {
  fetch: 0.05,
  scan: 0.05,
  extract: 0.7,
  link: 0.1,
  analyze: 0.07,
  save: 0.03,
};

const ORDER: readonly IndexPhase[] = ["fetch", "scan", "extract", "link", "analyze", "save"];

/** Where a phase starts on the run's bar: the weights of the phases before it. */
function startOf(phase: IndexPhase): number {
  let at = 0;
  for (const p of ORDER) {
    if (p === phase) return at;
    at += PHASE_WEIGHTS[p];
  }
  return at;
}

const clamp01 = (x: number): number => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);

/**
 * The share of the whole run (0 to 1) at this progress. An uncounted phase sits at its start. Extract fills its share across the
 * frontends in turn. Save is the last phase and is the end of the run, so it reads 1.
 */
export function progressFraction(p: PhaseProgress): number {
  const weight = PHASE_WEIGHTS[p.phase];
  if (weight === undefined) return 0;
  if (p.phase === "save") return 1;
  const start = startOf(p.phase);
  const within = p.total !== undefined && p.total > 0 ? clamp01((p.done ?? 0) / p.total) : 0;
  if (p.phase !== "extract") return clamp01(start + weight * within);
  const steps = Math.max(1, p.steps ?? 1);
  const step = Math.min(steps, Math.max(1, p.step ?? 1));
  return clamp01(start + weight * ((step - 1 + within) / steps));
}

/** The run's log lines kept on screen. */
export const LOG_LIMIT = 200;

export interface LogEntry {
  /** Identifies the line, so a replayed line that also arrives live is kept once. */
  key: string;
  text: string;
}

export interface IndexState {
  running: boolean;
  progress?: RunProgress;
  /** The furthest fraction this run has shown. It never goes down within a run. */
  fraction: number;
  entries: LogEntry[];
  lastError?: string;
  finishedAt?: string;
}

export type IndexAction = { type: "reset" } | { type: "seed"; progress: RunProgress } | { type: "event"; event: RunEvent };

export const initialIndexState: IndexState = { running: false, fraction: 0, entries: [] };

export function reduceIndexState(state: IndexState, action: IndexAction): IndexState {
  switch (action.type) {
    case "reset":
      return initialIndexState;
    case "seed":
      return applyPhase(state, action.progress);
    case "event":
      return reduceEvent(state, action.event);
  }
}

/** A phase of a run. A phase of another run (a new start) clears the lines of the last one. */
function applyPhase(state: IndexState, p: RunProgress): IndexState {
  const fresh = state.progress?.startedAt !== p.startedAt;
  const base = fresh ? { ...state, entries: [], fraction: 0 } : state;
  return {
    ...base,
    running: true,
    progress: p,
    fraction: Math.max(base.fraction, progressFraction(p)),
    lastError: undefined,
    finishedAt: undefined,
  };
}

function reduceEvent(state: IndexState, e: RunEvent): IndexState {
  switch (e.type) {
    case "status":
      if (e.status === "indexing") return state.running ? state : { ...state, running: true };
      return state.running ? { ...state, running: false } : state;
    case "phase":
      return e.progress ? applyPhase(state, e.progress) : state;
    case "progress": {
      if (!e.line) return state;
      const key = `${e.at}\u0000${e.line}`;
      if (state.entries.some((entry) => entry.key === key)) return state;
      const entries = [...state.entries, { key, text: `${e.at.slice(11, 19)}  ${e.line}` }];
      return { ...state, entries: entries.slice(-LOG_LIMIT) };
    }
    case "done":
      return { ...state, running: false, fraction: 1, finishedAt: e.at, lastError: undefined };
    case "failed":
      return { ...state, running: false, lastError: e.error ?? "Indexing failed", finishedAt: undefined };
    default:
      return state;
  }
}
