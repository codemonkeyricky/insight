// Following a hosted index run: each read of its status.json is one step. A run that is still going is polled again; one
// that finished or failed ends the watch. Pure apart from the timer, so the tests drive it with fake timers.

/** The part of a status.json the watch reads. */
export interface PollStatus {
  state: "running" | "done" | "failed";
  phase?: string;
  done?: number;
  total?: number;
  error?: { code: string; message: string };
}

export type PollStep = { kind: "wait" } | { kind: "done" } | { kind: "failed"; error: { code: string; message: string } };

/** What one status read means for the watch. An unknown state keeps waiting, so a newer server cannot end the watch early. */
export function stepFor(status: PollStatus): PollStep {
  if (status.state === "done") return { kind: "done" };
  if (status.state === "failed") return { kind: "failed", error: status.error ?? { code: "index_failed", message: "Indexing failed." } };
  return { kind: "wait" };
}

export interface WatchOptions {
  /** Reads the status file. Undefined when no status has been written yet. */
  read: () => Promise<PollStatus | undefined>;
  onProgress: (status: PollStatus) => void;
  onDone: () => void;
  onFailed: (error: { code: string; message: string }) => void;
  /** Called when the status cannot be read `maxNetworkErrors` times in a row. */
  onError: () => void;
  intervalMs?: number;
  maxNetworkErrors?: number;
  /** A run with no status file after this many reads is treated as failed. */
  maxMissing?: number;
}

/**
 * Polls `read` every `intervalMs` until the run ends. The first read comes one interval after the call. Returns a function
 * that stops the watch.
 */
export function watchIndex(opts: WatchOptions): () => void {
  const intervalMs = opts.intervalMs ?? 1500;
  const maxNetworkErrors = opts.maxNetworkErrors ?? 3;
  const maxMissing = opts.maxMissing ?? 5;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let networkErrors = 0;
  let missing = 0;

  const schedule = () => {
    if (!stopped) timer = setTimeout(tick, intervalMs);
  };
  const finish = () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
  };

  const tick = async () => {
    if (stopped) return;
    let status: PollStatus | undefined;
    try {
      status = await opts.read();
      networkErrors = 0;
    } catch {
      networkErrors += 1;
      if (networkErrors >= maxNetworkErrors) {
        finish();
        opts.onError();
      } else {
        schedule();
      }
      return;
    }
    if (stopped) return;
    if (status === undefined) {
      missing += 1;
      if (missing >= maxMissing) {
        finish();
        opts.onFailed({ code: "index_failed", message: "The server wrote no status for this run." });
      } else {
        schedule();
      }
      return;
    }
    const step = stepFor(status);
    if (step.kind === "done") {
      finish();
      opts.onDone();
    } else if (step.kind === "failed") {
      finish();
      opts.onFailed(step.error);
    } else {
      opts.onProgress(status);
      schedule();
    }
  };

  schedule();
  return finish;
}
