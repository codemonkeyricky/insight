// The zoom map's expansions: a function's control-flow chart drawn in a box beside the map. An expansion is anchored to a
// function box on the map, or to a call step in another expansion's chart, and sits to the right of its anchor. The
// layout never depends on expansions (a function box keeps its compact size), so everything here is placement: where
// each expansion goes, how a chain follows its parent, what closes with what, and how the camera shows a new one. Pure,
// so these rules are unit tested (test/expand.test.ts).
import { CHART_FIT_MAX_K, CHART_HEAD, CHART_PAD, relayout, type Camera, type FunctionFlow, type InlineEntry, type InlineTree, type Rect } from "@insight/flow";
import { zoneLetter } from "./zones";

/** The room between an anchor and the expansion beside it. */
export const EXPAND_GAP = 40;
/** The top of an expansion stays at least this far above the view's bottom edge: two header heights. */
const HEAD_ROOM = 2 * CHART_HEAD;
/**
 * The room a slotted map keeps around an expansion: above it for an async frame's label, and past its right and bottom
 * edges for the frame's padding. The frame is drawn SLOT_PAD outside the expansion.
 */
export const SLOT_TOP = 16;
export const SLOT_PAD = 8;
/** The room a reveal keeps between an expansion and the stage's edges. */
const REVEAL_MARGIN = 16;

/**
 * What an expansion hangs from. A box is a function's box on the map, with its placed rect. A step is a call step in
 * the chart of the expansion of `fnId`, with the step's rect in that chart's units (its top-left is the chart's origin
 * plus this rect's corner).
 */
export type ExpandAnchor =
  | { kind: "box"; nodeId: string; rect: Rect; /** The expansion replaces the card in its own slot (a roots-only card), instead of opening beside it. */ inPlace?: boolean }
  | { kind: "step"; fnId: string; rect: Rect; stepId?: string };

/** The kind of box a thread or process step opens: its header names the runtime ("Worker · print.worker"). */
export interface ExpansionRuntime {
  kind: "thread" | "process";
  label: string;
}

/** One open expansion. Identity is the function: a function has at most one expansion open. */
export interface Expansion {
  fnId: string;
  anchor: ExpandAnchor;
  /** The chart as drawn: `base` with the callees of `inline` nested in their call steps. */
  chart: FunctionFlow;
  /** The function's own chart, before any call is nested in it. Absent when nothing was ever nested (then it is `chart`). */
  base?: FunctionFlow;
  /** The calls drawn nested in this box's chart, as a tree by step id (see relayout). */
  inline?: InlineTree;
  /** Set when the box runs on another thread or in another process than the box it was opened from. */
  runtime?: ExpansionRuntime;
  /** The top-left corner and size of the box, in world units. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** The detail's letter: its index in open order (0 is A). Unique among the open expansions. */
  index: number;
  /**
   * The x (world units, before any shift) the columns to the right of this detail slide from: the right edge of the
   * function box its chain starts at. A call step's detail shares its parent's pivot, so a chain slides as one.
   */
  pivot: number;
}

/** The letter of a detail: A, B, C ... in open order (see Expansion.index). */
export function detailLetter(index: number): string {
  return zoneLetter(index);
}

/**
 * How far an item at `placed` (its rect, or an edge point as {x}) moves when a detail of width `width` opens at `pivotX`:
 * nothing at or left of the pivot, and the detail's width plus the gap to the right of it, so the columns slide over and
 * the detail fits in the room they leave.
 */
export function shiftOf(placed: { x: number }, pivotX: number, width: number): number {
  return placed.x > pivotX ? width + EXPAND_GAP : 0;
}

/** The total shift an item at x moves by, summed over every open expansion (a chain's details add up). */
export function shiftAt(list: readonly Expansion[], x: number): number {
  let dx = 0;
  for (const e of list) dx += shiftOf({ x }, e.pivot, e.w);
  return dx;
}

/** The size of an expansion box that holds a chart of `chart`'s natural size, with its header and padding. */
export function expansionSize(chart: { width: number; height: number }): { w: number; h: number } {
  return { w: chart.width + 2 * CHART_PAD, h: CHART_HEAD + CHART_PAD + chart.height + CHART_PAD };
}

