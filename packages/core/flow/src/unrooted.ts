// The Flow canvas: a flat grid of the unrooted functions of a scope. No runtime frames (program, process, thread, coroutine)
// are drawn; the System tab shows those. A card is an in-scope function that no other in-scope function calls, references,
// dispatches or spawns. A cycle that nothing outside enters gets one card (its lowest id), so every function the scope draws
// is reached from some card. A module entry (a file's top-level code) is a card only when that code calls, dispatches or
// spawns something, in scope or out. Sync edges join the cards that reach their sites (see unrootedReach). Pure: the scene
// and the model are read, never changed.
import type { ExecModel } from "./exec-model.js";
import { displayName, stemOf } from "./names.js";
import { flattenRoots, keepScene, rewireEdges } from "./scene-filter.js";
import { addSyncResources, type Scene, type SceneEdge, type SceneNode, type SceneSyncResource } from "./scene.js";

/** A grid with more cards than this shows its first MORE_KEEP and one "+N more" card, unless it is expanded. */
export const MORE_AFTER = 24;
export const MORE_KEEP = 23;
/** The suffix of the id of the grid's "+N more" card. The grid's id is the project's, so the card's id is `project#more`. */
export const MORE_SUFFIX = "#more";

/** The suffix a file's module entry id carries: `<file>#(module)`. */
const MODULE_SUFFIX = "#(module)";

/** The caller-to-callee graph over the candidates (in-scope functions the scene draws), and the cards it gives. */
interface CardGraph {
  /** Caller to callees, among the candidates. A spawn's owner points at the roots it starts; a file stands for its module entry. */
  out: Map<string, Set<string>>;
  /** Callee to callers, among the candidates: the reverse of `out`. */
  into: Map<string, Set<string>>;
  /** The candidates, sorted by id. */
  ids: string[];
  /** The cards, sorted by id. */
  cards: string[];
}

function cardGraph(model: ExecModel, drawn: ReadonlySet<string>): CardGraph {
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
  const into = new Map<string, Set<string>>();
  const spawners = new Set<string>();
  const link = (from: string | undefined, to: string | undefined): void => {
    if (from === undefined || to === undefined || from === to) return;
    let s = out.get(from);
    if (s === undefined) out.set(from, (s = new Set()));
    s.add(to);
    let r = into.get(to);
    if (r === undefined) into.set(to, (r = new Set()));
    r.add(from);
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

  const sorted = [...ids].sort();
  const groups = components(sorted, out);
  const comp = new Map<string, number>();
  groups.forEach((group, c) => {
    for (const v of group) comp.set(v, c);
  });

  // A component entered from outside it, by some other component's edge, is reached from that caller.
  const entered = groups.map(() => false);
  for (const [from, tos] of out) {
    for (const to of tos) {
      const c = comp.get(to);
      if (c !== undefined && comp.get(from) !== c) entered[c] = true;
    }
  }

  const cards = new Set<string>();
  for (const id of sorted) if (!into.has(id)) cards.add(id);
  groups.forEach((group, c) => {
    if (group.length > 1 && entered[c] !== true) cards.add([...group].sort()[0] ?? "");
  });
  // A module entry that calls, dispatches or spawns nothing is a file's declarations, not a card.
  for (const id of [...cards]) {
    const f = byId.get(id);
    const acts = f?.callsOut === true || (out.get(id)?.size ?? 0) > 0;
    if (f?.module === true && !acts && !spawners.has(id)) cards.delete(id);
  }
  return { out, into, ids: sorted, cards: [...cards].sort() };
}

/**
 * The strongly connected components of the graph over `ids`, by Tarjan's algorithm. Iterative: each open node keeps its own
 * stack frame, so a long call chain cannot overflow the JavaScript stack.
 */
function components(ids: readonly string[], out: ReadonlyMap<string, ReadonlySet<string>>): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const groups: string[][] = [];
  for (const root of ids) {
    if (index.has(root)) continue;
    const frames: { v: string; next: string[]; at: number }[] = [];
    const open = (v: string): void => {
      index.set(v, index.size);
      low.set(v, index.get(v) ?? 0);
      stack.push(v);
      onStack.add(v);
      frames.push({ v, next: [...(out.get(v) ?? [])], at: 0 });
    };
    open(root);
    while (frames.length > 0) {
      const top = frames[frames.length - 1];
      if (top === undefined) break;
      if (top.at < top.next.length) {
        const w = top.next[top.at] ?? "";
        top.at += 1;
        if (!index.has(w)) open(w);
        else if (onStack.has(w)) low.set(top.v, Math.min(low.get(top.v) ?? 0, index.get(w) ?? 0));
        continue;
      }
      frames.pop();
      const parent = frames[frames.length - 1];
      if (parent !== undefined) low.set(parent.v, Math.min(low.get(parent.v) ?? 0, low.get(top.v) ?? 0));
      if (low.get(top.v) !== index.get(top.v)) continue;
      const group: string[] = [];
      for (;;) {
        const w = stack.pop() ?? top.v;
        onStack.delete(w);
        group.push(w);
        if (w === top.v) break;
      }
      groups.push(group);
    }
  }
  return groups;
}

