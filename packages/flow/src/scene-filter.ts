// Cuts a scene down to part of itself. The execution canvas's "roots only" view is the one cut the app makes: each
// thread keeps the functions it starts in, with the thread and the process box that holds it. Pure: the scene and
// the model are read, never changed.
import { execFnId, execThreadId } from "./exec-scene.js";
import type { ExecModel } from "./exec-model.js";
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
