// Solves one scope's exec scene in a worker thread, so a large layout does not stall the server's event loop.
// The server posts an ExecModel and gets back the SceneLayout the demo capture would save: every container solved by
// the bundled elkjs, positions rounded to a tenth. See exec-layout.ts for the side that posts and keeps the worker.
//
// Plain JavaScript on purpose: this file runs as it is from src under vitest, and tsc copies it to dist in production
// (tsconfig allowJs), so one path works in both.
import { createRequire } from "node:module";
import { parentPort } from "node:worker_threads";
import { buildExecScene, layoutScene } from "@insight/flow";

const ElkClass = createRequire(import.meta.url)("elkjs/lib/elk.bundled.js");
const elk = new ElkClass();

/** Positions to a tenth of a unit, as the demo capture rounds them. */
function roundLayout(layout) {
  const r = (n) => Math.round(n * 10) / 10;
  const containers = {};
  for (const [id, c] of Object.entries(layout.containers)) {
    containers[id] = { w: r(c.w), h: r(c.h), slots: c.slots.map((s) => ({ id: s.id, x: r(s.x), y: r(s.y), w: r(s.w), h: r(s.h) })) };
  }
  return { containers };
}

// Requests are solved one after another, in the order they arrive, so each answer is the same whatever the queue holds.
let queue = Promise.resolve();

async function solve({ id, exec }) {
  try {
    const layout = roundLayout(await layoutScene(buildExecScene(exec), (g) => elk.layout(g)));
    parentPort.postMessage({ id, layout });
  } catch (err) {
    parentPort.postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  }
}

parentPort.on("message", (request) => {
  queue = queue.then(() => solve(request));
});
