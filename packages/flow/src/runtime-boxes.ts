// The roots-only map with its runtime containers. A process box holds the thread boxes it runs, and a thread box holds the
// root-function cards that thread runs. The root functions that no thread runs sit in a trailing "Not on a thread" group,
// laid out as the flat grid. Containers are drawn only when the model has runtime context (a grounded thread or a
// coroutine); otherwise the caller keeps the flat grid (gridRootsLayout). Pure arithmetic: no solver runs here.
import { execProgramId, isGroundedThread } from "./exec-scene.js";
import { execRootsOnly, pathInScope } from "./scene-filter.js";
import type { ExecModel } from "./exec-model.js";
import type { Scene, SceneLayout, SceneNode } from "./scene.js";
import { CARD_GAP, CARD_H, CARD_PAD_BOTTOM, CARD_PAD_SIDE, CARD_PAD_TOP, CARD_WRAP_W, cardWidth, type Footprint } from "./roots-grid.js";
import { frameSize, type ContainerLayout, type Size, type Slot } from "./zoom-layout.js";

/** The scene id of the group that holds the root functions no thread runs. */
export const UNTHREADED_ID = "unthreaded";
export const UNTHREADED_LABEL = "Not on a thread";
/** The width a process's children wrap at: its threads side by side. A thread's cards wrap in a grid (gridPack). */
export const PROCESS_WRAP_W = 1000;
/** The content of a container with no children: the width of a small card, and no height. */
const EMPTY_CONTENT: Size = { w: 200, h: 0 };
/** The narrowest content of a thread or process box, so its header label ("Worker · verify.worker.ts") is not cut short. */
const MIN_CONTENT_W = 300;
/** The aspect (width over height) a thread's grid of cards aims for: a 16:10 block. */
const GRID_ASPECT = 1.6;

/** Whether the model has runtime context to draw containers for: a grounded thread, or a coroutine. */
export function hasRuntimeContext(model: ExecModel): boolean {
  const names = new Map(model.functions.map((f) => [f.id, f.name]));
  return model.threads.some((t) => isGroundedThread(t, (id) => names.get(id)) || t.coroutines.length > 0);
}

/**
 * The roots-only scene with containers: the processes and threads of execRootsOnly, the root cards in each thread, and
 * the plain code flow moved into the "Not on a thread" group. A function that several threads run has a card in each,
 * and each card's detail names its thread. Undefined when the model has no runtime context: the caller keeps the flat
 * roots-only scene. The input is not changed.
 */
export function runtimeRootsScene(full: Scene, model: ExecModel): Scene | undefined {
  if (!hasRuntimeContext(model)) return undefined;
  const cut = execRootsOnly(full, model);
  const nodes = new Map<string, SceneNode>();
  for (const [id, n] of cut.nodes) nodes.set(id, { ...n, children: [...n.children] });
  const root = nodes.get(cut.root);
  if (root === undefined) return undefined;

  // The plain code flow: functions placed directly on the project move into the group.
  const flat = root.children.filter((id) => nodes.get(id)?.kind === "function");
  if (flat.length > 0) {
    const flatSet = new Set(flat);
    root.children = root.children.filter((id) => !flatSet.has(id));
    for (const id of flat) {
      const n = nodes.get(id);
      if (n !== undefined) n.parent = UNTHREADED_ID;
    }
    const group: SceneNode = {
      id: UNTHREADED_ID,
      kind: "group",
      label: UNTHREADED_LABEL,
      parent: cut.root,
      children: [...flat].sort(),
      detail: `${flat.length} function${flat.length === 1 ? "" : "s"}`,
      note: "Plain call with no runtime context. Zoom out to see where it runs.",
    };
    nodes.set(UNTHREADED_ID, group);
    root.children.push(UNTHREADED_ID);
  }

  // The entry programs lead the processes: the Browser program first, then the Node programs by name. The others keep their order.
  const BROWSER_ID = execProgramId("entry:browser");
  const NODE_PREFIX = execProgramId("entry:node:");
  const rank = (id: string): number => (id === BROWSER_ID ? 0 : id.startsWith(NODE_PREFIX) ? 1 : 2);
  const label = (id: string): string => nodes.get(id)?.label ?? "";
  const byLabel = (a: string, b: string): number => (label(a) < label(b) ? -1 : label(a) > label(b) ? 1 : 0);
  root.children = [...root.children].sort((a, b) => rank(a) - rank(b) || (rank(a) === 1 ? byLabel(a, b) : 0));

  // Each card's subtitle is its file and line. A function on several threads names its thread, so its cards read apart.
  const byFn = new Map(model.functions.map((f) => [f.id, f]));
  const cardsOf = new Map<string, number>();
  for (const n of nodes.values()) if (n.kind === "function" && n.ref !== undefined) cardsOf.set(n.ref, (cardsOf.get(n.ref) ?? 0) + 1);
  for (const n of nodes.values()) {
    if (n.kind !== "function" || n.ref === undefined) continue;
    const f = byFn.get(n.ref);
    const tag = f?.module === true ? "top level · " : "";
    const place = f !== undefined && f.file !== "" ? `${tag}${pathInScope(f.file, model.scope)}:${f.line}` : n.detail;
    const parent = n.parent !== undefined ? nodes.get(n.parent) : undefined;
    const several = (cardsOf.get(n.ref) ?? 0) > 1 && parent?.kind === "thread";
    if (place !== undefined) n.detail = several ? `${place} · ${parent?.label ?? ""}` : place;
  }

  return {
    root: cut.root,
    nodes,
    edges: cut.edges.map((e) => ({ ...e })),
    levels: { ...cut.levels, group: { box: { w: 300, h: 64 } } },
  };
}

