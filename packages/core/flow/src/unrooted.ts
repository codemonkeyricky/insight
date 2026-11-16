// The Flow canvas: a flat grid of the unrooted functions of a scope. No runtime frames (program, process, thread, coroutine)
// are drawn; the System tab shows those. A card is an in-scope function that no other in-scope function calls, references,
// dispatches or spawns. A cycle that nothing outside enters gets one card (its lowest id), so every function the scope draws
// is reached from some card. A module entry (a file's top-level code) is a card only when that code calls, dispatches or
// spawns something. Pure: the scene and the model are read, never changed.
import type { ExecModel } from "./exec-model.js";
import { flattenRoots, keepScene } from "./scene-filter.js";
import type { Scene, SceneEdge, SceneNode } from "./scene.js";

/** A grid with more cards than this shows its first MORE_KEEP and one "+N more" card, unless it is expanded. */
export const MORE_AFTER = 24;
export const MORE_KEEP = 23;
/** The suffix of the id of the grid's "+N more" card. The grid's id is the project's, so the card's id is `project#more`. */
export const MORE_SUFFIX = "#more";

/** The suffix a file's module entry id carries: `<file>#(module)`. */
const MODULE_SUFFIX = "#(module)";

/**
 * The cards of a scope: the in-scope functions the full scene draws (`drawn`, by function id) that no other such function
 * calls, references, dispatches or spawns, plus one function per cycle no outside function enters. A spawn's targets are the
 * roots of the spawned thread; its owner is the spawner. A file-level owner or dispatch source stands for the file's module
 * entry. Sorted by id.
 */
export function unrootedFunctions(model: ExecModel, drawn: ReadonlySet<string>): string[] {
  const byId = new Map(model.functions.map((f) => [f.id, f] as const));
  const ids = new Set<string>();
  for (const f of model.functions) if (f.inScope && drawn.has(f.id)) ids.add(f.id);
  // A file, or a module entry, to the function the scene draws for it; undefined when the scope draws no such function.
  const fnOf = (x: string): string | undefined => {
    if (ids.has(x)) return x;
    const module = `${x}${MODULE_SUFFIX}`;
    return ids.has(module) ? module : undefined;
  };

  // The caller-to-callee edges between the candidates, and the spawners.
  const out = new Map<string, Set<string>>();
  const incoming = new Set<string>();
  const spawners = new Set<string>();
  const link = (from: string | undefined, to: string | undefined): void => {
    if (from === undefined || to === undefined || from === to) return;
    let s = out.get(from);
    if (s === undefined) out.set(from, (s = new Set()));
    s.add(to);
    incoming.add(to);
  };
  for (const [i, j] of model.calls) link(fnOf(model.functions[i]?.id ?? ""), fnOf(model.functions[j]?.id ?? ""));
  for (const d of model.dispatches) for (const t of d.targets) link(fnOf(d.from), fnOf(t));
  for (const t of model.threads) {
    for (const co of t.coroutines) for (const d of co.dispatchedBy) link(fnOf(d), fnOf(co.target));
    const owner = t.spawn?.owner === undefined ? undefined : fnOf(t.spawn.owner);
    if (owner === undefined) continue;
    spawners.add(owner);
    for (const r of t.roots) link(owner, fnOf(r));
  }

  // Tarjan's strongly connected components over the candidates, in id order.
  const order = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const comp = new Map<string, number>();
  const members: string[][] = [];
  const visit = (v: string): void => {
    const at = order.size;
    order.set(v, at);
    low.set(v, at);
    stack.push(v);
    onStack.add(v);
    for (const w of out.get(v) ?? []) {
      if (!order.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v) ?? at, low.get(w) ?? at));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v) ?? at, order.get(w) ?? at));
      }
    }
    if (low.get(v) !== order.get(v)) return;
    const group: string[] = [];
    for (;;) {
      const w = stack.pop() ?? v;
      onStack.delete(w);
      comp.set(w, members.length);
      group.push(w);
      if (w === v) break;
    }
    members.push(group);
  };
  const sorted = [...ids].sort();
  for (const v of sorted) if (!order.has(v)) visit(v);

  // A component entered from outside it, by some other component's edge, is reached from that caller.
  const entered = members.map(() => false);
  for (const [from, tos] of out) {
    for (const to of tos) {
      const c = comp.get(to);
      if (c !== undefined && comp.get(from) !== c) entered[c] = true;
    }
  }

  const cards = new Set<string>();
  for (const id of sorted) if (!incoming.has(id)) cards.add(id);
  members.forEach((group, c) => {
    if (group.length > 1 && entered[c] !== true) cards.add([...group].sort()[0] ?? "");
  });
  // A module entry that calls, dispatches or spawns nothing in scope is a file's declarations, not a card.
  for (const id of [...cards]) {
    const f = byId.get(id);
    if (f?.module === true && (out.get(id)?.size ?? 0) === 0 && !spawners.has(id)) cards.delete(id);
  }
  return [...cards].sort();
}

/**
 * The Flow canvas's scene: the cards of unrootedFunctions drawn as one flat grid under the project, each function once, in
 * name order. A grid of more than MORE_AFTER cards shows its first MORE_KEEP and a "+N more" card, unless its root id is in
 * `expanded` (the grid is expanded). Sync edges join the card that holds their end. The input is not changed.
 */
export function unrootedScene(full: Scene, model: ExecModel, expanded: ReadonlySet<string> = new Set()): Scene {
  const drawn = new Set<string>();
  for (const n of full.nodes.values()) if (n.kind === "function" && n.ref !== undefined) drawn.add(n.ref);
  const cards = new Set(unrootedFunctions(model, drawn));
  const keep = new Set<string>();
  for (const n of full.nodes.values()) if (n.kind === "function" && n.ref !== undefined && cards.has(n.ref)) keep.add(n.id);
  const flat = flattenRoots(keepScene(full, keep), model);
  return withMore(flat, expanded);
}

/** The flat grid with its "+N more" card when it is long and not expanded. */
function withMore(flat: Scene, expanded: ReadonlySet<string>): Scene {
  const root = flat.nodes.get(flat.root);
  if (root === undefined) return flat;
  const kids = root.children;
  const count = kids.length;
  const plural = count === 1 ? "" : "s";
  const detail = `${count} function${plural}`;
  if (expanded.has(flat.root) || count <= MORE_AFTER) {
    return { ...flat, nodes: withRoot(flat.nodes, flat.root, { ...root, detail }) };
  }
  const hidden = new Set(kids.slice(MORE_KEEP));
  const more = `${flat.root}${MORE_SUFFIX}`;
  const nodes = new Map<string, SceneNode>();
  for (const [id, n] of flat.nodes) if (!hidden.has(id)) nodes.set(id, n);
  nodes.set(flat.root, { ...root, detail, children: [...kids.slice(0, MORE_KEEP), more] });
  nodes.set(more, {
    id: more,
    kind: "more",
    label: `+${hidden.size} more`,
    parent: flat.root,
    children: [],
    detail: "Click to show every card in this scope",
  });
  const edges: SceneEdge[] = flat.edges.filter((e) => nodes.has(e.from) && nodes.has(e.to));
  return { ...flat, nodes, edges, levels: { ...flat.levels, more: { box: { w: 160, h: 56 } } } };
}

function withRoot(nodes: ReadonlyMap<string, SceneNode>, id: string, node: SceneNode): Map<string, SceneNode> {
  const out = new Map(nodes);
  out.set(id, node);
  return out;
}
