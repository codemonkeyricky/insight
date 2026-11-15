// Cuts a scene down to part of itself. The execution canvas's "roots only" view is the one cut the app makes: each
// thread keeps the functions it starts in, with the thread and the process box that holds it. Pure: the scene and
// the model are read, never changed.
import { execFnId, execThreadId } from "./exec-scene.js";
import type { ExecFunctionRef, ExecModel } from "./exec-model.js";
import { addSyncResources, syncEdgeKey, type Scene, type SceneEdge, type SceneNode } from "./scene.js";

/** The node kinds a sync edge may re-attach to: the boxes that hold placements (a thread, a coroutine, a program or process). */
const CONTAINER_KINDS: ReadonlySet<string> = new Set(["thread", "coroutine", "program"]);

/**
 * The scene with only the kept nodes, plus every ancestor of each of them. The root is always kept, so the result is
 * a scene of the same shape. Children keep their order and drop the nodes that were cut. An edge stays only when both
 * of its ends do, except a sync edge: one whose end was cut is re-attached to that end's nearest kept box (see
 * `reattacher`), and the sync edges that then share their ends merge, their resources listed together. An edge whose
 * two ends land on one box is dropped. Ids in `keep` that the scene does not have are ignored. The levels and the root
 * are the same. The input is not changed: kept nodes and edges are copies.
 */
export function keepScene(scene: Scene, keep: ReadonlySet<string>): Scene {
  const kept = new Set<string>([scene.root]);
  for (const id of keep) {
    if (!scene.nodes.has(id)) continue;
    // Walks up until a node already kept: that node's ancestors are kept already, so the walk stops there.
    let cur: string | undefined = id;
    while (cur !== undefined && !kept.has(cur)) {
      kept.add(cur);
      cur = scene.nodes.get(cur)?.parent;
    }
  }
  const nodes = new Map<string, SceneNode>();
  for (const [id, n] of scene.nodes) {
    if (!kept.has(id)) continue;
    nodes.set(id, { ...n, children: n.children.filter((c) => kept.has(c)) });
  }
  const edges = rewireEdges(scene.edges, (id) => kept.has(id), reattacher(scene, kept));
  return { root: scene.root, nodes, edges, levels: scene.levels };
}

/**
 * Where a cut sync end goes, for a kept scene. A kept id stays. Otherwise, in order: the nearest kept container above it
 * (its thread, coroutine or process box); else a kept root function whose call graph reaches it, the first by id; else
 * the nearest kept box above it. Undefined when none of those is kept, and the edge is then dropped.
 */
function reattacher(scene: Scene, kept: ReadonlySet<string>): (id: string) => string | undefined {
  const memo = new Map<string, string | undefined>();
  let callers: Map<string, string[]> | undefined;
  const callersOf = (id: string): string[] => {
    if (callers === undefined) {
      const index = new Map<string, string[]>();
      for (const e of scene.edges) {
        if (e.kind !== "call") continue;
        const list = index.get(e.to);
        if (list !== undefined) list.push(e.from);
        else index.set(e.to, [e.from]);
      }
      callers = index;
    }
    return callers.get(id) ?? [];
  };
  const ancestorsOf = (id: string): string[] => {
    const out: string[] = [];
    for (let cur = scene.nodes.get(id)?.parent; cur !== undefined; cur = scene.nodes.get(cur)?.parent) out.push(cur);
    return out;
  };
  return (id) => {
    if (kept.has(id)) return id;
    if (memo.has(id)) return memo.get(id);
    let found = ancestorsOf(id).find((a) => kept.has(a) && CONTAINER_KINDS.has(scene.nodes.get(a)?.kind ?? ""));
    if (found === undefined) {
      // Walks the call edges backwards: every function that reaches this one. The kept ones are the roots that do.
      const seen = new Set<string>([id]);
      const stack = [id];
      const reaching: string[] = [];
      while (stack.length > 0) {
        const cur = stack.pop() as string;
        for (const c of callersOf(cur)) {
          if (seen.has(c)) continue;
          seen.add(c);
          stack.push(c);
          if (kept.has(c)) reaching.push(c);
        }
      }
      found = reaching.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))[0];
    }
    found ??= ancestorsOf(id).find((a) => kept.has(a));
    memo.set(id, found);
    return found;
  };
}

/**
 * The edges of a cut: each non-sync edge whose ends are both kept, as is. Each sync edge has its ends mapped by `endOf`
 * and is dropped when one end maps to nothing or both map to one box. Sync edges that then share their ends and
 * direction merge into one, its count summed and its resources listed together, in the order first seen.
 */
