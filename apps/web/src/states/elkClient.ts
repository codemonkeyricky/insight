// The browser's solver for state diagrams: elkjs in its own worker, like zoom/elk.ts but with its own instance, so a
// state diagram never queues behind the zoom map. Tests use the bundled solver instead (jsdom has no worker).
// Jobs run one at a time and each one's timeout starts when it is sent to the worker. A timeout or a worker failure
// terminates the worker, rejects only the job that was running, and resubmits the still-wanted queued jobs to a fresh
// worker. An aborted job rejects with an AbortError; if nothing wanted is left the worker is terminated.
import ELK from "elkjs/lib/elk-api.js";
import elkWorkerUrl from "elkjs/lib/elk-worker.min.js?url";
import type { ElkNode } from "elkjs/lib/elk-api";
import { LAYOUT_TIMEOUT_MS, abortError, type Solve } from "./layout";

interface Client {
  elk: InstanceType<typeof ELK>;
  worker?: Worker;
}

interface Job {
  graph: ElkNode;
  signal: AbortSignal | undefined;
  resolve: (g: ElkNode) => void;
  reject: (e: Error) => void;
  onAbort?: () => void;
}

/** A solver over workers from `newWorker`; one worker at a time, replaced after any failure. */
export function createWorkerSolver(newWorker: () => Worker, ms = LAYOUT_TIMEOUT_MS): Solve {
  let current: Client | undefined;
  let running: Job | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const queue: Job[] = [];

  const makeClient = (): Client => {
    const self: Client = { elk: undefined as unknown as Client["elk"] };
    self.elk = new ELK({
      workerFactory: () => {
        const worker = newWorker();
        self.worker = worker;
        const fail = (ev: ErrorEvent | MessageEvent) => {
          if (current !== self) return; // a late event from an old worker
          const msg = "message" in ev && typeof ev.message === "string" && ev.message ? `: ${ev.message}` : "";
          failRunning(new Error(`the layout worker failed${msg}`));
        };
        worker.addEventListener("error", fail);
        worker.addEventListener("messageerror", fail);
        return worker;
      },
    });
    return self;
  };

  const dropClient = () => {
    const c = current;
    current = undefined;
    try {
      c?.worker?.terminate();
    } catch {
      // already gone
    }
  };

  const finish = (job: Job) => {
    if (job.onAbort) job.signal?.removeEventListener("abort", job.onAbort);
  };

  /** Terminate the worker, reject the running job (if any), and carry on with the queue on a fresh worker. */
  const failRunning = (err: Error) => {
    const job = running;
    running = undefined;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    dropClient();
    if (job) {
      finish(job);
      job.reject(err);
    }
    pump();
  };

  const pump = () => {
    if (running) return;
    const job = queue.shift();
    if (!job) return;
    let self: Client;
    try {
      self = current ??= makeClient();
    } catch (e) {
      // No worker could be made: this job fails, the next one gets its own try.
      finish(job);
      job.reject(e instanceof Error ? e : new Error(String(e)));
      pump();
      return;
    }
    running = job;
    timer = setTimeout(() => {
      if (running === job) failRunning(new Error(`layout timed out after ${Math.round(ms / 1000)} s`));
    }, ms);
    self.elk.layout(job.graph).then(
      (g) => {
        if (running !== job || current !== self) return;
        running = undefined;
        clearTimeout(timer);
        finish(job);
        job.resolve(g);
        pump();
      },
      (e) => {
        if (running !== job || current !== self) return;
        failRunning(e instanceof Error ? e : new Error(String(e)));
      },
    );
  };

  return (graph, signal) =>
    new Promise<ElkNode>((resolve, reject) => {
      if (signal?.aborted) return reject(abortError());
      const job: Job = { graph, signal, resolve, reject };
      if (signal) {
        job.onAbort = () => {
          if (running === job) {
            // The worker is busy with a job nobody wants: replace it, so the queue does not wait behind it.
            running = undefined;
            if (timer !== undefined) clearTimeout(timer);
            timer = undefined;
            dropClient();
            finish(job);
            reject(abortError());
            pump();
            return;
          }
          const i = queue.indexOf(job);
          if (i >= 0) queue.splice(i, 1);
          finish(job);
          reject(abortError());
        };
        signal.addEventListener("abort", job.onAbort);
      }
      queue.push(job);
      pump();
    });
}

export const solveInWorker: Solve = createWorkerSolver(() => new Worker(elkWorkerUrl));
