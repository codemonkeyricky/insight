import type { IRNode, NodeId } from "@insight/ir";
import type { ProjectModel, Rel, RelKind } from "./model.js";
import type { ScopeView } from "./view.js";

/**
 * One row of a function's reverse-reference lists. Rows with the same `id` and `kind` are one row, with `count` of
 * the relations between them. `file` and `line` locate the row's function (its definition). A row for a file (module-level
 * code that calls or references the function) names the file, and its line is the first call site.
 */
export interface RefRow {
  id: NodeId;
  name: string;
  file: string;
  line: number;
  /** True when the row is a function. A file row (module-level code) and any other node are not. */
  isFunction: boolean;
  kind: RelKind;
  /** The edge's `how`, from the first relation of the row, when the edge has one. */
  how?: string;
  /** True when every relation of the row is a candidate of a candidate set. */
  candidate: boolean;
  count: number;
  /** True when the row's function, or file, lies in the view. */
  inScope: boolean;
}

/** The two reverse-reference lists of a function, across the whole project. */
export interface Refs {
  /** What calls or references the function. Anonymous callers count as their parent (see docs/scoped-ir.md). */
  calledBy: RefRow[];
  /** What the function calls or references. Calls from its anonymous functions count as its own. */
  calls: RefRow[];
}

/**
 * The reverse references of a function, over the whole project. The view decides only `inScope`: the lists themselves
 * come from the project model, so a function's callers outside the scope are listed too. An id the model does not hold
 * has no references.
 */
export function refsOf(view: ScopeView, id: NodeId): Refs {
  const { model } = view;
  if (!model.byId.has(id)) return { calledBy: [], calls: [] };
  const owned = anonymousOwned(model);

  const callers = (model.in.get(id) ?? []).map((rel): { rel: Rel; other: NodeId; label?: string } => {
    // A spawn is not a function: its caller is the function (or file) that starts the thread, labelled with the API.
    const src = model.byId.get(rel.from);
    if (src !== undefined && (src.kind === "concurrency.spawn-thread" || src.kind === "concurrency.spawn-process") && src.parent !== undefined) {
      const api = typeof src.attrs.api === "string" ? src.attrs.api : "thread";
      return { rel, other: ownerOf(model.byId, src.parent), label: `spawns ${api}` };
    }
    return { rel, other: ownerOf(model.byId, rel.from) };
  });
  const callees = [id, ...(owned.get(id) ?? [])].flatMap((src) => (model.out.get(src) ?? []).map((rel) => ({ rel, other: rel.to })));

  return {
    calledBy: rowsOf(view, callers).sort(order),
    calls: rowsOf(view, callees).sort(order),
  };
}

/** Collapses the relations into one row per (function, kind), with the count and the first site. */
function rowsOf(view: ScopeView, items: Array<{ rel: Rel; other: NodeId; label?: string }>): RefRow[] {
  const groups = new Map<string, { row: RefRow; site?: { file: string; line: number } }>();
  for (const { rel, other, label } of items) {
    const key = `${other}\0${rel.kind}\0${label ?? ""}`;
    const site = rel.edge.span ? { file: rel.edge.span.file, line: rel.edge.span.start[0] + 1 } : undefined;
    const group = groups.get(key);
    if (group) {
      group.row.count++;
      group.row.candidate &&= rel.candidate;
      if (site && (!group.site || site.file < group.site.file || (site.file === group.site.file && site.line < group.site.line))) group.site = site;
      continue;
    }
    const row = describe(view, other, rel.kind);
    if (label !== undefined) row.name = `${row.name} · ${label}`;
    row.count = 1;
    row.candidate = rel.candidate;
    if (rel.how !== undefined) row.how = rel.how;
    groups.set(key, { row, ...(site ? { site } : {}) });
  }
  return [...groups.values()].map(({ row, site }) => {
    if (row.file === "" && site) {
      row.file = site.file;
      row.line = site.line;
    }
    if (row.line === 0 && site) row.line = site.line;
    return row;
  });
}

/** The row for one node, before its count and site. A file row takes its line from the first site. */
function describe(view: ScopeView, id: NodeId, kind: RelKind): RefRow {
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
function order(a: RefRow, b: RefRow): number {
  if (a.inScope !== b.inScope) return a.inScope ? -1 : 1;
  return cmp(a.file, b.file) || a.line - b.line || cmp(a.name, b.name) || cmp(a.id, b.id) || cmp(a.kind, b.kind);
}

/**
 * The function (or file) an anonymous function's references belong to: its nearest named parent, walking up through
 * anonymous functions. A node that is not anonymous is its own owner.
 */
function ownerOf(byId: ReadonlyMap<NodeId, IRNode>, id: NodeId): NodeId {
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
function anonymousOwned(model: ProjectModel): Map<NodeId, NodeId[]> {
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

function basename(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? path : path.slice(slash + 1);
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
