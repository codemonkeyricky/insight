// The execution canvas's scene, built from one scope's ExecModel: project ▸ process ▸ thread ▸ coroutine ▸ function.
// A process box is drawn for a program or a process spawn, and a thread box only where the IR has evidence for the
// thread (ExecThread.grounded). Where no runtime is known, the functions sit directly on the project as plain code
// flow, with their call edges and no wrapper box. See scene.ts for the model.
//
// A function is drawn once per place it runs: a helper two threads call has a box in each thread, and the call edges
// of one thread stay inside that thread. Pure and deterministic: the scene depends only on the model's content, not
// on the order of its call pairs.
import type { ExecCoroutine, ExecFunctionRef, ExecModel, ExecProgram, ExecResourceSite, ExecThread } from "./exec-model.js";
import type { Scene, SceneEdge, SceneEdgeKind, SceneLevel, SceneNode } from "./scene.js";
import { LAYERED, ZOOM_SIZE } from "./zoom-layout.js";

/** The root node's id. The project holds the processes, or the plain code flow when no thread is grounded. */
export const EXEC_PROJECT_ROOT = "project";
/** Most sync edges one lock or channel adds. The rest are skipped, in the order the pairs are made. */
export const MAX_SYNC_EDGES_PER_RESOURCE = 50;
/** The synthetic process that holds the grounded main threads no program owns. */
export const MAIN_PROCESS_ID = "prog:main";

/** The note on each function drawn as plain code flow, with no runtime box around it. */
export const NO_RUNTIME_NOTE = "Plain call with no runtime context. Zoom out to see where it runs.";
/** The root's note when no thread is grounded in the scope. */
const NO_RUNTIME_ROOT_NOTE = "Code flow, no runtime context found in this scope.";

/** Every node kind of the execution scene, with its level. */
export const EXEC_LEVELS: Record<string, SceneLevel> = {
  project: { box: { w: 300, h: 64 }, layout: LAYERED },
  program: { box: { w: 300, h: 64 }, layout: LAYERED },
  thread: { box: { w: 260, h: 60 }, layout: LAYERED },
  coroutine: { box: { w: 240, h: 52 }, layout: LAYERED },
  function: { box: { w: ZOOM_SIZE.fn.w, h: ZOOM_SIZE.fn.h } },
};

/**
 * Whether a thread has a box in the scene: the IR grounds it. A model saved before the grounded field existed grounds a
 * main thread only when a root is named `main`, and every other thread.
 */
export function isGroundedThread(t: ExecThread, nameOf: (fnId: string) => string | undefined): boolean {
  const flag = (t as { grounded?: boolean }).grounded;
  return flag ?? (t.kind !== "main" || t.roots.some((r) => nameOf(r) === "main"));
}

export function execThreadId(threadId: string): string {
  return `thread:${threadId}`;
}

/** The scene id of a program, by its build target's id. */
export function execProgramId(programId: string): string {
  return `prog:${programId}`;
}

/** The scene id of the process a process spawn starts: its own box, which holds that thread. */
export function execProcessId(threadId: string): string {
  return `proc:${threadId}`;
}

export function execCoroutineId(threadId: string, target: string): string {
  return `co:${threadId}:${target}`;
}

/**
 * A function's placement in a container: the container's scene id, a literal `>`, then the function id. The container
 * is the thread or coroutine, or the project for plain code flow.
 */
export function execFnId(container: string, fn: string): string {
  return `${container}>${fn}`;
}

/** Code-unit order, the same in every locale. */
function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

const KIND_LABEL: Record<string, string> = { thread: "Thread", process: "Process", async: "Async" };

/** The placements of one function in one thread (or the project, for plain code flow). */
interface Placed {
  /** Placement ids, sorted by id once building is done. */
  ids: string[];
  /**
   * Placement id by the thread or coroutine that holds it (not the project). A function is placed at most once per
   * container.
   */
  byParent: Map<string, string>;
}

