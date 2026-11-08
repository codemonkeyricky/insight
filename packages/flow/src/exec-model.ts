import type { IREdge, IRNode } from "@insight/ir";
import { edgeTargets } from "@insight/sdk";
import { insideScope } from "./scope-map.js";
import { isNoisePath } from "./scope.js";

/**
 * The execution model of one scope: the threads its code starts, the functions each thread runs, and the
 * coroutines each one awaits. It reads the call, reference, spawn and dispatch facts the flow view reads, but
 * answers "what runs where" rather than "how one file branches".
 *
 * Pure: no I/O and no clock. Edges are sorted by content before use, so the same facts give the same model
 * whatever order they arrive in.
 */

/**
 * Most distinct functions one model lists. Each function is listed once, in the order threads are built, and
 * past the cap later functions are dropped and `truncated` is set. Keeps one scope's JSON to a few hundred KB.
 */
export const MAX_EXEC_FUNCTIONS = 2000;

/** How a spawn starts its thread, as the spawns edge says. */
export type ExecSpawnHow = "thread" | "process" | "async";
/** How a dispatch starts its target. Only await and start make a coroutine; the others run on the same thread. */
export type ExecDispatchHow = "await" | "start" | "callback" | "timer" | "microtask";
export type ExecHow = ExecSpawnHow | ExecDispatchHow;
/** "main" is the thread the program starts on. The others are the spawns of the scope. */
export type ExecThreadKind = "main" | ExecSpawnHow;
/**
 * resolved: some target is a function or script with code in the scope.
 * outside: the spawn has targets, and every one lies outside the scope.
 * unresolved: the frontend found no target, or the target has no code in the IR.
 */
export type ExecSpawnStatus = "resolved" | "outside" | "unresolved";

/** A function the model names. `file` is "" and `line` 0 for a function the IR has no source for. */
export interface ExecFunctionRef {
  id: string;
  name: string;
  file: string;
  /** 1-based line of the definition. */
  line: number;
  inScope: boolean;
  /** Set for a function in a test, fixture or sample file. */
  noise?: true;
}

/** The spawn that starts a thread. */
export interface ExecSpawn {
  /** The spawn node's id. */
  node: string;
  /** The function, or file, whose code contains the spawn. */
  owner?: string;
  file: string;
  line: number;
  how: ExecSpawnHow;
  status: ExecSpawnStatus;
  /** True when the spawn had several possible targets. */
  candidates: boolean;
  /** The script file a worker runs. Its top-level code starts the thread, so its roots are the functions that code calls. */
  script?: string;
}

/** A function that a thread awaits or starts. */
export interface ExecCoroutine {
  /** The coroutine's function. Each target is listed once per thread. */
  target: string;
  how: "await" | "start";
  /** The coroutine whose code awaits this one. Absent when the thread's own code does. */
  parent?: string;
  /** The functions or files whose dispatch edges start this coroutine. */
  dispatchedBy: string[];
  /** The functions the coroutine reaches by calls, before it awaits another coroutine. The target is not included. */
  callees: string[];
}

/** One thread of the scope: the main thread, or one spawn. */
export interface ExecThread {
  id: string;
  kind: ExecThreadKind;
  spawn?: ExecSpawn;
  /** The functions the thread starts in. */
  roots: string[];
  /** The number of distinct functions the thread runs, roots included. Exact even when `reached` is cut. */
  reach: number;
  /** Those functions, sorted by id. Shorter than `reach` only when the model is truncated. */
  reached: string[];
  coroutines: ExecCoroutine[];
}

/** One dispatch edge whose source lies in the scope. */
export interface ExecDispatch {
  /** The function, or file for module-level code, that dispatches. */
  from: string;
  how: ExecDispatchHow;
  targets: string[];
  candidates: boolean;
  file: string;
  line: number;
}

/** Counts over the listed model. */
export interface ExecModelStats {
  threads: number;
  spawns: number;
  resolved: number;
  outside: number;
  unresolved: number;
  candidates: number;
  coroutines: number;
  dispatches: number;
  /** Functions whose file lies in the scope. */
  functionsInScope: number;
  /** Of those, the ones some thread runs. */
  functionsThreaded: number;
  /**
   * Of those, the ones no thread runs. A function called only from module-level code, such as a script's `main()`
   * call at the bottom of the file, is in this count: it is referenced by its file, so it is no thread's root.
   */
  functionsUnthreaded: number;
  /** The distinct functions the model lists. */
  functionsListed: number;
}