function rewireEdges(edges: readonly SceneEdge[], isKept: (id: string) => boolean, endOf: (id: string) => string | undefined): SceneEdge[] {
  const out: SceneEdge[] = [];
  const merged = new Map<string, SceneEdge>();
  for (const e of edges) {
    if (e.kind !== "sync") {
      if (isKept(e.from) && isKept(e.to)) out.push({ ...e });
      continue;
    }
    const from = endOf(e.from);
    const to = endOf(e.to);
    if (from === undefined || to === undefined || from === to) continue;
    const directed = e.directed === true;
    const key = syncEdgeKey(from, to, directed);
    const cur = merged.get(key);
    if (cur !== undefined) {
      cur.count += e.count;
      cur.resources = addSyncResources(cur.resources ?? [], e.resources ?? []);
      continue;
    }
    const edge: SceneEdge = { ...e, from, to, directed, resources: addSyncResources([], e.resources ?? []) };
    merged.set(key, edge);
    out.push(edge);
  }
  return out;
}

/**
 * The execution scene's roots-only view. For each grounded thread of the model it keeps the thread node (even when the
 * thread starts no function that the scene holds) and the placement of each of its roots in that thread, when the scene
 * has one. A root of an ungrounded thread is placed flat, directly on the project (plain code flow), so its placement
 * there is kept instead. The flat functions with no caller inside the flat flow are kept too, since they start it.
 * Coroutines are cut, and so are the functions only called from the roots. A root's process box stays, as an ancestor
 * of the thread.
 */
export function execRootsOnly(scene: Scene, model: ExecModel): Scene {
  const keep = new Set<string>();
  for (const t of model.threads) {
    const thread = execThreadId(t.id);
    // A grounded thread has a node in the scene; an ungrounded one does not, and its roots sit on the project.
    const grounded = scene.nodes.has(thread);
    if (grounded) keep.add(thread);
    for (const r of t.roots) {
      const placement = execFnId(grounded ? thread : scene.root, r);
      if (scene.nodes.has(placement)) keep.add(placement);
    }
  }

  // The plain code flow: the functions placed directly on the project. A call from one of them to another makes the
  // callee a non-root, so the roots of the flow are the ones nothing calls within it.
  const flat = new Set<string>();
  for (const n of scene.nodes.values()) if (n.kind === "function" && n.parent === scene.root) flat.add(n.id);
  const called = new Set<string>();
  for (const e of scene.edges) if (e.kind === "call" && flat.has(e.from) && flat.has(e.to)) called.add(e.to);
  for (const id of flat) if (!called.has(id)) keep.add(id);

  return keepScene(scene, keep);
}

/** A file's path as the scope shows it: relative to the scope, or its base name when the scope is that file. */
export function pathInScope(file: string, scope: string): string {
  if (file === scope) return file.split("/").pop() ?? file;
  if (scope === "") return file;
  return file.startsWith(`${scope}/`) ? file.slice(scope.length + 1) : file;
}

/**
 * The roots-only cut, flat: every container (program, process, thread, coroutine) is dropped, and each root function is
 * one box directly on the project. A function placed in several threads is drawn once, at its first placement by id.
 * Its subtitle is its file relative to the scope and its line. Edges stay only between boxes that are both kept. A sync
 * edge whose end is a container box (its thread) joins that thread's first root box, so the sync edges survive the flat
 * cut too.
 */
export function flattenRoots(cut: Scene, model: ExecModel): Scene {
  const byFn = new Map<string, ExecFunctionRef>();
  for (const f of model.functions) byFn.set(f.id, f);
  const kept = new Map<string, SceneNode>();
  // The box drawn for each function, and the first box drawn inside each container (its thread or coroutine).
  const drawnFor = new Map<string, string>();
  const firstIn = new Map<string, string>();
  const fnNodes = [...cut.nodes.values()].filter((n) => n.kind === "function").sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const n of fnNodes) {
    const fnId = n.ref ?? n.id;
    let drawn = drawnFor.get(fnId);
    if (drawn === undefined) {
      drawn = n.id;
      drawnFor.set(fnId, drawn);
      const ref = byFn.get(fnId);
      const detail = ref !== undefined && ref.file !== "" ? `${pathInScope(ref.file, model.scope)}:${ref.line}` : n.detail;
      kept.set(n.id, { ...n, parent: cut.root, children: [], ...(detail !== undefined ? { detail } : {}) });
    }
    if (n.parent !== undefined && !firstIn.has(n.parent)) firstIn.set(n.parent, drawn);
  }
  const root = cut.nodes.get(cut.root);
  if (root === undefined) return cut;
  const nodes = new Map<string, SceneNode>([[cut.root, { ...root, children: [...kept.keys()].sort() }], ...kept]);
  const edges = rewireEdges(cut.edges, (id) => kept.has(id), (id) => (kept.has(id) ? id : firstIn.get(id)));
  return { root: cut.root, nodes, edges, levels: cut.levels };
}