export function buildExecScene(model: ExecModel): Scene {
  const fns = new Map<string, ExecFunctionRef>();
  for (const f of model.functions) fns.set(f.id, f);
  const nameOf = (id: string): string => fns.get(id)?.name ?? id;

  const nodes = new Map<string, SceneNode>();
  // fnId -> thread key (thread scene id, or the project for plain code flow) -> placements.
  const placements = new Map<string, Map<string, Placed>>();

  const addNode = (node: SceneNode): void => {
    nodes.set(node.id, node);
    if (node.parent !== undefined) nodes.get(node.parent)?.children.push(node.id);
  };

  /** The container each placement sits in: a thread, a coroutine, or the project. */
  const containerOf = new Map<string, string>();

  /** Places functions in a container, in the order given. Unlisted and already placed ones are skipped. */
  const placeAll = (threadKey: string, container: string, fnIds: readonly string[], note?: string): void => {
    for (const fnId of fnIds) {
      const f = fns.get(fnId);
      if (f === undefined || nodes.has(execFnId(container, fnId))) continue;
      placeOne(threadKey, container, f, note);
    }
  };

  const placeOne = (threadKey: string, container: string, f: ExecFunctionRef, note?: string): void => {
    const id = execFnId(container, f.id);
    const node: SceneNode = { id, kind: "function", label: f.name, parent: container, children: [], ref: f.id };
    if (f.chart !== undefined) {
      node.chart = { w: f.chart[0], h: f.chart[1] };
      node.compact = { w: Math.max(90, 8 * f.name.length + 24), h: 36 };
    }
    if (f.file !== "") node.detail = `${f.file}:${f.line}`;
    const n = note ?? (f.anonymous ? anonymousNote(f) : undefined);
    if (n !== undefined) node.note = n;
    addNode(node);
    containerOf.set(id, container);
    let byThread = placements.get(f.id);
    if (byThread === undefined) placements.set(f.id, (byThread = new Map()));
    let p = byThread.get(threadKey);
    if (p === undefined) byThread.set(threadKey, (p = { ids: [], byParent: new Map() }));
    p.ids.push(id);
    p.byParent.set(container, id);
  };

  const anonymousNote = (f: ExecFunctionRef): string =>
    f.parent === undefined ? "An anonymous function." : `An anonymous function written in ${nameOf(f.parent)}.`;

  // The root is the project. Its children are the process boxes, the grounded threads outside any process, and the
  // functions of plain code flow.
  const rootId = EXEC_PROJECT_ROOT;
  const unthreaded = model.unthreaded.filter((id) => fns.has(id));
  const programs = model.programs ?? [];
  const root: SceneNode = {
    id: rootId,
    kind: "project",
    label: model.scope === "" ? "Project" : model.scope,
    children: [],
    detail: "Code flow",
  };
  addNode(root);

  const isGrounded = (t: ExecThread): boolean => isGroundedThread(t, (id) => fns.get(id)?.name);
  const grounded = model.threads.filter(isGrounded);
  // The grounded threads that reach each function, in thread order: a spawn's spawner is the first one of them.
  const reachers = new Map<string, ExecThread[]>();
  for (const s of grounded) {
    for (const id of s.reached) {
      const list = reachers.get(id);
      if (list) list.push(s);
      else reachers.set(id, [s]);
    }
  }
  const spawnerOf = (t: ExecThread): ExecThread | undefined => {
    const owner = t.spawn?.owner;
    if (owner === undefined) return undefined;
    return reachers.get(owner)?.find((s) => s !== t);
  };

  // A thread sits under the first program (by id) that lists it. The others only count it in their notes.
  const programOfThread = new Map<string, ExecProgram>();
  const listedBy = new Map<string, number>();
  for (const p of programs) {
    for (const t of p.threads) {
      if (!programOfThread.has(t)) programOfThread.set(t, p);
      listedBy.set(t, (listedBy.get(t) ?? 0) + 1);
    }
  }

  let processCount = 0;
  const addProcess = (id: string, label: string, detail: string, note?: string): string => {
    if (!nodes.has(id)) {
      const node: SceneNode = { id, kind: "program", label, parent: rootId, children: [], detail };
      if (note !== undefined) node.note = note;
      addNode(node);
      processCount += 1;
    }
    return id;
  };
  const programBox = (p: ExecProgram): string => {
    const main = p.main !== undefined ? nameOf(p.main) : undefined;
    const shared = p.threads.filter((t) => (listedBy.get(t) ?? 0) > 1).length;
    const parts = [`Built from ${plural(p.files.length, "file")}.`, main !== undefined ? `Main function: ${main}.` : "No main function in the IR."];
    if (shared > 0) parts.push(`Shares ${plural(shared, "thread")} with other programs.`);
    return addProcess(execProgramId(p.id), p.name, p.targetKind, parts.join(" "));
  };

  const threadName = (t: ExecThread): string => {
    const first = t.roots[0];
    if (first !== undefined && fns.has(first)) return nameOf(first);
    return t.spawn?.script !== undefined && t.spawn.script !== "" ? basename(t.spawn.script) : "unresolved";
  };

  // The process box a grounded thread's box sits in, made when first asked. Undefined when the box sits on the project.
  // A spawned thread sits in its spawner's process, so this recurses up the spawns; the memo ends a cycle of them.
  const processes = new Map<string, string | undefined>();
  const processOf = (t: ExecThread): string | undefined => {
    if (processes.has(t.id)) return processes.get(t.id);
    processes.set(t.id, undefined);
    let box: string | undefined;
    if (t.kind === "process") {
      box = addProcess(execProcessId(t.id), `Process · ${threadName(t)}`, plural(1, "thread"));
    } else if (t.kind === "main") {
      const p = programOfThread.get(t.id);
      box = p !== undefined ? programBox(p) : addProcess(MAIN_PROCESS_ID, "Process · main", plural(1, "thread"));
    } else {
      const s = spawnerOf(t);
      box = s !== undefined && isGrounded(s) ? processOf(s) : undefined;
      // A thread no spawner covers sits under the first program that lists it, if any.
      const p = programOfThread.get(t.id);
      if (box === undefined && p !== undefined) box = programBox(p);
    }
    processes.set(t.id, box);
    return box;
  };

  // The coroutine node each (thread, coroutine) got, for the dispatch edges.
  const coNodes: { key: string; co: ExecCoroutine; id: string; container: string }[] = [];

  /**
   * Places a thread's own functions and its coroutines. `key` is the placement key (the thread's scene id, or the
   * project for plain code flow) and `box` the container the functions sit in: the thread's node, or the project.
   */
  const placeBody = (t: ExecThread, key: string, box: string): void => {
    // Which coroutines are top-level, and which functions the coroutines hold.
    const coByTarget = new Map<string, ExecCoroutine>();
    for (const co of t.coroutines) if (!coByTarget.has(co.target)) coByTarget.set(co.target, co);
    const inCoroutine = new Set<string>();
    for (const co of t.coroutines) {
      if (fns.has(co.target)) inCoroutine.add(co.target);
      for (const c of co.callees) if (fns.has(c)) inCoroutine.add(c);
    }

    const coOnly = new Set(t.coroutineOnly);
    const own = new Set<string>();
    for (const id of t.reached) if (fns.has(id) && !coOnly.has(id)) own.add(id);
    // Defensive: a coroutine-only function no coroutine holds still runs on this thread.
    for (const id of t.coroutineOnly) if (fns.has(id) && !inCoroutine.has(id)) own.add(id);
    const ordered: string[] = [];
    for (const r of t.roots) {
      if (own.has(r) && !ordered.includes(r)) ordered.push(r);
    }
    const rootSet = new Set(ordered);
    for (const id of [...own].sort(cmp)) if (!rootSet.has(id)) ordered.push(id);
    placeAll(key, box, ordered);

    // Coroutines: top-level ones in model order, each with its nested ones under it.
    const done = new Set<ExecCoroutine>();
    const addCoroutine = (co: ExecCoroutine, container: string): void => {
      if (done.has(co)) return;
      done.add(co);
      const id = execCoroutineId(t.id, co.target);
      if (nodes.has(id)) return;
      const node: SceneNode = {
        id,
        kind: "coroutine",
        label: nameOf(co.target),
        parent: container,
        children: [],
        detail: co.how === "await" ? "awaited" : "started",
      };
      if (co.dispatchedBy.length > 0) node.note = `Dispatched by ${co.dispatchedBy.map(nameOf).join(", ")}.`;
      addNode(node);
      coNodes.push({ key, co, id, container });
      placeAll(key, id, [co.target, ...[...co.callees].sort(cmp)]);
      for (const child of t.coroutines) if (child.parent === co.target && child !== co) addCoroutine(child, id);
    };
    for (const co of t.coroutines) {
      if (co.parent === undefined || !coByTarget.has(co.parent)) addCoroutine(co, box);
    }
    // Defensive: a coroutine whose parents form a cycle has no top-level ancestor; draw it on the box.
    for (const co of t.coroutines) addCoroutine(co, box);
  };

  for (const t of model.threads) {
    // A main thread inferred only from unreferenced entry functions has no box: its code is plain code flow.
    if (!isGrounded(t)) {
      placeBody(t, rootId, rootId);
      continue;
    }
    const key = execThreadId(t.id);
    addNode(threadNode(t, key, processOf(t) ?? rootId));
    placeBody(t, key, key);
  }

  // Functions no thread runs: plain code flow, directly on the project.
  placeAll(rootId, rootId, unthreaded, NO_RUNTIME_NOTE);

  for (const byThread of placements.values()) for (const p of byThread.values()) p.ids.sort(cmp);

  // Edges.
  const edges = new Map<string, SceneEdge>();
  const addEdge = (from: string, to: string, kind: SceneEdgeKind, how?: string, candidate?: boolean): void => {
    if (from === to) return;
    // A lock and a channel that join the same two placements stay two edges: the same pair with another `how` is a new key.
    const k = `${from}\u0000${to}\u0000${kind}\u0000${kind === "sync" ? (how ?? "") : ""}`;
    const e = edges.get(k);
    if (e !== undefined) {
      e.count += 1;
      if (candidate) e.candidate = true;
      return;
    }
    const edge: SceneEdge = { from, to, kind, count: 1 };
    if (how !== undefined) edge.how = how;
    if (candidate) edge.candidate = true;
    edges.set(k, edge);
  };

  /** One placement of `p`'s function: the one in `container`, else the one at thread level, else the first by id. */
  const pick = (p: Placed, container: string, threadKey: string): string | undefined =>
    p.byParent.get(container) ?? p.byParent.get(threadKey) ?? p.ids[0];

  const parentOf = (placementId: string): string => containerOf.get(placementId) ?? "";

  /** Links every placement of `a` to one placement of `b` in the same thread (or in plain code flow). */
  const linkPlacements = (a: string, b: string, kind: SceneEdgeKind, how?: string, candidate?: boolean): void => {
    const from = placements.get(a);
    const to = placements.get(b);
    if (from === undefined || to === undefined) return;
    for (const [threadKey, pa] of from) {
      const pb = to.get(threadKey);
      if (pb === undefined) continue;
      for (const u of pa.ids) {
        const v = pick(pb, parentOf(u), threadKey);
        if (v !== undefined) addEdge(u, v, kind, how, candidate);
      }
    }
  };

  for (const [i, j] of model.calls) {
    const a = model.functions[i];
    const b = model.functions[j];
    if (a === undefined || b === undefined || a.id === b.id) continue;
    linkPlacements(a.id, b.id, "call");
  }

  for (const { key, co, id, container } of coNodes) {
    for (const d of co.dispatchedBy) {
      const p = placements.get(d)?.get(key);
      if (p === undefined) continue;
      const u = pick(p, container, key);
      if (u !== undefined) addEdge(u, id, "dispatch", co.how);
    }
  }

  for (const d of model.dispatches) {
    if (d.how !== "callback" && d.how !== "timer" && d.how !== "microtask") continue;
    for (const target of d.targets) {
      if (target === d.from) continue;
      linkPlacements(d.from, target, "dispatch", d.how, d.candidates);
    }
  }

  for (const t of model.threads) {
    const owner = t.spawn?.owner;
    if (t.spawn === undefined || owner === undefined) continue;
    const byThread = placements.get(owner);
    if (byThread === undefined) continue;
    let from: string | undefined;
    for (const other of model.threads) {
      const k = execThreadId(other.id);
      const p = byThread.get(k);
      if (p !== undefined) {
        from = pick(p, k, k);
        break;
      }
    }
    if (from === undefined) {
      const p = byThread.get(rootId);
      if (p !== undefined) from = pick(p, rootId, rootId);
    }
    if (from !== undefined) addEdge(from, execThreadId(t.id), "spawn", t.spawn.how, t.spawn.candidates);
  }

  // Sync edges, one per resource and thread pair. The site is the first one of the right op that a thread runs; a
  // placement is the thread's own when the function has one there, else its first.
  const threadKeys = model.threads.map((t) => execThreadId(t.id));
  const firstSite = (sites: readonly ExecResourceSite[], ops: readonly string[], threadKey: string): string | undefined => {
    for (const s of sites) {
      if (!ops.includes(s.op)) continue;
      const p = placements.get(s.fn)?.get(threadKey);
      if (p !== undefined) return pick(p, threadKey, threadKey);
    }
    return undefined;
  };
  for (const r of model.resources ?? []) {
    const pairs: [string, string][] = [];
    if (r.kind === "lock") {
      const at = threadKeys.map((k) => firstSite(r.sites, ["acquire"], k));
      for (let i = 0; i < at.length; i++) {
        const a = at[i];
        if (a === undefined) continue;
        for (let j = i + 1; j < at.length; j++) {
          const b = at[j];
          if (b !== undefined) pairs.push([a, b]);
        }
      }
    } else {
      // Each thread that sends to a channel reaches each other thread that receives from it.
      const sendAt = threadKeys.map((k) => firstSite(r.sites, ["send"], k));
      const recvAt = threadKeys.map((k) => firstSite(r.sites, ["recv"], k));
      for (let i = 0; i < sendAt.length; i++) {
        const a = sendAt[i];
        if (a === undefined) continue;
        for (let j = 0; j < recvAt.length; j++) {
          const b = recvAt[j];
          if (b !== undefined && i !== j) pairs.push([a, b]);
        }
      }
    }
    for (const [a, b] of pairs.slice(0, MAX_SYNC_EDGES_PER_RESOURCE)) addEdge(a, b, "sync", r.kind);
  }

  const edgeList = [...edges.values()].sort(
    (x, y) => cmp(x.from, y.from) || cmp(x.to, y.to) || cmp(x.kind, y.kind) || cmp(x.how ?? "", y.how ?? ""),
  );

  root.detail = processCount === 0 ? "Code flow" : processCount === 1 ? "1 process" : `${processCount} processes`;
  const rootNotes: string[] = [];
  if (model.truncated) {
    rootNotes.push(
      `The model lists only ${plural(model.functions.length, "function")}: the function cap cut it, so later ` +
        "threads and functions are missing or incomplete.",
    );
  }
  if (grounded.length === 0) rootNotes.push(NO_RUNTIME_ROOT_NOTE);
  if (rootNotes.length > 0) root.note = rootNotes.join(" ");

  return { root: rootId, nodes, edges: edgeList, levels: EXEC_LEVELS };

  function threadNode(t: ExecThread, id: string, parent: string): SceneNode {
    const label = t.kind === "main" || t.kind === "process" ? "Main thread" : `${KIND_LABEL[t.kind] ?? t.kind} · ${threadName(t)}`;
    const node: SceneNode = {
      id,
      kind: "thread",
      label,
      parent,
      children: [],
      detail: plural(t.reach, "function"),
    };
    const s = t.spawn;
    if (s !== undefined) {
      const parts: string[] = [];
      if (s.file !== "") parts.push(`Spawned at ${s.file}:${s.line}.`);
      if (s.status === "outside") parts.push("Its code is outside this scope.");
      else if (s.status === "unresolved") parts.push("The spawn target could not be resolved.");
      if (s.candidates) parts.push("This is one of several possible targets of the spawn.");
      if (s.owner !== undefined && !fns.has(s.owner)) parts.push(`Started by module-level code in ${s.owner}.`);
      if (parts.length > 0) node.note = parts.join(" ");
    }
    return node;
  }
}

/**
 * The containers open in an execution scene's first view: the project, and every program and thread box, so the view
 * shows process ▸ thread ▸ function boxes. Coroutines stay closed, and so does everything under them. The demo capture
 * lays out this set, and the web store's base layout is this set too (see layoutScene's `open`).
 */
export function execDefaultOpen(scene: Scene): Set<string> {
  const open = new Set<string>([scene.root]);
  for (const n of scene.nodes.values()) if ((n.kind === "program" || n.kind === "thread") && n.children.length > 0) open.add(n.id);
  return open;
}