/**
 * The cards of a scope: the in-scope functions the full scene draws (`drawn`, by function id) that no other such function
 * calls, references, dispatches or spawns, plus one function per cycle no outside function enters. A spawn's targets are the
 * roots of the spawned thread; its owner is the spawner. A file-level owner or dispatch source stands for the file's module
 * entry. Sorted by id.
 */
export function unrootedFunctions(model: ExecModel, drawn: ReadonlySet<string>): string[] {
  return cardGraph(model, drawn).cards;
}

/** Which cards reach which functions, over the graph unrootedFunctions reads. See unrootedReach. */
export interface UnrootedReach {
  /** The cards, sorted by id: the same as unrootedFunctions. */
  readonly cards: readonly string[];
  /** The functions a card reaches, itself included, sorted by id: its callees, the roots it spawns, and so on, down. */
  reachOf(card: string): string[];
  /**
   * The card a function is drawn under: the card whose reach holds it, nearest by call depth (fewest links from the card),
   * ties to the lowest id. Undefined when no card reaches the function. A sync edge's end joins this card.
   */
  cardOf(fn: string): string | undefined;
}

/**
 * The reach of the cards of a scope, over the caller-to-callee graph of unrootedFunctions (calls, references, dispatches, a
 * spawn's owner to its roots, a coroutine's dispatchers to its target). Each function a sync site names is drawn under the
 * nearest card that reaches it, so a site in a spawned thread (which has no card of its own) joins its spawner's card.
 */
export function unrootedReach(model: ExecModel, drawn: ReadonlySet<string>): UnrootedReach {
  const g = cardGraph(model, drawn);
  const cardSet = new Set(g.cards);
  const memo = new Map<string, string | undefined>();
  const cardOf = (fn: string): string | undefined => {
    if (memo.has(fn)) return memo.get(fn);
    // Breadth-first over the callers of `fn`: the first level holding a card names it (lowest id within that level).
    const seen = new Set<string>([fn]);
    let frontier = [fn];
    let found: string | undefined;
    while (frontier.length > 0 && found === undefined) {
      const hits = frontier.filter((x) => cardSet.has(x)).sort();
      if (hits.length > 0) {
        found = hits[0];
        break;
      }
      const next: string[] = [];
      for (const x of frontier) {
        for (const c of g.into.get(x) ?? []) {
          if (seen.has(c)) continue;
          seen.add(c);
          next.push(c);
        }
      }
      frontier = next;
    }
    memo.set(fn, found);
    return found;
  };
  const reachOf = (card: string): string[] => {
    const seen = new Set<string>([card]);
    const stack = [card];
    while (stack.length > 0) {
      const cur = stack.pop() as string;
      for (const to of g.out.get(cur) ?? []) {
        if (seen.has(to)) continue;
        seen.add(to);
        stack.push(to);
      }
    }
    return [...seen].sort();
  };
  return { cards: g.cards, reachOf, cardOf };
}