export interface ExecModel {
  scope: string;
  /** True when the function cap cut a list. */
  truncated: boolean;
  /** Every function the model names, each once. Thread and coroutine lists refer to these by id. */
  functions: ExecFunctionRef[];
  /** The main thread first, then one thread per spawn in scope, sorted by spawn id. */
  threads: ExecThread[];
  dispatches: ExecDispatch[];
  stats: ExecModelStats;
}

export interface ExecModelOptions {
  /** Overrides MAX_EXEC_FUNCTIONS. Tests use small values to exercise truncation. */
  maxFunctions?: number;
}

interface Fn {
  id: string;
  name: string;
  file: string | undefined;
  line: number;
  inScope: boolean;
  noise: boolean;
}

interface Dispatch {
  how: ExecDispatchHow;
  targets: string[];
  candidates: boolean;
  file: string;
  line: number;
}

interface Spawns {
  targets: Set<string>;
  candidates: boolean;
  how: ExecSpawnHow | undefined;
}

interface Plan {
  kind: ExecThreadKind;
  id: string;
  spawn?: ExecSpawn;
  roots: string[];
  reach: Set<string>;
  coroutines: ExecCoroutine[];
}

const SPAWN_KINDS: ReadonlySet<string> = new Set(["concurrency.spawn-thread", "concurrency.spawn-process"]);
const DISPATCH_HOWS: readonly ExecDispatchHow[] = ["await", "start", "callback", "timer", "microtask"];
const SPAWN_HOWS: readonly ExecSpawnHow[] = ["thread", "process", "async"];

/** Code-unit order, so sorts do not depend on the locale. */
const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function pick<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return allowed.find((a) => a === value);
}

function strAttr(attrs: Readonly<Record<string, unknown>> | undefined, key: string): string | undefined {
  const v = attrs?.[key];
  return typeof v === "string" ? v : undefined;
}

/** A sort key that covers everything the model reads from an edge, so the order is fixed by content alone. */
function edgeKey(e: IREdge): string {
  return [e.kind, e.from, JSON.stringify(e.to), e.span?.file ?? "", e.span?.start.join(":") ?? "", JSON.stringify(e.attrs ?? {})].join("\0");
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  const list = m.get(k);
  if (list) list.push(v);
  else m.set(k, [v]);
}

