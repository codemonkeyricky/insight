// The runtime of one scope's System model: the programs, threads and coroutines its code runs on, the slices (one
// component on one runtime), and the in-process resources (queues, locks, semaphores, condvars, env) and kernel ops.
// Built from execModel with the Flow grounding rules, so a thread exists only where the IR grounds it. Pure: the same
// model and scope give the same plan, whatever order the IR arrives in (every list is sorted by id).
import { execCoroutineId, execModel, execProgramId, execThreadId, hasRuntimeContext, UNTHREADED_ID, UNTHREADED_LABEL, type ExecFunctionRef, type ExecModel, type ExecProgram, type ExecSpawn, type ExecSpawnStatus, type ExecThread } from "@insight/flow";
import type { NodeId } from "@insight/ir";
import type { ProjectModel } from "./model.js";
import type { Site } from "./system.js";

/** grounded: runtimes exist and edges are drawn per slice. none: no runtime context, the flat model. truncated: the exec model was cut. */
export type SystemRuntimeMode = "grounded" | "none" | "truncated";

/** The spawn that started a thread or program: where it is, the API it calls, and whether its target was found. */
export interface SystemSpawn extends Site {
  api?: string;
  status: ExecSpawnStatus;
}

export interface SystemRuntime {
  id: string;
  kind: "program" | "thread" | "coroutine" | "unthreaded";
  label: string;
  /** The program a thread runs in, or the thread a coroutine runs on. Absent for a program (and for the unthreaded runtime). */
  parent?: string;
  /** The main thread of a program that has no other thread: not drawn, its children sit in the program frame. */
  implicit?: true;
  programKind?: "node" | "browser" | "native";
  /** A program started by a spawn or a command: where it was started. A thread's spawn is the one that started it. */
  spawn?: SystemSpawn;
  /** Started (not awaited) coroutines the thread runs. */
  coroutines?: number;
  /** The resources this runtime owns, sorted. */
  resources?: string[];
  /** In-scope root function ids of the thread, or the coroutine's target: sorted, capped at SITE_CAP. Absent when none is in scope. */
  roots?: string[];
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
  /** sync.atomic-op facts in the component's functions this slice runs. Each fact is counted once per slice. Absent when none. */
  atomics?: number;
}

export type SystemResourceKind = "queue" | "lock" | "semaphore" | "condvar" | "env" | "os";

