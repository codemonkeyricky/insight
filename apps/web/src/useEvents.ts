import { IS_DEMO, type RunProgress } from "./api";
import { useEffect, useRef } from "react";

export interface RunEvent {
  type: "status" | "phase" | "progress" | "done" | "failed";
  projectId: string;
  status?: string;
  queued?: boolean;
  line?: string;
  error?: string;
  /** A phase event's progress. */
  progress?: RunProgress;
  /** A progress line replayed on connect (the run's recent lines), not a live one. */
  replay?: boolean;
  at: string;
}

/** Subscribes to a project's job events. The callback is kept current without reconnecting. */
export function useProjectEvents(projectId: string | undefined, onEvent: (event: RunEvent) => void): void {
  const handler = useRef(onEvent);
  handler.current = onEvent;

  useEffect(() => {
    if (!projectId || IS_DEMO || typeof EventSource === "undefined") return;
    const source = new EventSource(`/api/projects/${encodeURIComponent(projectId)}/events`);
    const listen = () => (message: MessageEvent<string>) => {
      try {
        handler.current(JSON.parse(message.data) as RunEvent);
      } catch {
        /* a malformed event is ignored; the next full read corrects the view */
      }
    };
    const listeners = (["status", "phase", "progress", "done", "failed"] as const).map((t) => [t, listen()] as const);
    for (const [t, fn] of listeners) source.addEventListener(t, fn);
    return () => {
      for (const [t, fn] of listeners) source.removeEventListener(t, fn);
      source.close();
    };
  }, [projectId]);
}