export function execModel(nodes: readonly IRNode[], edges: readonly IREdge[], scope: string, opts: ExecModelOptions = {}): ExecModel {
  const max = opts.maxFunctions ?? MAX_EXEC_FUNCTIONS;
  // A scope inside a test, fixture or sample folder shows its test code as roots. isNoisePath reads folders
  // from a path's parents, so a folder needs a trailing slash to count its own name, and a file needs its base name.
  const scopeNoise = isNoisePath(scope) || isNoisePath(`${scope}/`);

  const byId = new Map<string, IRNode>();
  const fns = new Map<string, Fn>();
  for (const n of nodes) {
    byId.set(n.id, n);
    if (n.kind !== "structure.function") continue;
    const file = n.span?.file;
    fns.set(n.id, {
      id: n.id,
      name: strAttr(n.attrs, "name") ?? (n.id.split("#")[1] ?? n.id),
      file,
      line: n.span ? n.span.start[0] + 1 : 0,
      inScope: file !== undefined && insideScope(file, scope),
      noise: file !== undefined && isNoisePath(file),
    });
  }

  // The file an id stands for. A function or spawn node gives its own file, or its owner's when it has no span.
  // An id with no node is a file, as module-level code's id is.
  const fileOf = (id: string): string | undefined => {
    const fn = fns.get(id);
    if (fn) return fn.file;
    const node = byId.get(id);
    if (!node) return id;
    if (node.span) return node.span.file;
    const owner = node.parent;
    if (owner === undefined) return undefined;
    const ownerFn = fns.get(owner);
    return ownerFn ? ownerFn.file : owner;
  };
  const inScopeId = (id: string): boolean => {
    const file = fileOf(id);
    return file !== undefined && insideScope(file, scope);
  };

  // Adjacency covers the whole IR, so a thread's reach does not depend on the scope it is seen from.
  const callOut = new Map<string, Set<string>>();
  const dispatchOut = new Map<string, Dispatch[]>();
  const spawnsOf = new Map<string, Spawns>();
  const dispatchSites: Array<Dispatch & { from: string }> = [];
  // A function is referenced when a caller in the scope names it. A reference from outside the scope does not
  // count, so a function the scope's own code never calls is a root of the scope even when another folder calls it.
  const referenced = new Set<string>();

  const keyed = edges.map((e) => ({ e, k: edgeKey(e) })).sort((a, b) => byText(a.k, b.k));
  for (const { e } of keyed) {
    const t = edgeTargets(e);
    const ids = [...t.nodes, ...t.candidates];
    const from = e.from;
    const local = inScopeId(from);
    const candidates = t.candidates.length > 0;
    if (e.kind === "calls.call" || e.kind === "calls.reference") {
      const callees = callOut.get(from) ?? new Set<string>();
      for (const to of ids) if (fns.has(to)) callees.add(to);
      callOut.set(from, callees);
      if (local) for (const to of ids) if (to !== from) referenced.add(to);
    } else if (e.kind === "concurrency.dispatches") {
      const d: Dispatch = {
        how: pick(e.attrs?.how, DISPATCH_HOWS) ?? "callback",
        targets: ids.filter((id) => fns.has(id)),
        candidates,
        file: e.span?.file ?? "",
        line: e.span ? e.span.start[0] + 1 : 0,
      };
      push(dispatchOut, from, d);
      if (local) {
        dispatchSites.push({ from, ...d });
        for (const to of ids) if (to !== from) referenced.add(to);
      }
    } else if (e.kind === "concurrency.spawns") {
      const s = spawnsOf.get(from) ?? { targets: new Set<string>(), candidates: false, how: undefined };
      for (const to of ids) s.targets.add(to);
      s.candidates = s.candidates || candidates;
      s.how = s.how ?? pick(e.attrs?.how, SPAWN_HOWS);
      spawnsOf.set(from, s);
      if (local) for (const to of ids) referenced.add(to);
    }
  }

  /** The functions a thread runs from `roots`: calls, references and every dispatch. Spawns start other threads, so they are not followed. */
  const neighbours = (id: string): string[] => [...(callOut.get(id) ?? []), ...(dispatchOut.get(id) ?? []).flatMap((d) => d.targets)];
  const reachOf = (roots: readonly string[]): Set<string> => {
    const seen = new Set(roots);
    const stack = [...roots];
    while (stack.length > 0) {
      const cur = stack.pop() as string;
      for (const next of neighbours(cur)) {
        if (!seen.has(next)) {
          seen.add(next);
          stack.push(next);
        }
      }
    }
    return seen;
  };

  /**
   * The coroutines of one thread. Each target is listed once, and a target already listed is not expanded again,
   * which is what cuts a cycle of awaits. Callees stop at the next await, so each coroutine's own list stays
   * flat, and the nesting is in `parent`.
   */
  const coroutinesOf = (roots: readonly string[]): ExecCoroutine[] => {
    const out: ExecCoroutine[] = [];
    const byTarget = new Map<string, ExecCoroutine>();
    const explore = (entries: readonly string[], parent: string | undefined): Set<string> => {
      const region = new Set(entries);
      const stack = [...entries];
      while (stack.length > 0) {
        const cur = stack.pop() as string;
        for (const next of callOut.get(cur) ?? []) {
          if (!region.has(next)) {
            region.add(next);
            stack.push(next);
          }
        }
        for (const d of dispatchOut.get(cur) ?? []) {
          for (const target of d.targets) {
            if (d.how === "await" || d.how === "start") {
              const known = byTarget.get(target);
              if (known) {
                if (!known.dispatchedBy.includes(cur)) known.dispatchedBy.push(cur);
                continue;
              }
              const co: ExecCoroutine = {
                target,
                how: d.how,
                ...(parent !== undefined ? { parent } : {}),
                dispatchedBy: [cur],
                callees: [],
              };
              byTarget.set(target, co);
              out.push(co);
              co.callees = [...explore([target], target)].filter((x) => x !== target).sort(byText);
            } else if (!region.has(target)) {
              region.add(target);
              stack.push(target);
            }
          }
        }
      }
      return region;
    };
    explore(roots, undefined);
    for (const co of out) co.dispatchedBy.sort(byText);
    return out;
  };

  const mainRoots = [...fns.values()]
    .filter((f) => f.inScope && !referenced.has(f.id) && (scopeNoise || !f.noise))
    .map((f) => f.id)
    .sort(byText);
  const plans: Plan[] = [{ kind: "main", id: "main", roots: mainRoots, reach: reachOf(mainRoots), coroutines: coroutinesOf(mainRoots) }];

  // Spawn threads are not filtered by noise. A spawn in a test file is still a fact of the code, and filtering it
  // would make a scope's threads depend on whether the scope is noise, which breaks monotonicity across scopes.
  const spawnNodes = nodes
    .filter((n) => SPAWN_KINDS.has(n.kind) && inScopeId(n.id))
    .sort((a, b) => byText(a.id, b.id));
  for (const n of spawnNodes) {
    const s = spawnsOf.get(n.id);
    const targets = s ? [...s.targets].sort(byText) : [];
    // A target that is not a function is a script file. Its top-level code runs the thread, so its callees are the roots.
    const roots = new Set<string>();
    let script: string | undefined;
    for (const t of targets) {
      if (fns.has(t)) {
        roots.add(t);
        continue;
      }
      script = t;
      for (const c of callOut.get(t) ?? []) roots.add(c);
    }
    const rootList = [...roots].sort(byText);
    const status: ExecSpawnStatus =
      rootList.length === 0 ? "unresolved" : rootList.some((r) => fns.get(r)?.inScope === true) ? "resolved" : "outside";
    const how: ExecSpawnHow = s?.how ?? (n.kind === "concurrency.spawn-process" ? "process" : "thread");
    const spawn: ExecSpawn = {
      node: n.id,
      file: fileOf(n.id) ?? "",
      line: n.span ? n.span.start[0] + 1 : 0,
      how,
      status,
      candidates: s?.candidates ?? false,
      ...(n.parent !== undefined ? { owner: n.parent } : {}),
      ...(script !== undefined ? { script } : {}),
    };
    plans.push({ kind: how, id: n.id, spawn, roots: rootList, reach: reachOf(rootList), coroutines: coroutinesOf(rootList) });
  }

  // The function table. Threads are cut in order, so the first threads keep their full lists when the cap is hit.
  const table = new Map<string, ExecFunctionRef>();
  let truncated = false;
  const take = (id: string): boolean => {
    if (table.has(id)) return true;
    const fn = fns.get(id);
    if (!fn) return false;
    if (table.size >= max) {
      truncated = true;
      return false;
    }
    table.set(id, {
      id,
      name: fn.name,
      file: fn.file ?? "",
      line: fn.line,
      inScope: fn.inScope,
      ...(fn.noise ? { noise: true as const } : {}),
    });
    return true;
  };

  const threads: ExecThread[] = plans.map((p) => {
    const roots = p.roots.filter(take);
    const reached = [...p.reach].sort(byText).filter(take);
    const coroutines: ExecCoroutine[] = [];
    for (const co of p.coroutines) {
      if (!take(co.target)) continue;
      coroutines.push({ ...co, callees: co.callees.filter(take) });
    }
    return {
      id: p.id,
      kind: p.kind,
      ...(p.spawn !== undefined ? { spawn: p.spawn } : {}),
      roots,
      reach: p.reach.size,
      reached,
      coroutines,
    };
  });

  const dispatches: ExecDispatch[] = dispatchSites.map((d) => ({
    from: d.from,
    how: d.how,
    targets: d.targets.filter(take),
    candidates: d.candidates,
    file: d.file,
    line: d.line,
  }));

  const inScopeFns = [...fns.values()].filter((f) => f.inScope);
  const threaded = new Set<string>();
  for (const p of plans) for (const id of p.reach) threaded.add(id);
  const functionsThreaded = inScopeFns.filter((f) => threaded.has(f.id)).length;
  const spawned = plans.flatMap((p) => (p.spawn !== undefined ? [p.spawn] : []));
  const countStatus = (s: ExecSpawnStatus) => spawned.filter((x) => x.status === s).length;

  return {
    scope,
    truncated,
    functions: [...table.values()],
    threads,
    dispatches,
    stats: {
      threads: threads.length,
      spawns: spawned.length,
      resolved: countStatus("resolved"),
      outside: countStatus("outside"),
      unresolved: countStatus("unresolved"),
      candidates: spawned.filter((x) => x.candidates).length,
      coroutines: threads.reduce((n, t) => n + t.coroutines.length, 0),
      dispatches: dispatches.length,
      functionsInScope: inScopeFns.length,
      functionsThreaded,
      functionsUnthreaded: inScopeFns.length - functionsThreaded,
      functionsListed: table.size,
    },
  };
}
