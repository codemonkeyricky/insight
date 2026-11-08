// The execution canvas's scene: a program holds its threads, a thread its functions and coroutines, a coroutine its
// own functions and nested coroutines. Built from one scope's ExecModel. See scene.ts for the model.
//
// A function is drawn once per place it runs: a helper two threads call has a box in each thread, and the call edges
// of one thread stay inside that thread. Pure and deterministic: the scene depends only on the model's content, not
// on the order of its call pairs.
import type { ExecCoroutine, ExecFunctionRef, ExecModel, ExecResource, ExecResourceSite, ExecThread } from "./exec-model.js";
import type { Scene, SceneEdge, SceneEdgeKind, SceneLevel, SceneNode } from "./scene.js";
import { LAYERED, ZOOM_SIZE } from "./zoom-layout.js";

/** The root node's id, when the model has no programs. */
export const EXEC_ROOT = "program";
/** The root node's id, when the model has programs: the project holds them. */
export const EXEC_PROJECT_ROOT = "project";
/** Most sync edges one lock or channel adds. The rest are skipped, in the order the pairs are made. */
export const MAX_SYNC_EDGES_PER_RESOURCE = 50;

/** The group that holds the functions no thread runs. */
export const NO_RUNTIME_GROUP = "group:none";
/** The note on each function in the no-runtime group. */
export const NO_RUNTIME_NOTE = "Plain call with no runtime context. Zoom out to see where it runs.";

/**
 * A thread, coroutine or group that holds more functions than this groups them by file. A flat container of hundreds
 * of boxes is unreadable, and the layered layout grows much faster than linearly in it (a 900-function thread took
 * over 20 s), so the files give the container a level of its own.
 */
export const FILE_GROUP_MIN = 24;

const GROUP_NOTE =
  "Functions that no thread in this scope runs: nothing a thread starts reaches them, for example because only " +
  "module-level statements call them. A wider scope may show where they run.";

/** Every node kind of the execution scene, with its level. */
export const EXEC_LEVELS: Record<string, SceneLevel> = {
  project: { box: { w: 300, h: 64 }, layout: LAYERED },
  program: { box: { w: 300, h: 64 }, layout: LAYERED },
  thread: { box: { w: 260, h: 60 }, layout: LAYERED },
  coroutine: { box: { w: 240, h: 52 }, layout: LAYERED },
  file: { box: { w: ZOOM_SIZE.file.w, h: ZOOM_SIZE.file.h }, layout: LAYERED },
  function: { box: { w: ZOOM_SIZE.fn.w, h: ZOOM_SIZE.fn.h } },
  group: {
    box: { w: 260, h: 60 },
    layout: {
      "elk.algorithm": "rectpacking",
      "elk.spacing.nodeNode": "24",
      "elk.padding": "[top=0,left=0,bottom=0,right=0]",
    },
  },
};

export function execThreadId(threadId: string): string {
  return `thread:${threadId}`;
}

/** The scene id of a program, by its build target's id. */
export function execProgramId(programId: string): string {
  return `prog:${programId}`;
}

export function execCoroutineId(threadId: string, target: string): string {
  return `co:${threadId}:${target}`;
}

/**
 * A function's placement in a container: the container's scene id, a literal `>`, then the function id. The container
 * is the thread, coroutine or group, even when a file node sits in between, so the id does not depend on grouping.
 */
export function execFnId(container: string, fn: string): string {
  return `${container}>${fn}`;
}