/** The corner a chart is drawn at inside an expansion: under the header, inset by the padding. */
export function contentOrigin(e: { x: number; y: number }): { x: number; y: number } {
  return { x: e.x + CHART_PAD, y: e.y + CHART_HEAD + CHART_PAD };
}

/** The world rect of a step of an expansion's chart: the step's rect in chart units, moved to the chart's place in the box. */
export function stepRect(e: Expansion, nodeId: string): Rect | undefined {
  const n = e.chart.nodes.find((x) => x.id === nodeId);
  if (n === undefined) return undefined;
  const o = contentOrigin(e);
  return { x: o.x + n.x, y: o.y + n.y, w: n.w, h: n.h };
}

/**
 * The top of an expansion whose anchor is at `desired`, kept on the view: its header never starts below the view's bottom
 * edge less two header heights, so an expansion opened low on the map is pulled up into view. Clamped once, when it is
 * placed, so a later pan does not move it. In a slotted map (`view` undefined) the room is the layout's, so no clamp.
 */
export function clampTop(desired: number, view: Rect | undefined): number {
  return view === undefined ? desired : Math.min(desired, view.y + view.h - HEAD_ROOM);
}

/** Where an expansion beside a function box goes: right of the box, top level with the box's top (see clampTop). */
export function placeOnBox(rect: Rect, view: Rect | undefined): { x: number; y: number } {
  return { x: rect.x + rect.w + EXPAND_GAP, y: view === undefined ? rect.y + SLOT_TOP : clampTop(rect.y, view) };
}

/**
 * Where a call step's expansion goes: right of the expansion the step is in, top level with the step (see clampTop).
 * `rect` is the step in its parent's chart units.
 */
export function placeOnStep(parent: Expansion, rect: Rect, view: Rect | undefined): { x: number; y: number } {
  return { x: parent.x + parent.w + EXPAND_GAP, y: clampTop(contentOrigin(parent).y + rect.y, view) };
}

/**
 * Places every expansion from its anchor, each parent before the children it holds. An expansion whose parent is not in
 * the list is dropped with its chain. The list's order is kept. A box's detail takes the box's right edge as its pivot; a
 * step's detail takes its parent's pivot.
 */
export function reflow(list: readonly Expansion[], view: Rect | undefined): Expansion[] {
  const byFn = new Map(list.map((e) => [e.fnId, e] as const));
  const placed = new Map<string, Expansion>();
  const place = (e: Expansion, hops: number): Expansion | undefined => {
    const done = placed.get(e.fnId);
    if (done !== undefined) return done;
    if (hops > list.length) return undefined;
    let at: { x: number; y: number; pivot: number };
    // A slotted map's expansions never shift the columns: the layout keeps their room, so the pivot is past every box.
    const pivotOf = (p: number) => (view === undefined ? Infinity : p);
    if (e.anchor.kind === "box") {
      // An in-place expansion takes the card's own top-left corner: it is the card, grown.
      const where = e.anchor.inPlace === true ? { x: e.anchor.rect.x, y: e.anchor.rect.y } : placeOnBox(e.anchor.rect, view);
      at = { ...where, pivot: pivotOf(e.anchor.rect.x + e.anchor.rect.w) };
    } else {
      const parent = byFn.get(e.anchor.fnId);
      const from = parent === undefined ? undefined : place(parent, hops + 1);
      if (from === undefined) return undefined;
      at = { ...placeOnStep(from, e.anchor.rect, view), pivot: pivotOf(from.pivot) };
    }
    const out: Expansion = { ...e, ...at };
    placed.set(e.fnId, out);
    return out;
  };
  return list.flatMap((e) => {
    const p = place(e, 0);
    return p === undefined ? [] : [p];
  });
}

/**
 * The list after the map is drawn for a new build. A box's anchor takes the box's rect in the new build (`rectOf`), and an
 * expansion whose box is no longer drawn is dropped, with the chain it holds. Everything is placed again on `view`.
 */
