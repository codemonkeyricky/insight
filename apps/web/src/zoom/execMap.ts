// The execution canvas's pure half: how an exec scene's nodes are drawn, which node a URL names, the focus strings that
// carry the scope, what a selected function is, and the map for a focus. ExecStore (execStore.ts) loads the models and
// layouts and hands them here.
import {
  NO_RUNTIME_GROUP,
  execThreadId,
  placeSceneEdges,
  placeSceneLayout,
  sceneBreadcrumb,
  sceneDepth,
  sceneOpenFor,
  type ExecFunctionRef,
  type ExecModel,
  type ExecRuntime,
  type ExecThread,
  type Scene,
  type SceneLayout,
  type SceneNode,
} from "@insight/flow";
import type { MapBuild, MapNode, MapSelected } from "./source";

/** File colour bands, in the order files are listed. Matches --band-0 .. --band-5 in styles.css. */
export const BANDS = 6;

/** The separator between a scope and a node id in a focus. A path cannot hold it. */
const FOCUS_SEP = "\u0001";

/** A focus: the scope and the node. Node ids are unique only within one scope's scene, so the scope rides along. */
export function execFocus(scope: string, nodeId: string): string {
  return `${scope}${FOCUS_SEP}${nodeId}`;
}

/** The scope and node a focus names. A focus with no separator is a node id in the project scope. */
export function splitExecFocus(focus: string): { scope: string; nodeId: string } {
  const at = focus.indexOf(FOCUS_SEP);
  if (at === -1) return { scope: "", nodeId: focus };
  return { scope: focus.slice(0, at), nodeId: focus.slice(at + FOCUS_SEP.length) };
}

/** A band for each file group of the scene, by its path (the note), in path order. */
export function execFileBands(scene: Scene, bands = BANDS): Map<string, number> {
  const paths = new Set<string>();
  for (const n of scene.nodes.values()) if (n.kind === "file") paths.add(n.note ?? n.label);
  const out = new Map<string, number>();
  [...paths].sort().forEach((p, i) => out.set(p, i % Math.max(1, bands)));
  return out;
}

/** A scene node as the map draws it. Undefined for an id that is not in the scene. */
export function execMapNode(scene: Scene, id: string, bands?: ReadonlyMap<string, number>): MapNode | undefined {
  const n = scene.nodes.get(id);
  if (n === undefined) return undefined;
  const node: MapNode = { id, kind: n.kind, label: n.label, title: n.note ?? n.label };
  if (n.detail !== undefined) node.detail = n.detail;
  if (n.parent !== undefined) node.parent = n.parent;
  if (n.kind === "file") {
    const band = bands?.get(n.note ?? n.label);
    if (band !== undefined) node.band = band;
  }
  return node;
}

/** The node a URL's function names: the first node (in scene order) that draws it, else the root. */
export function execResolve(scene: Scene, fn?: string): string {
  if (fn !== undefined) {
    for (const n of scene.nodes.values()) if (n.ref === fn) return n.id;
  }
  return scene.root;
}

/** The URL that shows a node: the scope, and the function a function box draws. */
export function execUrl(scene: Scene, scope: string, nodeId: string): { scope: string; fn?: string } | undefined {
  const n = scene.nodes.get(nodeId);
  if (n === undefined) return undefined;
  return n.kind === "function" && n.ref !== undefined ? { scope, fn: n.ref } : { scope };
}

interface Where {
  runtime: "thread" | "coroutine" | "none";
  thread?: string;
  coroutine?: string;
}

/**
 * Where a node runs: the nearest thread above it, and the nearest coroutine between the two. A node in the no-runtime
 * group, or with no thread above it, runs nowhere.
 */
function whereOf(scene: Scene, nodeId: string): Where {
  let coroutine: string | undefined;
  for (let cur = scene.nodes.get(nodeId)?.parent; cur !== undefined; cur = scene.nodes.get(cur)?.parent) {
    const n: SceneNode | undefined = scene.nodes.get(cur);
    if (n === undefined || n.id === NO_RUNTIME_GROUP) break;
    if (n.kind === "coroutine" && coroutine === undefined) coroutine = n.label;
    if (n.kind === "thread") {
      return coroutine === undefined ? { runtime: "thread", thread: n.label } : { runtime: "coroutine", thread: n.label, coroutine };
    }
  }
  return { runtime: "none" };
}