export interface SystemResource {
  id: string;
  kind: SystemResourceKind;
  label: string;
  /**
   * The program of the runtimes that use the resource. Absent when none of them has a program (a flat scope, or code no
   * program runs). One resource per program: the same name used by two programs gives two resources.
   */
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
  /** The program a runtime belongs to, or undefined when it has none (a thread with no program, the unthreaded runtime). */
  programOf(runtime: string): string | undefined;
  /** The thread a runtime is or runs on, when it is one. */
  threadOf(runtime: string): string | undefined;
  label(runtime: string): string;
  /** The thread a thread spawn node starts, when the spawn is grounded. */
  threadOfSpawn(node: NodeId): string | undefined;
  /** The program runtime a process spawn starts, when its target is a project program. */
  programOfSpawn(node: NodeId): string | undefined;
  /** The program runtime a command runs, when exactly one project program has that name. Records the spawn that ran it. */
  programOfCommand(command: string, spawn: SystemSpawn): string | undefined;
  /** Adds a resource unless one with its id exists; returns the stored one. */
  putResource(res: SystemResource): SystemResource;
  addName(resourceId: string, name: string): void;
  /** The runtimes and slices, sorted by id, with each runtime's resource list filled in. */
  finish(): { runtimes: SystemRuntime[]; slices: SystemSlice[] };
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
/** The most ids a runtime or site list carries: the same cap as the Site lists in system.ts. */
const SITE_CAP = 20;

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function programKindOf(p: ExecProgram): NonNullable<SystemRuntime["programKind"]> {
  if (p.kind === "browser") return "browser";
  if (p.kind === "node" || p.entry !== undefined) return "node";
  return "native";
}

function threadLabel(t: ExecThread): string {
  if (t.kind === "main") return "Main thread";
  const s = t.spawn;
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

/** A total order on spawns, so the spawn that names a program does not depend on the order the IR arrives in. */
function spawnKey(s: SystemSpawn): string {
  return `${s.file}\0${String(s.line).padStart(8, "0")}\0${s.fn ?? ""}\0${s.api ?? ""}`;
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
  // The in-scope functions among ids, sorted and capped (the same cap as the Site lists).
  const inScopeRoots = (ids: readonly string[]): string[] => [...new Set(ids)].filter((id) => fnById.get(id)?.inScope === true).sort(cmp).slice(0, SITE_CAP);
  // The function a node sits in: the node itself when it is a function, else the nearest enclosing one.
  const fnOwnerOf = (id: string): string | undefined => {
    let cur: string | undefined = id;
    for (let guard = 0; cur !== undefined && guard < 100; guard++) {
      if (model.functionById.has(cur)) return cur;
      cur = model.byId.get(cur)?.parent;
    }
    return undefined;
  };
  const threadOfSpawnMap = new Map<string, string>();
  const programOfSpawnMap = new Map<string, string>();
  const threadsOfFn = new Map<string, Set<string>>();
  const coroutinesOfFn = new Map<string, Set<string>>();
  const rootKeys = new Set<string>();
  const spawnOfProgram = new Map<string, SystemSpawn>();

  const sliceId = (runtime: string, component: string): string => {
    const id = `${runtime}|${component}`;
    if (!slices.has(id)) slices.set(id, { id, runtime, component, functions: 0, root: false });
    return id;
  };

  const programOf = (rt: string): string | undefined => {
    const r = runtimes.get(rt);
    if (r === undefined) return undefined;
    if (r.kind === "coroutine") return r.parent === undefined ? undefined : programOf(r.parent);
    if (r.kind === "thread") return r.parent;
    if (r.kind === "program") return r.id;
    return undefined;
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

  /** The program runtime of an exec program. A spawn that starts it is kept when it sorts first, so the choice is stable. */
  const ensureProgram = (p: ExecProgram, spawn?: SystemSpawn): string => {
    const id = execProgramId(p.id);
    let r = runtimes.get(id);
    if (r === undefined) {
      r = { id, kind: "program", label: p.name, programKind: programKindOf(p) };
      runtimes.set(id, r);
    }
    if (spawn !== undefined) {
      const have = spawnOfProgram.get(id);
      if (have === undefined || spawnKey(spawn) < spawnKey(have)) {
        spawnOfProgram.set(id, spawn);
        r.spawn = spawn;
      }
    }
    return id;
  };

  const programOfCommand = (command: string, spawn: SystemSpawn): string | undefined => {
    if (!grounded) return undefined;
    const matches = exec.programs.filter((p) => p.name === command && p.targetKind !== "html-entry");
    if (matches.length !== 1) return undefined;
    return ensureProgram(matches[0] as ExecProgram, spawn);
  };

  if (grounded) {
    // The threads that run code: every grounded thread but a process. A process is a program: one an exec program names
    // is that program (its own main thread runs the code); a resolved one no exec program names gets its own program and
    // an implicit main thread. An unresolved process is no runtime: the spawn stays an external process box.
    interface ThreadSpec {
      rt: string;
      t: ExecThread;
      parent?: string;
      label: string;
      implicit: boolean;
      spawn?: SystemSpawn;
    }
    const specs: ThreadSpec[] = [];
    const threadIds = new Set(exec.threads.filter((t) => t.grounded && t.kind !== "process").map((t) => t.id));
    const programOfThread = new Map<string, string>();
    for (const p of exec.programs) {
      for (const tid of p.threads) {
        if (!threadIds.has(tid) || programOfThread.has(tid)) continue;
        programOfThread.set(tid, ensureProgram(p));
      }
    }
    const programNaming = (roots: readonly string[]): ExecProgram | undefined =>
      exec.programs.find((prog) => (prog.main !== undefined && roots.includes(prog.main)) || (prog.entries ?? []).some((e) => roots.includes(e)));
    for (const t of exec.threads) {
      if (!t.grounded || t.kind !== "process" || t.spawn === undefined) continue;
      const spawn = spawnOf(t.spawn);
      const named = programNaming(t.roots);
      if (named !== undefined) {
        programOfSpawnMap.set(t.spawn.node, ensureProgram(named, spawn));
        continue;
      }
      if (t.spawn.status !== "resolved") continue;
      const rootFile = fnById.get(t.roots[0] ?? "")?.file ?? t.roots[0] ?? "";
      const pid = `program:${t.spawn.node}`;
      runtimes.set(pid, { id: pid, kind: "program", label: rootFile, programKind: "node", spawn });
      spawnOfProgram.set(pid, spawn);
      programOfSpawnMap.set(t.spawn.node, pid);
      specs.push({ rt: execThreadId(t.id), t, parent: pid, label: "Main thread", implicit: true });
    }
    const groupSize = new Map<string, number>();
    for (const t of exec.threads) {
      if (!threadIds.has(t.id)) continue;
      const key = programOfThread.get(t.id) ?? "";
      groupSize.set(key, (groupSize.get(key) ?? 0) + 1);
    }
    for (const t of exec.threads) {
      if (!threadIds.has(t.id)) continue;
      const parent = programOfThread.get(t.id);
      const spawn = t.spawn !== undefined ? spawnOf(t.spawn) : undefined;
      specs.push({
        rt: execThreadId(t.id),
        t,
        ...(parent !== undefined ? { parent } : {}),
        label: threadLabel(t),
        implicit: t.kind === "main" && groupSize.get(parent ?? "") === 1,
        ...(spawn !== undefined ? { spawn } : {}),
      });
    }
    for (const sp of specs) {
      const { rt, t } = sp;
      const started = t.coroutines.filter((c) => c.how === "start");
      const roots = inScopeRoots(t.roots);
      runtimes.set(rt, {
        id: rt,
        kind: "thread",
        label: sp.label,
        ...(sp.parent !== undefined ? { parent: sp.parent } : {}),
        ...(sp.implicit ? { implicit: true as const } : {}),
        ...(sp.spawn !== undefined ? { spawn: sp.spawn } : {}),
        ...(started.length > 0 ? { coroutines: started.length } : {}),
        ...(roots.length > 0 ? { roots } : {}),
      });
      if (t.spawn !== undefined && t.kind !== "process") threadOfSpawnMap.set(t.spawn.node, rt);
      // Functions a coroutine alone runs are owned by the coroutine, not by the thread that awaits it.
      const coOnly = new Set(t.coroutineOnly);
      for (const fn of t.reached) if (!coOnly.has(fn) && fnById.get(fn)?.inScope) addTo(threadsOfFn, fn, rt);
      for (const r of t.roots) rootKeys.add(`${rt}\0${r}`);
      for (const c of started) {
        const crt = execCoroutineId(t.id, c.target);
        const croots = inScopeRoots([c.target]);
        runtimes.set(crt, { id: crt, kind: "coroutine", label: fnById.get(c.target)?.name ?? c.target, parent: rt, ...(croots.length > 0 ? { roots: croots } : {}) });
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
    // sync.atomic-op facts: each counted once per slice of its component on every runtime that runs its function.
    const atomicsOf = new Map<string, Set<string>>();
    for (const node of model.doc.nodes) {
      if (node.kind !== "sync.atomic-op") continue;
      const f = fnOwnerOf(node.id);
      const fn = f === undefined ? undefined : fnById.get(f);
      if (fn === undefined || !fn.inScope) continue;
      const comp = compOfFile(fn.file);
      if (comp === undefined) continue;
      for (const rt of ownersOf(fn.id, fn.file)) addTo(atomicsOf, sliceId(rt, comp), node.id);
    }
    for (const [sid, ids] of atomicsOf) {
      const s = slices.get(sid);
      if (s !== undefined) s.atomics = ids.size;
    }
    for (const sp of specs) {
      for (const c of sp.t.coroutines) {
        if (c.how !== "await") continue;
        const f = fnById.get(c.target);
        const comp = f?.inScope === true ? compOfFile(f.file) : undefined;
        const s = comp === undefined ? undefined : slices.get(`${sp.rt}|${comp}`);
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
    const usesUnthreaded = [...slices.values()].some((s) => s.runtime === UNTHREADED_ID);
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
    programOfSpawn: (node) => programOfSpawnMap.get(node),
    programOfCommand,
    putResource,
    addName,
    finish,
  };
}