export function refresh(list: readonly Expansion[], rectOf: (nodeId: string) => Rect | undefined, view: Rect | undefined): Expansion[] {
  const kept: Expansion[] = [];
  for (const e of list) {
    if (e.anchor.kind !== "box") {
      kept.push(e);
      continue;
    }
    const rect = rectOf(e.anchor.nodeId);
    if (rect !== undefined) kept.push({ ...e, anchor: { ...e.anchor, rect } });
  }
  return reflow(kept, view);
}

/** True when `target` is `from`, or an expansion `from` is chained from, through step anchors. Opening it would cycle. */
function chainHas(list: readonly Expansion[], from: string, target: string): boolean {
  let cur: string | undefined = from;
  for (let hops = 0; cur !== undefined && hops <= list.length; hops++) {
    if (cur === target) return true;
    const e = list.find((x) => x.fnId === cur);
    cur = e?.anchor.kind === "step" ? e.anchor.fnId : undefined;
  }
  return false;
}

/**
 * The list after `fnId`'s expansion opens at `anchor`, drawing `chart`. An expansion that is already open is reattached:
 * its anchor moves and the chains from it follow, so a function never has two. The new one is last, so Escape closes it
 * first. Returns `list` itself when the anchor is inside `fnId`'s own chain, which would cycle.
 */
export function openExpansion(list: readonly Expansion[], fnId: string, anchor: ExpandAnchor, chart: FunctionFlow, view: Rect | undefined, runtime?: ExpansionRuntime): Expansion[] {
  if (anchor.kind === "step" && chainHas(list, anchor.fnId, fnId)) return list as Expansion[];
  const size = expansionSize(chart);
  const others = list.filter((e) => e.fnId !== fnId);
  // A reattached expansion keeps its letter; a new one takes the next letter after the highest one open.
  const kept = list.find((e) => e.fnId === fnId);
  const index = kept?.index ?? others.reduce((hi, e) => Math.max(hi, e.index + 1), 0);
  return reflow([...others, { fnId, anchor, chart, ...(runtime !== undefined ? { runtime } : {}), ...size, x: 0, y: 0, index, pivot: 0 }], view);
}

/** The node ids of a nested step's path: "n5/n7" is the call n7 inside the frame n5. */
const pathOf = (nodeId: string): string[] => nodeId.split("/");

/** The tree with the entry at `path` replaced by `entry` (removed when undefined). Undefined when the path leads nowhere. */
function withEntry(tree: InlineTree | undefined, path: readonly string[], entry: InlineEntry | undefined): InlineTree | undefined {
  const [head, ...rest] = path;
  if (head === undefined) return tree;
  const next = new Map(tree ?? []);
  if (rest.length === 0) {
    if (entry === undefined) next.delete(head);
    else next.set(head, entry);
    return next;
  }
  const cur = next.get(head);
  if (cur === undefined) return undefined;
  const inner = withEntry(cur.inline, rest, entry);
  if (inner === undefined) return undefined;
  next.set(head, { ...cur, inline: inner });
  return next;
}

/**
 * The function whose own chart holds the step `nodeId`: the expansion's function, or the callee of the innermost frame the
 * step is drawn in. Undefined `e` gives "".
 */
export function ownerOf(e: Expansion | undefined, nodeId: string): string {
  if (e === undefined) return "";
  let owner = e.fnId;
  let tree = e.inline;
  for (const seg of pathOf(nodeId).slice(0, -1)) {
    const entry = tree?.get(seg);
    if (entry === undefined) break;
    owner = entry.flow.id;
    tree = entry.inline;
  }
  return owner;
}

/** Whether the call step `nodeId` of an expansion's chart is drawn nested. */
export function isNested(e: Expansion, nodeId: string): boolean {
  return e.chart.nodes.some((n) => n.id === nodeId && (n.shape === "nest" || n.shape === "fork"));
}

/**
 * The list after the call step `nodeId` of `fnId`'s chart is nested (`callee` given: the callee's chart goes inside the
 * step) or folded back (`callee` undefined: the step and every call nested in it close). The box takes the new chart's
 * size, and the boxes anchored to its steps follow their steps, or close when the step is folded away. Returns `list`
 * itself when nothing changes: no such step, a callee that cannot nest (it is already in the chain, or the chart would
 * be too large), or a step that is not nested.
 */
