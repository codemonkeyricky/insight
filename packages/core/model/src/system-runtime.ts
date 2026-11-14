// The runtime of one scope's System model: the processes, threads and coroutines its code runs on, the slices (one
// component on one runtime), and the in-process resources (queues, locks, semaphores, condvars, env) and kernel ops.
// Built from execModel with the Flow grounding rules, so a thread exists only where the IR grounds it. Pure: the same
// model and scope give the same plan, whatever order the IR arrives in (every list is sorted by id).
import { execCoroutineId, execModel, execProgramId, execThreadId, hasRuntimeContext, UNTHREADED_ID, UNTHREADED_LABEL, type ExecFunctionRef, type ExecModel, type ExecProgram, type ExecSpawn, type ExecSpawnStatus, type ExecThread } from "@insight/flow";
import type { NodeId } from "@insight/ir";
import type { ProjectModel } from "./model.js";
import type { Site } from "./system.js";

/** grounded: runtimes exist and edges are drawn per slice. none: no runtime context, the flat model. truncated: the exec model was cut. */
export type SystemRuntimeMode = "grounded" | "none" | "truncated";

/** The spawn that started a thread or process: where it is, the API it calls, and whether its target was found. */
export interface SystemSpawn extends Site {
  api?: string;
  status: ExecSpawnStatus;
}

export interface SystemRuntime {
  id: string;
  kind: "program" | "thread" | "coroutine" | "unthreaded";
  label: string;
  /** The program a thread runs in, or the thread a coroutine runs on. */
  parent?: string;
  /** The main thread of a program that has no other thread: not drawn, its children sit in the program frame. */
  implicit?: true;
  programKind?: "node" | "browser" | "native";
  spawn?: SystemSpawn;
  /** Started (not awaited) coroutines the thread runs. */
  coroutines?: number;
  /** The resources this runtime owns, sorted. */
  resources?: string[];
}

/** One component on one runtime: the functions of the component that the runtime runs. */
export interface SystemSlice {
  id: string; // "<runtime>|<component>"
  runtime: string;
  component: string;
  functions: number;
  /** The component holds a root of the runtime (a thread's start function, or a coroutine's target). */
  root: boolean;
  /** Awaited coroutines of this thread whose code is in the component: they run inline, so they are a count, not a frame. */
  awaits?: number;
}

export type SystemResourceKind = "queue" | "lock" | "semaphore" | "condvar" | "env" | "os";

export interface SystemResource {
  id: string;
  kind: SystemResourceKind;
  label: string;
  /** The owning program (or thread, when it has no program). Absent for kernel ops; "unthreaded" when no thread runs it. */
  program?: string;
  source: "message" | "event-loop" | "channel" | "sync" | "env" | "os";
  /** Env var names, signal names or other operation targets, sorted. */
  names?: string[];
}

/** One API or syscall a fact went through. level: syscall when the IR names the syscall; unknown when the target is dynamic. */
export interface SystemEvidence {
  api: string;
  syscall?: string;
  level: "syscall" | "api" | "unknown";
  count: number;
}

