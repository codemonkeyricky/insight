// The browser's solver for state diagrams: elkjs in its own worker, like zoom/elk.ts but with its own instance, so a
// state diagram never queues behind the zoom map. Tests use the bundled solver instead (jsdom has no worker).
import ELK from "elkjs/lib/elk-api.js";
import elkWorkerUrl from "elkjs/lib/elk-worker.min.js?url";
import type { ElkNode } from "elkjs/lib/elk-api";

let client: InstanceType<typeof ELK> | undefined;

export function solveInWorker(graph: ElkNode): Promise<ElkNode> {
  client ??= new ELK({ workerUrl: elkWorkerUrl });
  return client.layout(graph);
}
