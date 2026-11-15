import type { IRNode, NodeId } from "@insight/ir";
import type { ProjectModel, Rel, RelKind } from "./model.js";
import type { RefRow } from "./refs.js";
import type { ScopeView } from "./view.js";

/**
 * The `how` values of a reference that invoke the referenced function, so the reference is a caller in effect: a
 * construction (`new`), a JSX render (`jsx`) or an event handler registration (`handler`). Any other reference passes the
 * function around as a value. Shared by the caller chain, the reference rows and the callers box.
 */
export const INVOKING_HOWS: ReadonlySet<string> = new Set(["new", "jsx", "handler"]);

/**
 * The function (or file) a relation's caller folds into, shared by the "Called by" list and the caller chain so the two
 * cannot drift. A spawn is not a function: its caller is the function (or file) that starts the thread, labelled with the
 * API. Any other relation folds an anonymous caller into its nearest named parent.
 */
export function folded(model: ProjectModel, rel: Rel): { other: NodeId; label?: string } {
  const src = model.byId.get(rel.from);
  if (src !== undefined && (src.kind === "concurrency.spawn-thread" || src.kind === "concurrency.spawn-process") && src.parent !== undefined) {
    const api = typeof src.attrs.api === "string" ? src.attrs.api : "thread";
    return { other: ownerOf(model.byId, src.parent), label: `spawns ${api}` };
  }
  return { other: ownerOf(model.byId, rel.from) };
}

/** The row for one node, before its count and site. A file row takes its line from the first site. */
export function describe(view: ScopeView, id: NodeId, kind: RelKind): RefRow {
  const { model } = view;
  const fn = model.functionById.get(id);
  const node = model.byId.get(id);
  if (fn) {
    return { id, name: fn.name, file: fn.file, line: (fn.span?.start[0] ?? 0) + 1, isFunction: true, kind, candidate: false, count: 0, inScope: view.has(id) };
  }
  if (node?.kind === "structure.file") {
    const file = model.fileOf(id) ?? id;
    return { id, name: basename(file), file, line: 0, isFunction: false, kind, candidate: false, count: 0, inScope: view.has(id) };
  }
  const file = model.fileOf(id) ?? "";
  const name = typeof node?.attrs.name === "string" ? node.attrs.name : id;
  return { id, name, file, line: (node?.span?.start[0] ?? -1) + 1, isFunction: false, kind, candidate: false, count: 0, inScope: view.has(id) };
}

/** Rows in scope first, then by file, line, name and id, so the same model always lists the same way. */
export function order(a: RefRow, b: RefRow): number {
  if (a.inScope !== b.inScope) return a.inScope ? -1 : 1;
  return cmp(a.file, b.file) || a.line - b.line || cmp(a.name, b.name) || cmp(a.id, b.id) || cmp(a.kind, b.kind);
}

/**
 * The function (or file) an anonymous function's references belong to: its nearest named parent, walking up through
 * anonymous functions. A node that is not anonymous is its own owner.
 */
export function ownerOf(byId: ReadonlyMap<NodeId, IRNode>, id: NodeId): NodeId {
  let cur = id;
  for (let depth = 0; depth < 1000; depth++) {
    const node = byId.get(cur);
    if (!node || node.kind !== "structure.function" || node.attrs.anonymous !== true || node.parent === undefined) return cur;
    cur = node.parent;
  }
  return cur;
}

/** The anonymous functions each owner holds, directly or through other anonymous functions. Memoized per model. */
const ownedMemo = new WeakMap<ProjectModel, Map<NodeId, NodeId[]>>();
export function anonymousOwned(model: ProjectModel): Map<NodeId, NodeId[]> {
  const hit = ownedMemo.get(model);
  if (hit) return hit;
  const owned = new Map<NodeId, NodeId[]>();
  for (const fn of model.functions) {
    if (!fn.anonymous) continue;
    const owner = ownerOf(model.byId, fn.id);
    if (owner === fn.id) continue;
    const list = owned.get(owner);
    if (list) list.push(fn.id);
    else owned.set(owner, [fn.id]);
  }
  ownedMemo.set(model, owned);
  return owned;
}

export function basename(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? path : path.slice(slash + 1);
}

export function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