/**
 * The Flow canvas's scene: the cards of unrootedFunctions drawn as one flat grid under the project, each function once, in
 * name order. A grid of more than MORE_AFTER cards shows its first MORE_KEEP and a "+N more" card, unless its root id is in
 * `expanded` (the grid is expanded). A sync edge joins the card that reaches its site (see unrootedReach). When both ends join
 * one card, the edge's resources are kept on that card as `syncSelf` (the renderer draws no self-edge). An edge with no card
 * at an end is dropped. A card that holds an access site of unguarded shared state (the function that makes the write, mapped
 * to its nearest card by cardOf) carries the variable names as `unguarded`; cards that only reach the thread do not. Cards
 * whose display name another card shares carry `shownName`. The input is not changed.
 */
export function unrootedScene(full: Scene, model: ExecModel, expanded: ReadonlySet<string> = new Set()): Scene {
  const drawn = new Set<string>();
  // Each function's first placement by id: the placement its card is drawn at.
  const firstOf = new Map<string, string>();
  const placed = [...full.nodes.values()].filter((n) => n.kind === "function" && n.ref !== undefined).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const n of placed) {
    const ref = n.ref ?? "";
    drawn.add(ref);
    if (!firstOf.has(ref)) firstOf.set(ref, n.id);
  }
  const reach = unrootedReach(model, drawn);
  const cards = new Set(reach.cards);
  const keep = new Set<string>();
  for (const n of placed) if (cards.has(n.ref ?? "")) keep.add(n.id);

  // A sync end (a placement, or a container's functions) moves to the first placement of the card that reaches it.
  const cardPlacement = (placementId: string): string | undefined => {
    const direct = full.nodes.get(placementId);
    const card = direct?.kind === "function" && direct.ref !== undefined ? reach.cardOf(direct.ref) : undefined;
    if (direct?.kind === "function") return card === undefined ? undefined : firstOf.get(card);
    for (const fnId of functionsUnder(full, placementId)) {
      const c = reach.cardOf(fnId);
      if (c !== undefined) return firstOf.get(c);
    }
    return undefined;
  };
  const edges: SceneEdge[] = [];
  // Each card placement's sync resources when both ends of an edge land on it (a thread starting a thread that shares its lock).
  const selfSync = new Map<string, SceneSyncResource[]>();
  for (const e of full.edges) {
    if (e.kind !== "sync") {
      edges.push(e);
      continue;
    }
    const from = cardPlacement(e.from);
    const to = cardPlacement(e.to);
    if (from === undefined || to === undefined) continue;
    if (from === to) {
      selfSync.set(from, addSyncResources(selfSync.get(from) ?? [], e.resources ?? []));
      continue;
    }
    edges.push({ ...e, from, to });
  }

  const marks = new Map<string, { syncSelf?: SceneSyncResource[]; unguarded?: string[] }>();
  for (const [placement, resources] of selfSync) marks.set(placement, { syncSelf: resources });
  for (const [card, names] of unguardedCards(model, reach)) {
    const placement = firstOf.get(card);
    if (placement === undefined) continue;
    marks.set(placement, { ...marks.get(placement), unguarded: names });
  }

  const flat = markCards(flattenRoots(keepScene({ ...full, edges }, keep), model), marks);
  return nameSharedCards(withMore(flat, expanded), model);
}

/** The base name of a file's directory: "poc/orrery/main.ts" -> "orrery". Empty for a file at the root. */
function dirOf(file: string): string {
  const parts = file.split("/");
  return parts.length >= 2 ? (parts[parts.length - 2] ?? "") : "";
}

/**
 * The cards of the grid whose display name another card shares get the name's file stem after it, as `shownName`: two
 * functions both named `main` in guideplan.ts and verify.ts draw as "main · guideplan" and "main · verify". The scene's
 * labels, tooltips and ids are unchanged.
 */