/** A placement's link text: "Main thread", "Main thread in coroutine handle", or the no-runtime group. */
function placeLabel(w: Where): string {
  if (w.runtime === "none") return "No runtime context";
  return w.runtime === "coroutine" ? `${w.thread} in coroutine ${w.coroutine}` : (w.thread ?? "");
}

/**
 * What a function focus shows: the function (from the model), where its node runs, and every other node that draws the
 * same function. Undefined for a node that is not a function.
 */
export function execSelected(scene: Scene, fns: ReadonlyMap<string, ExecFunctionRef>, nodeId: string): MapSelected | undefined {
  const n = scene.nodes.get(nodeId);
  if (n === undefined || n.kind !== "function" || n.ref === undefined) return undefined;
  const f = fns.get(n.ref);
  const w = whereOf(scene, nodeId);
  const out: MapSelected = {
    ref: n.ref,
    name: f?.name ?? n.label,
    file: f?.file ?? "",
    line: f?.line ?? 0,
    runtime: w.runtime,
    placements: [],
  };
  if (w.thread !== undefined) out.thread = w.thread;
  if (w.coroutine !== undefined) out.coroutine = w.coroutine;
  if (n.note !== undefined) out.note = n.note;
  for (const other of scene.nodes.values()) {
    if (other.kind !== "function" || other.ref !== n.ref || other.id === nodeId) continue;
    out.placements.push({ nodeId: other.id, label: placeLabel(whereOf(scene, other.id)) });
  }
  return out;
}

/**
 * The map of a laid-out scene for a node: the node and its ancestors open, everything else closed. `fns` (the model's
 * functions by id) adds what the function panel shows for a function node.
 */