/** The containers a runtime roots scene opens: the root and every container with children (process, thread, group). */
export function runtimeOpen(scene: Scene): Set<string> {
  const open = new Set<string>([scene.root]);
  for (const n of scene.nodes.values()) if (n.children.length > 0) open.add(n.id);
  return open;
}

interface Item extends Size {
  id: string;
  /** Starts a new row even when the row has room: the group sits under the threads and processes. */
  breakBefore?: boolean;
  /** The room kept clear beside the box for its expansions (see Footprint). The box itself keeps its size. */
  room?: Size;
}

/** Packs boxes in rows of at most `wrap` wide, top-left aligned, with CARD_GAP between them both ways. */
function pack(items: readonly Item[], wrap: number): { w: number; h: number; slots: Slot[] } {
  const slots: Slot[] = [];
  let x = 0;
  let y = 0;
  let rowH = 0;
  let width = 0;
  for (const it of items) {
    const outerW = it.w + (it.room?.w ?? 0);
    const outerH = Math.max(it.h, it.room?.h ?? 0);
    if (x > 0 && (it.breakBefore === true || x + outerW > wrap)) {
      y += rowH + CARD_GAP;
      x = 0;
      rowH = 0;
    }
    slots.push({ id: it.id, x, y, w: it.w, h: it.h });
    x += outerW + CARD_GAP;
    rowH = Math.max(rowH, outerH);
    width = Math.max(width, x - CARD_GAP);
  }
  return { w: width, h: items.length === 0 ? 0 : y + rowH, slots };
}

/**
 * Packs boxes in a grid of uniform cells, `cols` to a row, with the column count chosen so the grid's aspect is nearest
 * GRID_ASPECT. Every cell is as wide as the widest box, so the columns line up. Deterministic.
 */
function gridPack(items: readonly Item[]): { w: number; h: number; slots: Slot[] } {
  if (items.length === 0) return { w: 0, h: 0, slots: [] };
  const cellW = Math.max(...items.map((it) => it.w));
  let cols = 1;
  let best = Number.POSITIVE_INFINITY;
  for (let c = 1; c <= items.length; c++) {
    const rows = Math.ceil(items.length / c);
    const w = c * cellW + (c - 1) * CARD_GAP;
    const h = rows * CARD_H + (rows - 1) * CARD_GAP;
    const miss = Math.abs(w / h - GRID_ASPECT);
    if (miss < best) {
      best = miss;
      cols = c;
    }
  }
  const sized = items.map((it) => ({ ...it, w: cellW }));
  // Half a unit of slack, so a row of `cols` cells fits and the next cell starts a new row.
  return pack(sized, cols * cellW + (cols - 1) * CARD_GAP + 0.5);
}

/** How wide a container's children wrap, by the container's kind. */
function wrapOf(kind: string): number {
  if (kind === "program" || kind === "process" || kind === "project") return PROCESS_WRAP_W;
  return CARD_WRAP_W;
}

/**
 * The layout of a runtime roots scene (see runtimeRootsScene). Each container holds its children packed in rows; a
 * container takes the frame size of its content (frameSize), so its siblings move out of its way. A card with a footprint
 * keeps the room beside it, so the expansions it opens sit inside its thread's frame. The root's content keeps the flat
 * grid's padding, which leaves room for the map's controls. Deterministic.
 */
export function runtimeRootsLayout(scene: Scene, footprint?: Footprint): SceneLayout {
  const containers: Record<string, ContainerLayout> = {};

  // The size a node takes as a child: a card, or the frame of a container (laid out here, first).
  const sizeOf = (id: string): Size => {
    const n = scene.nodes.get(id);
    if (n === undefined) return { w: 0, h: 0 };
    if (n.children.length === 0 && n.kind !== "program" && n.kind !== "thread" && n.kind !== "group") {
      return { w: cardWidth(n.label), h: CARD_H };
    }
    const content = contentOf(n.id, n.kind);
    return frameSize(content);
  };
  const itemOf = (id: string): Item => {
    const n = scene.nodes.get(id);
    const size = sizeOf(id);
    const leaf = n !== undefined && n.children.length === 0 && n.kind !== "program" && n.kind !== "thread" && n.kind !== "group";
    return { id, ...size, breakBefore: id === UNTHREADED_ID, room: leaf ? footprint?.get(id) : undefined };
  };

  const contentOf = (id: string, kind: string): Size => {
    const n = scene.nodes.get(id);
    const kids = n?.children ?? [];
    if (kids.length === 0) {
      containers[id] = { w: EMPTY_CONTENT.w, h: EMPTY_CONTENT.h, slots: [] };
      return EMPTY_CONTENT;
    }
    const items: Item[] = kids.map(itemOf);
    const packed = kind === "thread" ? gridPack(items) : pack(items, wrapOf(kind));
    const w = kind === "group" ? packed.w : Math.max(packed.w, MIN_CONTENT_W);
    containers[id] = { w, h: packed.h, slots: packed.slots };
    return { w, h: packed.h };
  };

  // The root: its children packed at the flat grid's padding, the group on its own row below.
  const rootNode = scene.nodes.get(scene.root);
  const kids = rootNode?.children ?? [];
  const rootItems: Item[] = kids.map(itemOf);
  const packed = pack(rootItems, PROCESS_WRAP_W);
  const slots = packed.slots.map((s) => ({ ...s, x: CARD_PAD_SIDE + s.x, y: CARD_PAD_TOP + s.y }));
  containers[scene.root] = {
    w: CARD_PAD_SIDE + packed.w + CARD_PAD_SIDE,
    h: CARD_PAD_TOP + packed.h + CARD_PAD_BOTTOM,
    slots,
  };
  return { containers };
}
