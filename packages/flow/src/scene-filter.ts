// Cuts a scene down to part of itself. The execution canvas's "roots only" view is the one cut the app makes: each
// thread keeps the functions it starts in, with the thread and the process box that holds it. Pure: the scene and
// the model are read, never changed.
import { execFnId, execThreadId } from "./exec-scene.js";
import type { ExecFunctionRef, ExecModel } from "./exec-model.js";
import type { Scene, SceneNode } from "./scene.js";

/**
 * The scene with only the kept nodes, plus every ancestor of each of them. The root is always kept, so the result is
 * a scene of the same shape. Children keep their order and drop the nodes that were cut. An edge stays only when both
 * of its ends do. Ids in `keep` that the scene does not have are ignored. The levels and the root are the same. The
 * input is not changed: kept nodes and edges are copies.
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
  const edges = scene.edges.filter((e) => kept.has(e.from) && kept.has(e.to)).map((e) => ({ ...e }));
  return { root: scene.root, nodes, edges, levels: scene.levels };
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
function pathInScope(file: string, scope: string): string {
  if (file === scope) return file.split("/").pop() ?? file;
  if (scope === "") return file;
  return file.startsWith(`${scope}/`) ? file.slice(scope.length + 1) : file;
}

/**
 * The roots-only cut, flat: every container (program, process, thread, coroutine) is dropped, and each root function is
 * one box directly on the project. A function placed in several threads is drawn once, at its first placement by id.
 * Its subtitle is its file relative to the scope and its line. Edges stay only between boxes that are both kept.
 */
export function flattenRoots(cut: Scene, model: ExecModel): Scene {
  const byFn = new Map<string, ExecFunctionRef>();
  for (const f of model.functions) byFn.set(f.id, f);
  const kept = new Map<string, SceneNode>();
  const seen = new Set<string>();
  const fnNodes = [...cut.nodes.values()].filter((n) => n.kind === "function").sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const n of fnNodes) {
    const fnId = n.ref ?? n.id;
    if (seen.has(fnId)) continue;
    seen.add(fnId);
    const ref = byFn.get(fnId);
    const detail = ref !== undefined && ref.file !== "" ? `${pathInScope(ref.file, model.scope)}:${ref.line}` : n.detail;
    kept.set(n.id, { ...n, parent: cut.root, children: [], ...(detail !== undefined ? { detail } : {}) });
  }
  const root = cut.nodes.get(cut.root);
  if (root === undefined) return cut;
  const nodes = new Map<string, SceneNode>([[cut.root, { ...root, children: [...kept.keys()].sort() }], ...kept]);
  const edges = cut.edges.filter((e) => kept.has(e.from) && kept.has(e.to)).map((e) => ({ ...e }));
  return { root: cut.root, nodes, edges, levels: cut.levels };
}
