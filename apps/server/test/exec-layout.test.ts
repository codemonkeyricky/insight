import { afterAll, describe, expect, it } from "vitest";
import { buildExecScene, layoutCovers, type ExecFunctionRef, type ExecModel } from "@insight/flow";
import { closeExecLayoutWorker, solveExecLayout } from "../src/exec-layout.js";

// The layout worker, tested on its own with a large synthetic exec model. The model is one main thread that reaches
// every function, so the scene has a container per file and one for the thread, and the layered layout has real work to do.

/** A model of `n` functions spread over 40 files, each calling three others. Shaped the way execModel answers. */
function syntheticExec(n: number): ExecModel {
  const functions: ExecFunctionRef[] = Array.from({ length: n }, (_, i) => ({
    id: `src/f${i % 40}.ts#fn${i}`,
    name: `fn${i}`,
    file: `src/f${i % 40}.ts`,
    line: i + 1,
    inScope: true,
    runtime: "thread",
  }));
  const pairs = new Map<string, [number, number]>();
  for (let i = 0; i < n; i++) {
    for (const j of [(i * 7 + 3) % n, (i * 13 + 5) % n, (i + 1) % n]) {
      if (j !== i) pairs.set(`${i},${j}`, [i, j]);
    }
  }
  const ids = functions.map((f) => f.id);
  return {
    scope: "",
    truncated: false,
    functions,
    threads: [{ id: "main", kind: "main", roots: [ids[0]!], reach: n, reached: [...ids].sort(), coroutines: [], coroutineOnly: [] }],
    programs: [],
    resources: [],
    dispatches: [],
    calls: [...pairs.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]),
    unthreaded: [],
    stats: {
      threads: 1,
      spawns: 0,
      programs: 0,
      locks: 0,
      channels: 0,
      resolved: 0,
      outside: 0,
      unresolved: 0,
      candidates: 0,
      coroutines: 0,
      dispatches: 0,
      functionsInScope: n,
      functionsThreaded: n,
      functionsCoroutineOnly: 0,
      functionsUnthreaded: 0,
      functionsListed: n,
    },
  } as ExecModel;
}

describe("the exec layout worker", () => {
  afterAll(async () => {
    await closeExecLayoutWorker();
  });

  it("keeps the event loop responsive while a large scene is solved", async () => {
    const exec = syntheticExec(900);
    let last = performance.now();
    let maxGap = 0;
    let ticks = 0;
    const timer = setInterval(() => {
      const now = performance.now();
      maxGap = Math.max(maxGap, now - last);
      last = now;
      ticks += 1;
    }, 10);
    const started = performance.now();
    const layout = await solveExecLayout(exec);
    const solveMs = performance.now() - started;
    clearInterval(timer);
    console.log(`900-function scene: solved in ${solveMs.toFixed(0)} ms, ${ticks} loop ticks, longest gap ${maxGap.toFixed(0)} ms`);

    expect(layoutCovers(buildExecScene(exec), layout)).toBe(true);
    // The solve must have overlapped the sampling, or the gap says nothing.
    expect(ticks).toBeGreaterThan(3);
    expect(maxGap).toBeLessThan(100);
  }, 120_000);

  it("starts a new worker after the old one is closed", async () => {
    await closeExecLayoutWorker();
    const exec = syntheticExec(30);
    const layout = await solveExecLayout(exec);
    expect(layoutCovers(buildExecScene(exec), layout)).toBe(true);
    await closeExecLayoutWorker();
  }, 60_000);

  it("rejects with the worker's message for a model it cannot lay out, and still answers the next request", async () => {
    await expect(solveExecLayout({ functions: null } as unknown as ExecModel)).rejects.toThrow();
    const exec = syntheticExec(20);
    const layout = await solveExecLayout(exec);
    expect(layoutCovers(buildExecScene(exec), layout)).toBe(true);
  }, 60_000);
});
