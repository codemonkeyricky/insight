import { useEffect, useMemo, useReducer, useRef } from "react";
import type { RunProgress } from "./api";
import { initialIndexState, reduceIndexState } from "./indexProgress";
import { useProjectEvents, type RunEvent } from "./useEvents";

export interface IndexRun {
  running: boolean;
  progress?: RunProgress;
  /** The furthest fraction shown this run (0 to 1). */
  fraction: number;
  /** The run's recent log lines, replayed ones included, without duplicates. */
  lines: string[];
  lastError?: string;
  finishedAt?: string;
}

/**
 * One project's index run, from its event stream. `initial` is the project's progress as last read: the run may already be under
 * way when the page opens, so the bar shows before the stream connects. `onEvent` sees every event, for a caller that reloads
 * its own data on done, failed or status.
 */
export function useIndexProgress(id: string, initial?: RunProgress, onEvent?: (event: RunEvent) => void): IndexRun {
  const [state, dispatch] = useReducer(reduceIndexState, initialIndexState);
  const handler = useRef(onEvent);
  handler.current = onEvent;
  const initialRef = useRef(initial);
  initialRef.current = initial;
  const startedAt = initial?.startedAt;

  useEffect(() => {
    dispatch({ type: "reset" });
  }, [id]);

  useEffect(() => {
    const p = initialRef.current;
    if (p) dispatch({ type: "seed", progress: p });
  }, [id, startedAt]);

  useProjectEvents(id, (event) => {
    dispatch({ type: "event", event });
    handler.current?.(event);
  });

  const lines = useMemo(() => state.entries.map((entry) => entry.text), [state.entries]);
  return {
    running: state.running,
    progress: state.progress,
    fraction: state.fraction,
    lines,
    lastError: state.lastError,
    finishedAt: state.finishedAt,
  };
}
