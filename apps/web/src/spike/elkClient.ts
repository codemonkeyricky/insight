// Layout requests for the zoom spike. elkjs runs its solver in its own classic worker script (elk-worker.min.js),
// which elk-api talks to with promises. `?elk=main` runs the bundled solver on the main thread instead, so the
// two can be timed against each other.
import ELK from "elkjs/lib/elk-api.js";
import elkWorkerUrl from "elkjs/lib/elk-worker.min.js?url";
import type { ElkNode } from "elkjs/lib/elk-api";

export interface LayoutReply {
  result: ElkNode;
  /** Time spent in the solver, measured on the main thread around the call. */
  ms: number;
  where: "worker" | "main";
}

type ElkClient = InstanceType<typeof ELK>;

const useMain = new URLSearchParams(window.location.search).get("elk") === "main";
let worker: ElkClient | undefined;
let mainElk: Promise<ElkClient> | undefined;

export function layoutGraph(graph: ElkNode): Promise<LayoutReply> {
  const t0 = performance.now();
  if (useMain) {
    // The bundled build (solver and worker shim together) is loaded only for this comparison, not in the app bundle.
    mainElk ??= import("elkjs/lib/elk.bundled.js").then((m) => new m.default() as ElkClient);
    return mainElk.then((elk) => elk.layout(graph)).then((result) => ({ result, ms: performance.now() - t0, where: "main" as const }));
  }
  worker ??= new ELK({ workerUrl: elkWorkerUrl });
  return worker.layout(graph).then((result) => ({ result, ms: performance.now() - t0, where: "worker" as const }));
}
