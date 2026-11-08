// Runs the zoom map's layouts in elkjs's own worker, so the page does not stall while a container is solved.
// elk-api talks to the classic worker script (elk-worker.min.js) with promises. The bundled solver (elk.bundled.js)
// cannot run inside a module worker, so it is not used here.
import ELK from "elkjs/lib/elk-api.js";
import elkWorkerUrl from "elkjs/lib/elk-worker.min.js?url";
import type { ElkNode } from "elkjs/lib/elk-api";
import type { LayoutGraph } from "@insight/flow";

export interface Solved {
  result: ElkNode;
  /** Time the solve took on the page, from the call to the answer. */
  ms: number;
}

type ElkClient = InstanceType<typeof ELK>;

let worker: ElkClient | undefined;

/** Solves one container's graph in the worker. The worker starts on the first call. */
export function solve(graph: LayoutGraph): Promise<Solved> {
  const t0 = performance.now();
  worker ??= new ELK({ workerUrl: elkWorkerUrl });
  return worker.layout(graph as unknown as ElkNode).then((result) => ({ result, ms: performance.now() - t0 }));
}