export function setInline(list: readonly Expansion[], fnId: string, nodeId: string, callee: FunctionFlow | undefined, view: Rect | undefined, runtime?: ExpansionRuntime): Expansion[] {
  const e = list.find((x) => x.fnId === fnId);
  if (e === undefined) return list as Expansion[];
  const base = e.base ?? e.chart;
  const tree = withEntry(e.inline, pathOf(nodeId), callee === undefined ? undefined : { flow: callee, ...(runtime !== undefined ? { runtime } : {}) });
  if (tree === undefined || (callee === undefined && !isNested(e, nodeId))) return list as Expansion[];
  const chart = relayout(base, tree);
  if (callee !== undefined && !chart.nodes.some((n) => n.id === nodeId && (n.shape === "nest" || n.shape === "fork"))) return list as Expansion[];
  const resized: Expansion = { ...e, base, inline: tree, chart, ...expansionSize(chart) };
  let out = list.map((x) => (x === e ? resized : x));
  // A box opened from a step of this chart follows the step; one whose step is gone closes with its chain.
  for (const x of out) {
    if (x.anchor.kind !== "step" || x.anchor.fnId !== fnId || x.anchor.stepId === undefined) continue;
    const id = x.anchor.stepId;
    const n = chart.nodes.find((c) => c.id === id);
    if (n === undefined) out = closeExpansion(out, x.fnId);
    else out = out.map((y) => (y === x ? { ...y, anchor: { ...x.anchor, rect: { x: n.x, y: n.y, w: n.w, h: n.h } } } : y));
  }
  return reflow(out, view);
}

/**
 * The room the open expansions take beside each box they hang from, from the box's right edge and top, in world units. It
 * is computed from the charts' sizes and the step anchors alone, so it does not depend on where anything is placed. The
 * layout keeps this room clear (see runtimeRootsLayout), so an opened box never overlaps its neighbours.
 */
export function footprintOf(list: readonly Expansion[]): Map<string, { w: number; h: number }> {
  const byFn = new Map(list.map((e) => [e.fnId, e] as const));
  const rel = new Map<string, { x: number; y: number; root: string }>();
  const place = (e: Expansion, hops: number): { x: number; y: number; root: string } | undefined => {
    const done = rel.get(e.fnId);
    if (done !== undefined) return done;
    if (hops > list.length) return undefined;
    let out: { x: number; y: number; root: string };
    if (e.anchor.kind === "box") {
      // In place, the expansion starts at the card's own left edge and top, so it takes the card's slot and grows from it.
      out = e.anchor.inPlace === true ? { x: -e.anchor.rect.w, y: 0, root: e.anchor.nodeId } : { x: EXPAND_GAP, y: SLOT_TOP, root: e.anchor.nodeId };
    } else {
      const parent = byFn.get(e.anchor.fnId);
      const from = parent === undefined ? undefined : place(parent, hops + 1);
      if (parent === undefined || from === undefined) return undefined;
      out = { x: from.x + parent.w + EXPAND_GAP, y: from.y + CHART_HEAD + CHART_PAD + e.anchor.rect.y, root: from.root };
    }
    rel.set(e.fnId, out);
    return out;
  };
  const room = new Map<string, { w: number; h: number }>();
  for (const e of list) {
    const p = place(e, 0);
    if (p === undefined) continue;
    const cur = room.get(p.root) ?? { w: 0, h: 0 };
    room.set(p.root, { w: Math.max(cur.w, p.x + e.w), h: Math.max(cur.h, p.y + e.h) });
  }
  for (const [root, r] of room) room.set(root, { w: Math.max(0, r.w + SLOT_PAD), h: r.h + SLOT_PAD });
  return room;
}

/** The box an expansion hangs from, through its step anchors: the card the chain opens beside. */
export function rootBoxOf(list: readonly Expansion[], e: Expansion): string | undefined {
  let cur: Expansion | undefined = e;
  for (let hops = 0; cur !== undefined && hops <= list.length; hops++) {
    if (cur.anchor.kind === "box") return cur.anchor.nodeId;
    const parentId: string = cur.anchor.fnId;
    cur = list.find((x) => x.fnId === parentId);
  }
  return undefined;
}

