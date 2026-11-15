// The browser's solver for state diagrams: elkjs in its own worker, like zoom/elk.ts but with its own instance, so a
// state diagram never queues behind the zoom map. Tests use the bundled solver instead (jsdom has no worker).
// A worker that fails to load, crashes or times out is terminated and rejects its pending layouts; the next layout
// starts a fresh worker. Each client owns its worker and its pending layouts, so a late event from an old worker
// cannot touch the current client.
import ELK from "elkjs/lib/elk-api.js";
import elkWorkerUrl from "elkjs/lib/elk-worker.min.js?url";
import type { ElkNode } from "elkjs/lib/elk-api";
import { LAYOUT_TIMEOUT_MS, type Solve } from "./layout";

interface Client {
  elk: InstanceType<typeof ELK>;
  worker?: Worker;
  failures: Set<(e: Error) => void>;
}

/** A solver over workers from `newWorker`; one worker at a time, replaced after any failure. */
export function createWorkerSolver(newWorker: () => Worker, ms = LAYOUT_TIMEOUT_MS): Solve {
  let current: Client | undefined;

  const makeClient = (): Client => {
    const self: Client = { failures: new Set(), elk: undefined as unknown as Client["elk"] };
    self.elk = new ELK({
      workerFactory: () => {
        const worker = newWorker();
        self.worker = worker;
        const fail = (ev: ErrorEvent | MessageEvent) => {
          const msg = "message" in ev && typeof ev.message === "string" && ev.message ? `: ${ev.message}` : "";
          kill(self, new Error(`the layout worker failed${msg}`));
        };
        worker.addEventListener("error", fail);
        worker.addEventListener("messageerror", fail);
        return worker;
      },
    });
    return self;
  };

  /** Terminate this client's worker, reject its pending layouts, and forget it if it is still the current one. */
  const kill = (self: Client, err: Error) => {
    try {
      self.worker?.terminate();
    } catch {
      // already gone
    }
    if (current === self) current = undefined;
    for (const f of [...self.failures]) f(err);
    self.failures.clear();
  };

  return (graph: ElkNode) =>
    new Promise<ElkNode>((resolve, reject) => {
      const self = (current ??= makeClient());
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = () => {
        if (timer !== undefined) clearTimeout(timer);
        self.failures.delete(reject);
      };
      self.failures.add(reject);
      timer = setTimeout(() => kill(self, new Error(`layout timed out after ${Math.round(ms / 1000)} s`)), ms);
      self.elk.layout(graph).then(
        (g) => {
          settle();
          resolve(g);
        },
        (e) => {
          settle();
          reject(e);
        },
      );
    });
}

export const solveInWorker: Solve = createWorkerSolver(() => new Worker(elkWorkerUrl));