function nameSharedCards(scene: Scene, model: ExecModel): Scene {
  const fileOf = new Map(model.functions.map((f) => [f.id, f.file] as const));
  const byName = new Map<string, SceneNode[]>();
  for (const n of scene.nodes.values()) {
    if (n.kind !== "function" || n.ref === undefined) continue;
    const shown = displayName(n.label, n.ref);
    const list = byName.get(shown);
    if (list) list.push(n);
    else byName.set(shown, [n]);
  }
  const nodes = new Map(scene.nodes);
  for (const [shown, group] of byName) {
    if (group.length < 2) continue;
    for (const n of group) {
      const file = fileOf.get(n.ref ?? "") ?? "";
      // The file's stem. A file whose stem is the name itself (a `main.ts` entry) names its directory instead, so
      // `main.ts` files in two directories still read apart.
      let tag = file === "" ? "" : stemOf(file);
      if (tag === shown) tag = dirOf(file);
      if (tag === "" || tag === shown) continue;
      nodes.set(n.id, { ...n, shownName: `${shown} · ${tag}` });
    }
  }
  return { ...scene, nodes };
}

/**
 * The unguarded variables of each card: the access sites it holds. A function that writes unguarded shared state (its
 * `unguardedWrites`) badges only the card that reaches it nearest (cardOf), not every card that reaches its thread. Only
 * the cards that hold such a site get an entry, sorted by name.
 */
function unguardedCards(model: ExecModel, reach: UnrootedReach): Map<string, string[]> {
  const out = new Map<string, Set<string>>();
  for (const f of model.functions) {
    if (f.unguardedWrites === undefined || f.unguardedWrites.length === 0) continue;
    const card = reach.cardOf(f.id);
    if (card === undefined) continue;
    let names = out.get(card);
    if (names === undefined) out.set(card, (names = new Set()));
    for (const v of f.unguardedWrites) names.add(v);
  }
  return new Map([...out].map(([card, names]) => [card, [...names].sort()]));
}

/** The scene with each marked node given its marks. A mark names a node that the scene draws; the input is not changed. */
function markCards(flat: Scene, marks: ReadonlyMap<string, { syncSelf?: SceneSyncResource[]; unguarded?: string[] }>): Scene {
  if (marks.size === 0) return flat;
  const nodes = new Map(flat.nodes);
  for (const [id, mark] of marks) {
    const n = nodes.get(id);
    if (n === undefined) continue;
    nodes.set(id, {
      ...n,
      ...(mark.syncSelf !== undefined ? { syncSelf: mark.syncSelf } : {}),
      ...(mark.unguarded !== undefined ? { unguarded: mark.unguarded } : {}),
    });
  }
  return { ...flat, nodes };
}

/** The function placements under a node, in id order: the node itself when it is one, else every one below it. */
function functionsUnder(scene: Scene, id: string): string[] {
  const out: string[] = [];
  const stack = [id];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const n: SceneNode | undefined = scene.nodes.get(cur);
    if (n === undefined) continue;
    if (n.kind === "function" && n.ref !== undefined) out.push(n.ref);
    for (const c of n.children) stack.push(c);
  }
  return out.sort();
}

/**
 * The flat grid with its "+N more" card when it is long and not expanded. A sync edge whose card is hidden behind the
 * "+N more" card reattaches to that card; edges that then share their ends merge, and one whose ends both land there is dropped.
 */
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
  const edges = rewireEdges(
    flat.edges,
    (id) => nodes.has(id),
    (id) => (nodes.has(id) ? id : hidden.has(id) ? more : undefined),
  );
  return { ...flat, nodes, edges, levels: { ...flat.levels, more: { box: { w: 160, h: 56 } } } };
}

function withRoot(nodes: ReadonlyMap<string, SceneNode>, id: string, node: SceneNode): Map<string, SceneNode> {
  const out = new Map(nodes);
  out.set(id, node);
  return out;
}