/** Whether two footprints keep the same room for every box. */
export function sameFootprint(a: ReadonlyMap<string, { w: number; h: number }> | undefined, b: ReadonlyMap<string, { w: number; h: number }> | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (a.size !== b.size) return false;
  for (const [k, v] of a) {
    const o = b.get(k);
    if (o === undefined || o.w !== v.w || o.h !== v.h) return false;
  }
  return true;
}

/** The list without `fnId`'s expansion and every expansion chained from it, at any depth. */
export function closeExpansion(list: readonly Expansion[], fnId: string): Expansion[] {
  const gone = new Set([fnId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const e of list) {
      if (e.anchor.kind === "step" && gone.has(e.anchor.fnId) && !gone.has(e.fnId)) {
        gone.add(e.fnId);
        grew = true;
      }
    }
  }
  return list.filter((e) => !gone.has(e.fnId));
}

/** The expansion anchored to a function box, if one is open. */
export function anchoredTo(list: readonly Expansion[], nodeId: string): Expansion | undefined {
  return list.find((e) => e.anchor.kind === "box" && e.anchor.nodeId === nodeId);
}

/** The inset of a callout's expansion-side edge from the expansion's top and bottom: it meets the box inside its rounded corners. */
export const CALLOUT_INSET = 12;

/** A callout's edges in world units, before the side shift: the anchor's right edge with its top and bottom, and the expansion's left edge. */
export interface CalloutGeometry {
  ax: number;
  ayT: number;
  ayB: number;
  ex: number;
  eyT: number;
  eyB: number;
}

/**
 * The callout of an expansion: from its anchor's right edge (a box's rect, or a step's rect in its parent's chart) to the
 * expansion's left edge. Undefined when a step's parent expansion is not open.
 */
export function calloutOf(e: Expansion, list: readonly Expansion[]): CalloutGeometry | undefined {
  // An in-place expansion is the card itself: nothing hangs from it.
  if (e.anchor.kind === "box" && e.anchor.inPlace === true) return undefined;
  const ex = e.x;
  const eyT = e.y + CALLOUT_INSET;
  const eyB = e.y + e.h - CALLOUT_INSET;
  if (e.anchor.kind === "box") {
    const r = e.anchor.rect;
    return { ax: r.x + r.w, ayT: r.y, ayB: r.y + r.h, ex, eyT, eyB };
  }
  const parentId = e.anchor.fnId;
  const parent = list.find((p) => p.fnId === parentId);
  if (parent === undefined) return undefined;
  const o = contentOrigin(parent);
  const r = e.anchor.rect;
  return { ax: o.x + r.x + r.w, ayT: o.y + r.y, ayB: o.y + r.y + r.h, ex, eyT, eyB };
}

/** Moves a span of `size` that starts at `start` inside a room of `room`, the least that keeps it in the room. */
function shift(start: number, size: number, room: number): number {
  if (size > room - 2 * REVEAL_MARGIN || start < REVEAL_MARGIN) return REVEAL_MARGIN - start;
  if (start + size > room - REVEAL_MARGIN) return room - REVEAL_MARGIN - (start + size);
  return 0;
}

/** The smallest scale a reveal zooms out to. A detail too large for the room at this scale is aligned to the room's corner. */
export const REVEAL_MIN_K = 0.5;

/**
 * The camera that shows an expansion `rect` (world units) whose chart is `chartW` wide. A chart narrower than `minPx` on
 * screen is zoomed in, at most 1.5 times the current scale, about the expansion's top-left corner, which stays where it
 * was. The scale fits the expansion's WIDTH into the room (zoomed out only when it is wider than the room at the current
 * scale, but not below REVEAL_MIN_K). The height never sets the scale: an expansion taller than the room keeps the
 * width-fit scale and is aligned to the room's top, so its header stays in view and its chart stays readable. Then the
 * camera pans the least that brings the expansion inside `room`, and one still larger than the room is aligned to its
 * top-left, so its left and top edges stay visible. A camera that already shows it is returned unchanged.
 */
