// P0 sizing probe for execModel (packages/core/flow). Fetches each project's model from a running Insight server
// (GET /api/projects/:id/model), runs execModel per scope three times with maxFunctions Infinity and with the default
// cap, and prints one JSON document of sizes and median times.
//
// Usage: node scripts/probe-exec-sizing.mjs <serverUrl> <specJson> [outFile]
//   specJson: [{"name":"worktree","id":"<project id>","scopes":["","packages"]}, ...]
// Component approximation: a function's component is the folder of its file (dirname of span.file). A thread's
// slices are the distinct components of the functions it reaches.
import { performance } from "node:perf_hooks";
import { writeFileSync } from "node:fs";
import { execModel } from "../packages/core/flow/dist/index.js";
import { loadModel } from "../packages/core/model/dist/index.js";

const RUNS = 3;
const COROUTINE_LIMIT = 16;
const [, , serverArg = "http://127.0.0.1:4361", specArg = "[]", outArg] = process.argv;
const specs = JSON.parse(specArg);

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? 0 : s[Math.floor(s.length / 2)];
};
const dirOf = (f) => {
  const i = f.lastIndexOf("/");
  return i < 0 ? "." : f.slice(0, i);
};
const inScope = (file, scope) => scope === "" || file === scope || file.startsWith(`${scope}/`);

function timed(model, scope, opts) {
  const times = [];
  let last;
  for (let i = 0; i < RUNS; i++) {
    const t0 = performance.now();
    last = execModel(model.doc.nodes, model.doc.edges, scope, opts);
    times.push(performance.now() - t0);
  }
  return { ms: median(times), ex: last };
}

function measure(model, scope) {
  const inf = timed(model, scope, { maxFunctions: Infinity });
  const def = timed(model, scope, {});
  const ex = inf.ex;
  const fnFile = new Map(ex.functions.map((f) => [f.id, f.file]));

  let coStart = 0;
  let coAwait = 0;
  let maxStart = 0;
  let maxAwait = 0;
  let threadsOverLimit = 0;
  let largest = { id: "", slices: 0, reach: 0 };
  const sliceCounts = [];
  for (const t of ex.threads) {
    let s = 0;
    let a = 0;
    for (const c of t.coroutines) {
      if (c.how === "start") s++;
      else a++;
    }
    coStart += s;
    coAwait += a;
    maxStart = Math.max(maxStart, s);
    maxAwait = Math.max(maxAwait, a);
    if (a > COROUTINE_LIMIT) threadsOverLimit++;
    const comps = new Set(t.reached.map((id) => dirOf(fnFile.get(id) ?? "")));
    sliceCounts.push(comps.size);
    if (comps.size > largest.slices) largest = { id: t.id, slices: comps.size, reach: t.reach };
  }

  const disp = { timer: 0, microtask: 0, callback: 0, message: 0, other: 0 };
  for (const d of ex.dispatches) {
    if (d.how in disp) disp[d.how]++;
    else disp.other++;
  }

  let postNodes = 0;
  let syncNodes = 0;
  let scopedLock = 0;
  let postInScope = 0;
  let syncInScope = 0;
  let lockInScope = 0;
  for (const n of model.doc.nodes) {
    const file = n.span?.file ?? "";
    const here = inScope(file, scope);
    if (n.kind === "effects.message.post") {
      postNodes++;
      if (here) postInScope++;
    }
    if (typeof n.kind === "string" && n.kind.startsWith("sync.")) {
      syncNodes++;
      if (here) syncInScope++;
    }
    if (n.kind === "x-cpp.scoped-lock") {
      scopedLock++;
      if (here) lockInScope++;
    }
  }

  return {
    functionsInScope: ex.stats.functionsInScope,
    functionsListed: ex.stats.functionsListed,
    timeInfMs: Math.round(inf.ms),
    timeDefaultMs: Math.round(def.ms),
    truncatedInf: ex.truncated,
    truncatedDefault: def.ex.truncated,
    programs: ex.programs.length,
    threads: ex.threads.length,
    threadsGrounded: ex.threads.filter((t) => t.grounded).length,
    coroutines: coStart + coAwait,
    coroutinesStart: coStart,
    coroutinesAwait: coAwait,
    maxStartPerThread: maxStart,
    maxAwaitPerThread: maxAwait,
    threadsOverCoroutineLimit: threadsOverLimit,
    slicesMedianPerThread: median(sliceCounts),
    slicesMaxPerThread: Math.max(0, ...sliceCounts),
    largestThread: largest,
    unthreaded: ex.unthreaded.length,
    dispatches: { ...disp, total: ex.dispatches.length },
    messagePostNodes: { project: postNodes, inScope: postInScope },
    syncNodes: { project: syncNodes, inScope: syncInScope },
    scopedLockNodes: { project: scopedLock, inScope: lockInScope },
  };
}

const results = [];
for (const spec of specs) {
  const res = await fetch(`${serverArg}/api/projects/${spec.id}/model`);
  if (!res.ok) throw new Error(`model fetch ${spec.id} failed: ${res.status}`);
  const model = loadModel(await res.json());
  for (const scope of spec.scopes) {
    const m = measure(model, scope);
    results.push({ project: spec.name, scope, nodes: model.doc.nodes.length, edges: model.doc.edges.length, ...m });
    console.error(`done ${spec.name} scope="${scope}" inf=${m.timeInfMs}ms def=${m.timeDefaultMs}ms`);
  }
}

const out = JSON.stringify({ runs: RUNS, coroutineLimit: COROUTINE_LIMIT, results }, null, 2);
if (outArg) writeFileSync(outArg, out + "\n");
console.log(out);
