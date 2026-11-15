// The browser's solver for state diagrams: elkjs in its own worker, like zoom/elk.ts but with its own instance, so a
// state diagram never queues behind the zoom map. Tests use the bundled solver instead (jsdom has no worker).
// A worker that fails to load or crashes rejects the pending layouts; the timeout is `withTimeout`'s.
import ELK from "elkjs/lib/elk-api.js";
import elkWorkerUrl from "elkjs/lib/elk-worker.min.js?url";
import type { ElkNode } from "elkjs/lib/elk-api";
import { withTimeout } from "./layout";

let client: InstanceType<typeof ELK> | undefined;
const failures = new Set<(e: Error) => void>();

function makeClient(): InstanceType<typeof ELK> {
  return new ELK({
    workerFactory: () => {
      const worker = new Worker(elkWorkerUrl);
      const fail = (ev: ErrorEvent | MessageEvent) => {
        // Drop the dead client so the next layout starts a fresh worker.
        client = undefined;
        const err = new Error(`the layout worker failed${"message" in ev && typeof ev.message === "string" && ev.message ? `: ${ev.message}` : ""}`);
        for (const f of [...failures]) f(err);
      };
      worker.addEventListener("error", fail);
      worker.addEventListener("messageerror", fail);
      return worker;
    },
  });
}

const raw = (graph: ElkNode): Promise<ElkNode> =>
  new Promise((resolve, reject) => {
    client ??= makeClient();
    failures.add(reject);
    client.layout(graph).then(resolve, reject).finally(() => failures.delete(reject));
  });

export const solveInWorker = withTimeout(raw);