export function execBuild(scene: Scene, layout: SceneLayout, scope: string, nodeId: string, fns?: ReadonlyMap<string, ExecFunctionRef>): MapBuild {
  const open = sceneOpenFor(scene, nodeId);
  const placed = placeSceneLayout(scene, layout, open);
  const edges = placeSceneEdges(scene, open, placed.rects);
  const bands = execFileBands(scene);
  const node = (id: string) => execMapNode(scene, id, bands);
  const out: MapBuild = {
    focus: execFocus(scope, nodeId),
    nodeId,
    path: scope,
    placed,
    edges,
    node,
    depth: (id) => sceneDepth(scene, id),
    crumbs: sceneBreadcrumb(scene, nodeId).flatMap((n) => node(n.id) ?? []),
  };
  const selected = fns === undefined ? undefined : execSelected(scene, fns, nodeId);
  if (selected !== undefined) out.selected = selected;
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// The panels' lists: calls, the trail, chips and the per-function table. Each is computed from one scope's scene and
// model (an ExecIndex, built once per scope), so the panels only render what these return.
// ---------------------------------------------------------------------------------------------------------------------

/** Most links one Calls or Called by list shows. The rest are counted in `more`. */
export const CALL_LIST_MAX = 50;
/** Most chips a container shows. The rest are counted in `more`. */
export const CHIP_MAX = 60;

/** Code-unit order, the same in every locale. */
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** A function as a link. `nodeId` is the placement the link opens; undefined when the scene does not draw the function. */
export interface ExecLink {
  id: string;
  name: string;
  /** "" for a function the IR has no source for. */
  file: string;
  /** 1-based line of the definition; 0 when there is no source. */
  line: number;
  nodeId?: string;
}

/** A list of links, cut at a cap. `more` counts the links past it. */
export interface ExecLinkList {
  items: ExecLink[];
  more: number;
}

/** One place a function is drawn: its scene node, the thread (or no-runtime group) above it, and how deep it sits. */
export interface ExecPlacement {
  nodeId: string;
  /** The thread's scene id, or NO_RUNTIME_GROUP. "" when no thread or group is above the node. */
  thread: string;
  /** Ancestors above the node. A placement directly in its thread is shallower than one in a coroutine or a file group. */
  depth: number;
}

/** What the panels read from one scope: its scene, its model's functions and threads, and the calls between functions. */
export interface ExecIndex {
  scene: Scene;
  fns: ReadonlyMap<string, ExecFunctionRef>;
  threads: ReadonlyMap<string, ExecThread>;
  /** The functions each function calls, distinct, by name then id. */
  callees: ReadonlyMap<string, readonly string[]>;
  /** The functions that call each function, distinct, by name then id. */
  callers: ReadonlyMap<string, readonly string[]>;
  /** Each function's placements in the scene, by node id. */
  placements: ReadonlyMap<string, readonly ExecPlacement[]>;
}

/** The thread (its scene id) a node runs on, or the no-runtime group. Undefined for a node that runs nowhere. */
export function execThreadKeyOf(scene: Scene, nodeId: string): string | undefined {
  let cur: string | undefined = nodeId;
  while (cur !== undefined) {
    const n: SceneNode | undefined = scene.nodes.get(cur);
    if (n === undefined) return undefined;
    if (n.kind === "thread" || n.id === NO_RUNTIME_GROUP) return n.id;
    cur = n.parent;
  }
  return undefined;
}

function depthIn(scene: Scene, nodeId: string): number {
  let d = 0;
  for (let cur = scene.nodes.get(nodeId)?.parent; cur !== undefined; cur = scene.nodes.get(cur)?.parent) d++;
  return d;
}

/** Builds the index of one scope. Pure: the same scene and model give the same index. */
export function execIndex(scene: Scene, model: ExecModel): ExecIndex {
  const fns = new Map<string, ExecFunctionRef>();
  for (const f of model.functions) fns.set(f.id, f);
  const nameOf = (id: string): string => fns.get(id)?.name ?? id;
  const byName = (x: string, y: string): number => cmp(nameOf(x), nameOf(y)) || cmp(x, y);

  const calleeSets = new Map<string, Set<string>>();
  const callerSets = new Map<string, Set<string>>();
  const add = (m: Map<string, Set<string>>, k: string, v: string): void => {
    const s = m.get(k);
    if (s === undefined) m.set(k, new Set([v]));
    else s.add(v);
  };
  for (const [i, j] of model.calls) {
    const a = model.functions[i];
    const b = model.functions[j];
    if (a === undefined || b === undefined) continue;
    add(calleeSets, a.id, b.id);
    add(callerSets, b.id, a.id);
  }
  const sorted = (m: Map<string, Set<string>>): Map<string, readonly string[]> =>
    new Map([...m].map(([k, s]): [string, string[]] => [k, [...s].sort(byName)]));

  const placements = new Map<string, ExecPlacement[]>();
  for (const n of scene.nodes.values()) {
    if (n.kind !== "function" || n.ref === undefined) continue;
    const list = placements.get(n.ref) ?? [];
    list.push({ nodeId: n.id, thread: execThreadKeyOf(scene, n.id) ?? "", depth: depthIn(scene, n.id) });
    placements.set(n.ref, list);
  }
  for (const list of placements.values()) list.sort((a, b) => cmp(a.nodeId, b.nodeId));

  return {
    scene,
    fns,
    threads: new Map(model.threads.map((t): [string, ExecThread] => [execThreadId(t.id), t])),
    callees: sorted(calleeSets),
    callers: sorted(callerSets),
    placements,
  };
}

/**
 * The node a link to `fnId` opens: its placement in the thread (or group) `threadKey`, the shallowest one there when it
 * has several, else its first placement by node id. Undefined when the scene does not draw the function.
 */
export function execPlacementFor(index: ExecIndex, fnId: string, threadKey?: string): string | undefined {
  const list = index.placements.get(fnId);
  if (list === undefined || list.length === 0) return undefined;
  let best: ExecPlacement | undefined;
  if (threadKey !== undefined) {
    for (const p of list) if (p.thread === threadKey && (best === undefined || p.depth < best.depth)) best = p;
  }
  return (best ?? list[0])?.nodeId;
}

function linkOf(index: ExecIndex, fnId: string, threadKey?: string): ExecLink {
  const f = index.fns.get(fnId);
  const link: ExecLink = { id: fnId, name: f?.name ?? fnId, file: f?.file ?? "", line: f?.line ?? 0 };
  const nodeId = execPlacementFor(index, fnId, threadKey);
  if (nodeId !== undefined) link.nodeId = nodeId;
  return link;
}

function capped(index: ExecIndex, ids: readonly string[], threadKey: string | undefined, cap: number): ExecLinkList {
  return { items: ids.slice(0, cap).map((id) => linkOf(index, id, threadKey)), more: Math.max(0, ids.length - cap) };
}

export interface ExecCallLists {
  /** The functions the focused function calls. */
  calls: ExecLinkList;
  /** The functions that call the focused function. */
  calledBy: ExecLinkList;
}

/**
 * The Calls and Called by lists of a function placement. A link opens the callee's (or caller's) placement in the same
 * thread as the focused placement, else its first placement. Empty lists for a node that is not a function.
 */
export function execCallLists(index: ExecIndex, nodeId: string, cap = CALL_LIST_MAX): ExecCallLists {
  const fnId = index.scene.nodes.get(nodeId)?.ref;
  if (fnId === undefined) return { calls: { items: [], more: 0 }, calledBy: { items: [], more: 0 } };
  const threadKey = execThreadKeyOf(index.scene, nodeId);
  return {
    calls: capped(index, index.callees.get(fnId) ?? [], threadKey, cap),
    calledBy: capped(index, index.callers.get(fnId) ?? [], threadKey, cap),
  };
}

/** How many distinct functions a function calls, and how many call it, within the model. */
export function execDegrees(index: ExecIndex, fnId: string): { calls: number; calledBy: number } {
  return { calls: index.callees.get(fnId)?.length ?? 0, calledBy: index.callers.get(fnId)?.length ?? 0 };
}

/**
 * The shortest call path from a root of the focused placement's thread to the function, the function last. Calls count
 * only between the thread's functions (its reached ones); an await of a coroutine is a step from each function that
 * dispatches it to the coroutine's target. Ties go to the smaller ids, so the path is the same whatever the order.
 * Undefined for a node that is not a function, for a function on no thread (the no-runtime group), or when no path
 * exists. A root's trail is the root alone.
 */
export function execTrail(index: ExecIndex, nodeId: string): ExecLink[] | undefined {
  const node = index.scene.nodes.get(nodeId);
  const target = node?.ref;
  if (node === undefined || node.kind !== "function" || target === undefined) return undefined;
  const threadKey = execThreadKeyOf(index.scene, nodeId);
  if (threadKey === undefined || threadKey === NO_RUNTIME_GROUP) return undefined;
  const thread = index.threads.get(threadKey);
  if (thread === undefined) return undefined;

  const inThread = new Set<string>([...thread.reached, ...thread.roots, target].filter((id) => index.fns.has(id)));
  const adj = new Map<string, string[]>();
  const step = (from: string, to: string): void => {
    const next = adj.get(from);
    if (next === undefined) adj.set(from, [to]);
    else next.push(to);
  };
  for (const a of inThread) for (const b of index.callees.get(a) ?? []) if (inThread.has(b)) step(a, b);
  for (const co of thread.coroutines) {
    if (!inThread.has(co.target)) continue;
    for (const d of co.dispatchedBy) if (d !== co.target && inThread.has(d)) step(d, co.target);
  }
  for (const next of adj.values()) next.sort(cmp);

  const roots = [...new Set(thread.roots)].filter((r) => inThread.has(r)).sort(cmp);
  const prev = new Map<string, string | null>();
  const queue: string[] = [];
  for (const r of roots) {
    prev.set(r, null);
    queue.push(r);
  }
  for (let i = 0; i < queue.length && !prev.has(target); i++) {
    const cur = queue[i];
    if (cur === undefined) break;
    for (const nx of adj.get(cur) ?? []) {
      if (prev.has(nx)) continue;
      prev.set(nx, cur);
      queue.push(nx);
    }
  }
  if (!prev.has(target)) return undefined;

  const path: string[] = [];
  for (let cur: string | null | undefined = target; cur !== null && cur !== undefined; cur = prev.get(cur)) path.unshift(cur);
  return path.map((id, i) => {
    const link = linkOf(index, id, threadKey);
    if (i === path.length - 1) link.nodeId = nodeId;
    return link;
  });
}

/** The scene nodes of the functions a container holds: its function children, and those inside its file groups. */
export function execChildFunctions(scene: Scene, nodeId: string): string[] {
  const out: string[] = [];
  for (const c of scene.nodes.get(nodeId)?.children ?? []) {
    const child = scene.nodes.get(c);
    if (child === undefined) continue;
    if (child.kind === "function") out.push(child.id);
    else if (child.kind === "file") {
      for (const g of child.children) if (scene.nodes.get(g)?.kind === "function") out.push(g);
    }
  }
  return out;
}

/** One pill of a container: a function and the placement the pill opens (the function's node in the container). */
export interface ExecChip {
  nodeId: string;
  id: string;
  name: string;
}

/** The pills of a container's functions, in the scene's order, cut at the cap. */
export function execChips(scene: Scene, nodeId: string, cap = CHIP_MAX): { items: ExecChip[]; more: number } {
  const ids = execChildFunctions(scene, nodeId);
  const items = ids.slice(0, cap).map((id): ExecChip => {
    const n = scene.nodes.get(id);
    return { nodeId: id, id: n?.ref ?? id, name: n?.label ?? id };
  });
  return { items, more: Math.max(0, ids.length - cap) };
}

/** How a function runs, in words for the table. */
export const RUNTIME_WORD: Record<ExecRuntime, string> = { thread: "Thread", coroutine: "Coroutine only", none: "No runtime" };

/** One row of the per-function table. The flow counts are present only when the scope's flow was given and lists the function. */
export interface ExecRow {
  nodeId: string;
  id: string;
  name: string;
  file: string;
  line: number;
  runtime: ExecRuntime;
  calls: number;
  calledBy: number;
  steps?: number;
  decisions?: number;
  loops?: number;
}

/** A function's flow counts, from the scope flow's function row. */
export interface ExecFlowCounts {
  steps: number;
  decisions: number;
  loops: number;
}

/** The table of a container's functions: one row each, in the scene's order. */
export function execRows(index: ExecIndex, nodeId: string, flow?: ReadonlyMap<string, ExecFlowCounts>): ExecRow[] {
  return execChildFunctions(index.scene, nodeId).map((placement): ExecRow => {
    const id = index.scene.nodes.get(placement)?.ref ?? placement;
    const f = index.fns.get(id);
    const d = execDegrees(index, id);
    const row: ExecRow = {
      nodeId: placement,
      id,
      name: f?.name ?? index.scene.nodes.get(placement)?.label ?? id,
      file: f?.file ?? "",
      line: f?.line ?? 0,
      runtime: f?.runtime ?? "thread",
      calls: d.calls,
      calledBy: d.calledBy,
    };
    const counts = flow?.get(id);
    if (counts !== undefined) {
      row.steps = counts.steps;
      row.decisions = counts.decisions;
      row.loops = counts.loops;
    }
    return row;
  });
}

/** The columns a table can sort by. */
export type ExecSortKey = "name" | "location" | "runtime" | "calls" | "calledBy" | "steps" | "decisions" | "loops";

/** The columns that sort by a number. */
const NUMERIC_SORT: ReadonlySet<ExecSortKey> = new Set<ExecSortKey>(["calls", "calledBy", "steps", "decisions", "loops"]);

function numberOf(r: ExecRow, key: ExecSortKey): number | undefined {
  switch (key) {
    case "calls":
      return r.calls;
    case "calledBy":
      return r.calledBy;
    case "steps":
      return r.steps;
    case "decisions":
      return r.decisions;
    case "loops":
      return r.loops;
    default:
      return undefined;
  }
}

/**
 * The rows in the order a column gives. Rows with no value for a numeric column (a flow count the scope lacks) go last in
 * either direction. Ties go to the row's id, so the order is the same however the rows came.
 */
export function sortExecRows(rows: readonly ExecRow[], key: ExecSortKey, dir: 1 | -1): ExecRow[] {
  return [...rows].sort((a, b) => {
    if (NUMERIC_SORT.has(key)) {
      const x = numberOf(a, key);
      const y = numberOf(b, key);
      if (x === undefined || y === undefined) return x === y ? cmp(a.id, b.id) : x === undefined ? 1 : -1;
      return (x - y) * dir || cmp(a.id, b.id);
    }
    const c = key === "location" ? cmp(a.file, b.file) || a.line - b.line : key === "name" ? cmp(a.name, b.name) : cmp(a.runtime, b.runtime);
    return c * dir || cmp(a.id, b.id);
  });
}