export interface RuntimePlan {
  mode: SystemRuntimeMode;
  exec: ExecModel;
  slices: Map<string, SystemSlice>;
  resources: Map<string, SystemResource>;
  /** The runtimes that run a function (or the file's module code when the function is unknown). Coroutines win over threads. */
  owners(fn: NodeId | undefined, file: string | undefined): string[];
  /** The slice id of a component on a runtime. Created with no functions when it does not exist yet. */
  sliceId(runtime: string, component: string): string;
  /** The program a runtime belongs to: a program, a thread's program (or the thread itself), a coroutine's thread's program. */
  programOf(runtime: string): string;
  /** The thread a runtime is or runs on, when it is one. */
  threadOf(runtime: string): string | undefined;
  label(runtime: string): string;
  /** The thread a spawn node starts, when the spawn is grounded. */
  threadOfSpawn(node: NodeId): string | undefined;
  /** Adds a resource unless one with its id exists; returns the stored one. */
  putResource(res: SystemResource): SystemResource;
  addName(resourceId: string, name: string): void;
  /** The runtimes and slices, sorted by id, with each runtime's resource list filled in. */
  finish(): { runtimes: SystemRuntime[]; slices: SystemSlice[] };
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function programKindOf(p: ExecProgram | undefined): SystemRuntime["programKind"] {
  if (p?.kind === "browser") return "browser";
  if (p?.kind === "node" || p?.entry !== undefined) return "node";
  return "native";
}

function threadLabel(t: ExecThread): string {
  if (t.kind === "main") return "Main thread";
  const s = t.spawn;
  if (t.kind === "process") return `Process · ${s?.command ?? s?.api ?? "child"}`;
  if (s?.script !== undefined && s.script !== "") return `Worker · ${basename(s.script)}`;
  return `Thread · ${s?.api ?? "thread"}`;
}

function spawnOf(s: ExecSpawn): SystemSpawn {
  return {
    file: s.file,
    line: s.line,
    status: s.status,
    ...(s.owner !== undefined ? { fn: s.owner } : {}),
    ...(s.api !== undefined ? { api: s.api } : {}),
  };
}

function addTo(map: Map<string, Set<string>>, key: string, value: string): void {
  let set = map.get(key);
  if (set === undefined) map.set(key, (set = new Set()));
  set.add(value);
}

/**
 * The runtime plan of one scope. `compOfFile` gives the System component of an in-scope file (undefined for a file outside
 * the scope). When the scope has no runtime context the plan is "none" and holds no runtimes.
 */
export function buildRuntimePlan(model: ProjectModel, scope: string, compOfFile: (file: string) => string | undefined): RuntimePlan {
  const exec = execModel(model.doc.nodes, model.doc.edges, scope, { maxFunctions: Infinity });
  const mode: SystemRuntimeMode = exec.truncated ? "truncated" : hasRuntimeContext(exec) ? "grounded" : "none";
  const grounded = mode === "grounded";

  const runtimes = new Map<string, SystemRuntime>();
  const slices = new Map<string, SystemSlice>();
  const resources = new Map<string, SystemResource>();
  const fnById = new Map<string, ExecFunctionRef>(exec.functions.map((f) => [f.id, f] as const));
  const threadOfSpawnMap = new Map<string, string>();
  const threadsOfFn = new Map<string, Set<string>>();
  const coroutinesOfFn = new Map<string, Set<string>>();
  const rootKeys = new Set<string>();

  const sliceId = (runtime: string, component: string): string => {
    const id = `${runtime}|${component}`;
    if (!slices.has(id)) slices.set(id, { id, runtime, component, functions: 0, root: false });
    return id;
  };

  const programOf = (rt: string): string => {
    const r = runtimes.get(rt);
    if (r === undefined) return UNTHREADED_ID;
    if (r.kind === "coroutine") return r.parent === undefined ? UNTHREADED_ID : programOf(r.parent);
    if (r.kind === "thread") return r.parent ?? r.id;
    if (r.kind === "program") return r.id;
    return UNTHREADED_ID;
  };

  const threadOf = (rt: string): string | undefined => {
    const r = runtimes.get(rt);
    if (r?.kind === "thread") return r.id;
    if (r?.kind === "coroutine") return r.parent;
    return undefined;
  };

  const ownersOf = (fn: string | undefined, file: string | undefined): string[] => {
    let id = fn !== undefined && fnById.has(fn) ? fn : undefined;
    if (id === undefined && file !== undefined && fnById.has(`${file}#(module)`)) id = `${file}#(module)`;
    if (id === undefined) return [UNTHREADED_ID];
    // A function runs on every thread that runs it on its own, and in every coroutine that runs it.
    const owners = new Set([...(coroutinesOfFn.get(id) ?? []), ...(threadsOfFn.get(id) ?? [])]);
    if (owners.size === 0) return [UNTHREADED_ID];
    return [...owners].sort(cmp);
  };

  if (grounded) {
    const threads = exec.threads.filter((t) => t.grounded);
    const threadIds = new Set(threads.map((t) => t.id));
    const programOfThread = new Map<string, string>();
    for (const p of exec.programs) {
      for (const tid of p.threads) if (threadIds.has(tid) && !programOfThread.has(tid)) programOfThread.set(tid, execProgramId(p.id));
    }
    const progById = new Map(exec.programs.map((p) => [execProgramId(p.id), p] as const));
    for (const prt of new Set(programOfThread.values())) {
      const p = progById.get(prt);
      runtimes.set(prt, { id: prt, kind: "program", label: p?.name ?? prt, ...(programKindOf(p) !== undefined ? { programKind: programKindOf(p) } : {}) });
    }
    const groupSize = new Map<string, number>();
    for (const t of threads) {
      const key = programOfThread.get(t.id) ?? "";
      groupSize.set(key, (groupSize.get(key) ?? 0) + 1);
    }
    for (const t of threads) {
      const rt = execThreadId(t.id);
      const parent = programOfThread.get(t.id);
      const started = t.coroutines.filter((c) => c.how === "start");
      const implicit = t.kind === "main" && groupSize.get(parent ?? "") === 1;
      runtimes.set(rt, {
        id: rt,
        kind: "thread",
        label: threadLabel(t),
        ...(parent !== undefined ? { parent } : {}),
        ...(implicit ? { implicit: true as const } : {}),
        ...(t.spawn !== undefined ? { spawn: spawnOf(t.spawn) } : {}),
        ...(started.length > 0 ? { coroutines: started.length } : {}),
      });
      if (t.spawn !== undefined) threadOfSpawnMap.set(t.spawn.node, rt);
      // Functions a coroutine alone runs are owned by the coroutine, not by the thread that awaits it.
      const coOnly = new Set(t.coroutineOnly);
      for (const fn of t.reached) if (!coOnly.has(fn) && fnById.get(fn)?.inScope) addTo(threadsOfFn, fn, rt);
      for (const r of t.roots) rootKeys.add(`${rt}\0${r}`);
      for (const c of started) {
        const crt = execCoroutineId(t.id, c.target);
        runtimes.set(crt, { id: crt, kind: "coroutine", label: fnById.get(c.target)?.name ?? c.target, parent: rt });
        rootKeys.add(`${crt}\0${c.target}`);
        for (const fn of [c.target, ...c.callees]) if (fnById.get(fn)?.inScope) addTo(coroutinesOfFn, fn, crt);
      }
    }

    for (const f of exec.functions) {
      if (!f.inScope) continue;
      const comp = compOfFile(f.file);
      if (comp === undefined) continue;
      for (const rt of ownersOf(f.id, f.file)) {
        const s = slices.get(sliceId(rt, comp)) as SystemSlice;
        s.functions++;
        if (rootKeys.has(`${rt}\0${f.id}`)) s.root = true;
      }
    }
    for (const t of threads) {
      const rt = execThreadId(t.id);
      for (const c of t.coroutines) {
        if (c.how !== "await") continue;
        const f = fnById.get(c.target);
        const comp = f?.inScope === true ? compOfFile(f.file) : undefined;
        const s = comp === undefined ? undefined : slices.get(`${rt}|${comp}`);
        if (s !== undefined) s.awaits = (s.awaits ?? 0) + 1;
      }
    }
  }

  const putResource = (res: SystemResource): SystemResource => {
    const have = resources.get(res.id);
    if (have !== undefined) return have;
    resources.set(res.id, res);
    return res;
  };

  const addName = (id: string, name: string): void => {
    const res = resources.get(id);
    if (res === undefined || name === "") return;
    res.names = [...new Set([...(res.names ?? []), name])].sort(cmp);
  };

  const finish = (): { runtimes: SystemRuntime[]; slices: SystemSlice[] } => {
    const usesUnthreaded = [...slices.values()].some((s) => s.runtime === UNTHREADED_ID) || [...resources.values()].some((r) => r.program === UNTHREADED_ID);
    if (usesUnthreaded && !runtimes.has(UNTHREADED_ID)) runtimes.set(UNTHREADED_ID, { id: UNTHREADED_ID, kind: "unthreaded", label: UNTHREADED_LABEL });
    const owned = new Map<string, string[]>();
    for (const r of resources.values()) {
      if (r.program === undefined || !runtimes.has(r.program)) continue;
      owned.set(r.program, [...(owned.get(r.program) ?? []), r.id]);
    }
    for (const rt of runtimes.values()) {
      const ids = owned.get(rt.id);
      if (ids !== undefined) rt.resources = [...ids].sort(cmp);
    }
    return {
      runtimes: [...runtimes.values()].sort((a, b) => cmp(a.id, b.id)),
      slices: [...slices.values()].sort((a, b) => cmp(a.id, b.id)),
    };
  };

  // The spawn nodes of the grounded threads: a spawn starts the thread it names.
  const label = (rt: string): string => runtimes.get(rt)?.label ?? rt;

  return {
    mode,
    exec,
    slices,
    resources,
    owners: ownersOf,
    sliceId,
    programOf,
    threadOf,
    label,
    threadOfSpawn: (node) => threadOfSpawnMap.get(node),
    putResource,
    addName,
    finish,
  };
}
