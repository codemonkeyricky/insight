import { Worker } from "node:worker_threads";
import type { ExecModel, SceneLayout } from "@insight/flow";

// The exec layout is solved in one long-lived worker thread (exec-layout-worker.js), so the server keeps answering while
// a large scene is laid out. The worker starts on the first request, and a new one starts after it exits or fails.

interface Pending {
  worker: Worker;
  resolve(layout: SceneLayout): void;
  reject(error: Error): void;
}

interface WorkerAnswer {
  id: number;
  layout?: SceneLayout;
  error?: string;
}

let worker: Worker | undefined;
let nextId = 1;
const pending = new Map<number, Pending>();

/**
 * Takes a request off the map. The worker is kept ref'd while any request is owed, so a process that awaits a solve
 * is not ended under it, and unref'd when idle, so an idle worker does not keep the process alive.
 */
function settle(id: number): Pending | undefined {
  const p = pending.get(id);
  if (p === undefined) return undefined;
  pending.delete(id);
  if (pending.size === 0) p.worker.unref();
  return p;
}

/** Rejects the requests a worker still owes. Other workers' requests are left alone. */
function failPending(owner: Worker, error: Error): void {
  for (const [id, p] of pending) {
    if (p.worker !== owner) continue;
    settle(id)?.reject(error);
  }
}

function start(): Worker {
  const next = new Worker(new URL("./exec-layout-worker.js", import.meta.url));
  next.on("message", (answer: WorkerAnswer) => {
    const p = settle(answer.id);
    if (!p) return;
    if (answer.error !== undefined) p.reject(new Error(answer.error));
    else if (answer.layout !== undefined) p.resolve(answer.layout);
    else p.reject(new Error("layout worker sent no layout"));
  });
  // An error is followed by an exit, so one handler does the clean-up for both. The next request starts a new worker.
  const lost = (error: Error) => {
    if (worker === next) worker = undefined;
    failPending(next, error);
  };
  next.on("error", (error) => lost(error));
  next.on("exit", (code) => lost(new Error(`layout worker exited with code ${code}`)));
  // Idle, the worker does not keep the process alive. settle() holds it while a request is owed.
  next.unref();
  return next;
}

/** Lays out one exec model's scene, all containers, in the layout worker. Resolves to the SceneLayout the page reads. */
export function solveExecLayout(exec: ExecModel): Promise<SceneLayout> {
  worker ??= start();
  const current = worker;
  const id = nextId++;
  return new Promise<SceneLayout>((resolve, reject) => {
    pending.set(id, { worker: current, resolve, reject });
    current.ref();
    try {
      current.postMessage({ id, exec });
    } catch (error) {
      settle(id);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

/** Stops the layout worker. Requests it still owes are rejected. The next solve starts a new one. */
export async function closeExecLayoutWorker(): Promise<void> {
  const current = worker;
  worker = undefined;
  if (current === undefined) return;
  await current.terminate();
}