/** The file node that groups a container's functions from one file. */
export function execFileId(container: string, file: string): string {
  return `${container}>file:${file}`;
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

/** The placements of one function in one thread (or the no-runtime group). */
interface Placed {
  /** Placement ids, sorted by id once building is done. */
  ids: string[];
  /**
   * Placement id by the thread, coroutine or group that holds it (not the file node between them). A function is
   * placed at most once per container.
   */
  byParent: Map<string, string>;
}

export function buildExecScene(model: ExecModel): Scene {
  const fns = new Map<string, ExecFunctionRef>();
  for (const f of model.functions) fns.set(f.id, f);
  const nameOf = (id: string): string => fns.get(id)?.name ?? id;

  const nodes = new Map<string, SceneNode>();
  // fnId -> thread key (thread scene id or the group id) -> placements.
  const placements = new Map<string, Map<string, Placed>>();

  const addNode = (node: SceneNode): void => {
    nodes.set(node.id, node);
    if (node.parent !== undefined) nodes.get(node.parent)?.children.push(node.id);
  };

  /** The thread, coroutine or group each placement belongs to, which a file node may sit under. */
  const containerOf = new Map<string, string>();

  /**
   * Places functions in a container, in the order given. Unlisted and already placed ones are skipped. Past
   * FILE_GROUP_MIN functions from more than one file, each file gets a node of its own, in the order its first
   * function comes, and its functions keep their order inside it.
   */
  const placeAll = (threadKey: string, container: string, fnIds: readonly string[], note?: string): void => {
    const todo: ExecFunctionRef[] = [];
    const seen = new Set<string>();
    for (const fnId of fnIds) {
      const f = fns.get(fnId);
      if (f === undefined || seen.has(fnId) || nodes.has(execFnId(container, fnId))) continue;
      seen.add(fnId);
      todo.push(f);
    }
    const byFile = new Map<string, ExecFunctionRef[]>();
    for (const f of todo) {
      const list = byFile.get(f.file);
      if (list) list.push(f);
      else byFile.set(f.file, [f]);
    }
    const grouped = todo.length > FILE_GROUP_MIN && byFile.size > 1;
    for (const [file, list] of grouped ? byFile : new Map([["", todo]])) {
      let parent = container;
      if (grouped) {
        parent = execFileId(container, file);
        addNode({
          id: parent,
          kind: "file",
          label: file === "" ? "No source" : basename(file),
          parent: container,
          children: [],
          detail: plural(list.length, "function"),
          ...(file !== "" ? { note: file } : {}),
        });
      }
      for (const f of list) placeOne(threadKey, container, parent, f, note);
    }
  };

  const placeOne = (threadKey: string, container: string, parent: string, f: ExecFunctionRef, note?: string): void => {
    const id = execFnId(container, f.id);
    const node: SceneNode = { id, kind: "function", label: f.name, parent, children: [], ref: f.id };
    if (f.chart !== undefined) node.chart = { w: f.chart[0], h: f.chart[1] };
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

  // The tree. With programs, the root is the project and each program holds its threads; without, the root is the program.
  const threadCount = model.threads.length;
  const unthreaded = model.unthreaded.filter((id) => fns.has(id));
  // A model saved before programs existed has none: read it as an empty list.
  const programs = model.programs ?? [];
  const hasPrograms = programs.length > 0;
  const rootId = hasPrograms ? EXEC_PROJECT_ROOT : EXEC_ROOT;
  const root: SceneNode = hasPrograms
    ? {
        id: rootId,
        kind: "project",
        label: model.scope === "" ? "Project" : model.scope,
        children: [],
        detail: plural(programs.length, "program"),
      }
    : {
        id: rootId,
        kind: "program",
        label: model.scope === "" ? "Program" : model.scope,
        children: [],
        detail: plural(threadCount, "thread"),
      };
  if (model.truncated) {
    root.note =
      `The model lists only ${plural(model.functions.length, "function")}: the function cap cut it, so later ` +
      "threads and functions are missing or incomplete.";
  }
  addNode(root);

  // A thread sits under the first program (by id) that lists it. The others only count it in their notes.
  const programOfThread = new Map<string, string>();
  const listedBy = new Map<string, number>();
  for (const p of programs) {
    for (const t of p.threads) {
      if (!programOfThread.has(t)) programOfThread.set(t, p.id);
      listedBy.set(t, (listedBy.get(t) ?? 0) + 1);
    }
  }
  for (const p of programs) {
    const main = p.main !== undefined ? nameOf(p.main) : undefined;
    const shared = p.threads.filter((t) => (listedBy.get(t) ?? 0) > 1).length;
    const parts = [`Built from ${plural(p.files.length, "file")}.`, main !== undefined ? `Main function: ${main}.` : "No main function in the IR."];
    if (shared > 0) parts.push(`Shares ${plural(shared, "thread")} with other programs.`);
    addNode({
      id: execProgramId(p.id),
      kind: "program",
      label: p.name,
      parent: rootId,
      children: [],
      detail: p.targetKind,
      note: parts.join(" "),
    });
  }

  // The coroutine node each (thread, coroutine) got, for the dispatch edges.
  const coNodes: { thread: ExecThread; key: string; co: ExecCoroutine; id: string; container: string }[] = [];

  for (const t of model.threads) {
    const key = execThreadId(t.id);
    const owner = programOfThread.get(t.id);
    addNode(threadNode(t, key, owner !== undefined ? execProgramId(owner) : rootId));

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
    placeAll(key, key, ordered);

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
      coNodes.push({ thread: t, key, co, id, container });
      placeAll(key, id, [co.target, ...[...co.callees].sort(cmp)]);
      for (const child of t.coroutines) if (child.parent === co.target && child !== co) addCoroutine(child, id);
    };
    for (const co of t.coroutines) {
      if (co.parent === undefined || !coByTarget.has(co.parent)) addCoroutine(co, key);
    }
    // Defensive: a coroutine whose parents form a cycle has no top-level ancestor; draw it on the thread.
    for (const co of t.coroutines) addCoroutine(co, key);
  }

  if (unthreaded.length > 0) {
    addNode({
      id: NO_RUNTIME_GROUP,
      kind: "group",
      label: "No runtime context",
      parent: rootId,
      children: [],
      detail: plural(unthreaded.length, "function"),
      note: GROUP_NOTE,
    });
    placeAll(NO_RUNTIME_GROUP, NO_RUNTIME_GROUP, unthreaded, NO_RUNTIME_NOTE);
  }

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

  /** Links every placement of `a` to one placement of `b` in the same thread. */
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
      const p = byThread.get(NO_RUNTIME_GROUP);
      if (p !== undefined) from = pick(p, NO_RUNTIME_GROUP, NO_RUNTIME_GROUP);
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
  return { root: rootId, nodes, edges: edgeList, levels: EXEC_LEVELS };

  function threadNode(t: ExecThread, id: string, parent: string): SceneNode {
    let label: string;
    if (t.kind === "main") label = "Main thread";
    else {
      const first = t.roots[0];
      const name =
        first !== undefined && fns.has(first)
          ? nameOf(first)
          : t.spawn?.script !== undefined && t.spawn.script !== ""
            ? basename(t.spawn.script)
            : "unresolved";
      label = `${KIND_LABEL[t.kind] ?? t.kind} · ${name}`;
    }
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