export function revealCamera(cam: Camera, rect: Rect, chartW: number, room: { width: number; height: number }, minPx: number): Camera {
  let k = cam.k;
  if (chartW * k < minPx) k = Math.min(minPx / chartW, cam.k * CHART_FIT_MAX_K);
  const fitK = (room.width - 2 * REVEAL_MARGIN) / Math.max(rect.w, 1);
  if (fitK < k) k = Math.min(k, Math.max(REVEAL_MIN_K, fitK));
  let x = cam.x + rect.x * (cam.k - k);
  let y = cam.y + rect.y * (cam.k - k);
  x += shift(rect.x * k + x, rect.w * k, room.width);
  y += shift(rect.y * k + y, rect.h * k, room.height);
  return { k, x, y };
}

/** What a click-to-expand reveal may change: the scale a readable chart needs, the lowest scale a width-fit takes, and the header height kept in view. */
export interface ExpandLimits {
  readK: number;
  fitMinK: number;
  headH: number;
}

/**
 * The camera after a click opens an expansion `box` (world units) in `room` (the stage's room, in the camera's own units).
 * The least change: the scale stays, unless the box is below `readK` (zoomed in, at most 1.5 times) or wider than the room
 * (width-fit, not below `fitMinK`, aligned left). The camera then moves the least that brings the box inside the room. A box
 * taller than the room needs only its header in view: the camera moves only when the header is cut off, and then the least
 * that brings the header in (its top to the room's top when it is above). A camera that already shows the box is returned
 * unchanged.
 */
export function expandCamera(cam: Camera, box: Rect, room: Rect, lim: ExpandLimits): Camera {
  let k = cam.k;
  if (k < lim.readK) k = Math.min(lim.readK, cam.k * CHART_FIT_MAX_K);
  const fitK = (room.w - 2 * REVEAL_MARGIN) / Math.max(box.w, 1);
  if (fitK < k) k = Math.min(k, Math.max(lim.fitMinK, fitK));
  // Zoomed about the box's top-left corner, which stays where it was.
  let x = cam.x + box.x * (cam.k - k);
  let y = cam.y + box.y * (cam.k - k);
  // The box's place on screen, relative to the room's top-left.
  const left = box.x * k + x - room.x;
  const top = box.y * k + y - room.y;
  x += shift(left, box.w * k, room.w);
  const tallH = room.h - 2 * REVEAL_MARGIN;
  if (box.h * k > tallH) {
    const headPx = Math.min(lim.headH * k, tallH);
    if (top < REVEAL_MARGIN) y += REVEAL_MARGIN - top;
    else if (top + headPx > room.h - REVEAL_MARGIN) y += room.h - REVEAL_MARGIN - headPx - top;
  } else {
    y += shift(top, box.h * k, room.h);
  }
  return { k, x, y };
}

/** A narrow viewport (a phone) shows the first column at least this large, so its text stays readable. */
export const READABLE_COLUMN_K = 0.6;
/** The viewport width at or below which the whole-project view favours one readable column over the whole width. */
export const NARROW_VIEW_PX = 600;

/**
 * The camera for the whole project on the first view: the scene (world units) is scaled down, never above `maxK`, until its
 * width fits the room's width with `pad` to spare, and aligned to the room's top-left, so no frame is clipped on the right.
 * Its height is not fitted: the map is panned down it. On a narrow viewport the scale is at least READABLE_COLUMN_K (capped at
 * `maxK`), so one column reads, and its left edge stays visible. Returned in the room's own coordinates.
 */
export function sceneCamera(scene: Rect, roomWidth: number, maxK: number, narrow: boolean, pad = REVEAL_MARGIN): Camera {
  const fitW = (roomWidth - 2 * pad) / Math.max(scene.w, 1);
  const k = narrow ? Math.min(maxK, Math.max(fitW, READABLE_COLUMN_K)) : Math.min(maxK, fitW);
  const scale = Math.max(0.02, k);
  return { k: scale, x: pad - scene.x * scale, y: pad - scene.y * scale };
}

/** Whether the expansion replaces its card in the card's own slot. */
export function isInPlace(e: Expansion): boolean {
  return e.anchor.kind === "box" && e.anchor.inPlace === true;
}
