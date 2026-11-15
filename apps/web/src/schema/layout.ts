// Layout of a schema diagram. Kinds: facet frames hold cards in up to three columns, frames sit in a masonry grid; all
// packed here, no solver. Records: elkjs layered, left to right, with the solver injected (the page passes the worker).
import type { ElkNode } from "elkjs/lib/elk-api";
import type { SchemaDiagramView, SchemaEntity } from "../api";
import type { Solve } from "../states/layout";

export const CARD_W = 248;
export const HEADER_H = 32;
export const ROW_H = 20;
export const VALUES_H = 14;
export const CARD_PAD = 6;
export const NOTE_H = 18;
const GAP = 14;
const COL_GAP = 32;
const FRAME_PAD = 14;
const FRAME_TITLE_H = 40;
const FRAME_GAP = 28;
const MARGIN = 24;

export interface CardBox {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FrameBox {
  id: string;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SchemaLayout {
  width: number;
  height: number;
  frames: FrameBox[];
  cards: Map<string, CardBox>;
}

/** The height of a card and the y of the middle of each field row, relative to the card top. */
export function cardMetrics(e: SchemaEntity): { h: number; rowMid: number[] } {
  const note = e.note ? NOTE_H : 0;
  if (e.fields.length === 0) return { h: HEADER_H + ROW_H + CARD_PAD + note, rowMid: [] };
  let y = HEADER_H + 2;
  const rowMid: number[] = [];
  for (const f of e.fields) {
    rowMid.push(y + ROW_H / 2);
    y += ROW_H + (f.values && f.values.length > 0 ? VALUES_H : 0);
  }
  return { h: y + CARD_PAD + note, rowMid };
}

/** Frames in a masonry grid, cards in columns inside each frame. */
export function layoutKinds(view: SchemaDiagramView, frameColumns = 4): SchemaLayout {
  const cards = new Map<string, CardBox>();
  const frames: FrameBox[] = [];
  const sized: { id: string; label: string; w: number; h: number; place: (fx: number, fy: number) => void }[] = [];
  for (const g of view.groups) {
    const members = view.entities.filter((e) => e.group === g.id);
    if (members.length === 0) continue;
    const cols = members.length >= 9 ? 3 : members.length >= 4 ? 2 : 1;
    const colH = new Array<number>(cols).fill(0);
    const placed: { e: SchemaEntity; col: number; y: number; h: number }[] = [];
    for (const e of members) {
      let c = 0;
      for (let i = 1; i < cols; i++) if ((colH[i] ?? 0) < (colH[c] ?? 0)) c = i;
      const h = cardMetrics(e).h;
      placed.push({ e, col: c, y: colH[c] ?? 0, h });
      colH[c] = (colH[c] ?? 0) + h + GAP;
    }
    const w = FRAME_PAD * 2 + cols * CARD_W + (cols - 1) * COL_GAP;
    const h = FRAME_TITLE_H + FRAME_PAD + Math.max(...colH) - GAP + FRAME_PAD;
    sized.push({
      id: g.id,
      label: g.label,
      w,
      h,
      place: (fx, fy) => {
        for (const p of placed) cards.set(p.e.id, { id: p.e.id, x: fx + FRAME_PAD + p.col * (CARD_W + COL_GAP), y: fy + FRAME_TITLE_H + p.y, w: CARD_W, h: p.h });
      },
    });
  }
  const nCols = Math.max(1, Math.min(frameColumns, sized.length));
  const colFrames: typeof sized[] = Array.from({ length: nCols }, () => []);
  const heights = new Array<number>(nCols).fill(0);
  for (const f of sized) {
    let c = 0;
    for (let i = 1; i < nCols; i++) if ((heights[i] ?? 0) < (heights[c] ?? 0)) c = i;
    colFrames[c]?.push(f);
    heights[c] = (heights[c] ?? 0) + f.h + FRAME_GAP;
  }
  let x = MARGIN;
  let totalH = 0;
  for (const col of colFrames) {
    if (col.length === 0) continue;
    let y = MARGIN;
    const colW = Math.max(...col.map((f) => f.w));
    for (const f of col) {
      frames.push({ id: f.id, label: f.label, x, y, w: colW, h: f.h });
      f.place(x, y);
      y += f.h + FRAME_GAP;
    }
    totalH = Math.max(totalH, y - FRAME_GAP);
    x += colW + FRAME_GAP;
  }
  return { width: x - FRAME_GAP + MARGIN, height: totalH + MARGIN, frames, cards };
}

/** Layered left-to-right layout of the records; the solver places the cards. With several groups, each group is laid out on its own and framed, and the frames are shelf-packed. */
export async function layoutRecords(view: SchemaDiagramView, solve: Solve, signal?: AbortSignal): Promise<SchemaLayout> {
  const ids = new Set(view.entities.map((e) => e.id));
  const groups = view.groups.filter((g) => view.entities.some((e) => e.group === g.id));
  const framed = groups.length > 1;
  const solveGroup = async (members: SchemaEntity[], pad: number): Promise<{ cards: Map<string, CardBox>; w: number; h: number }> => {
    const own = new Set(members.map((e) => e.id));
    const seen = new Set<string>();
    const edges: { id: string; sources: string[]; targets: string[] }[] = [];
    for (const l of view.links) {
      if (l.kind !== "ref" || l.from === l.to || !ids.has(l.from) || !ids.has(l.to) || !own.has(l.from) || !own.has(l.to)) continue;
      const key = `${l.from}>${l.to}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ id: `e${edges.length}`, sources: [l.from], targets: [l.to] });
    }
    const graph: ElkNode = {
      id: "root",
      layoutOptions: {
        "elk.algorithm": "layered",
        "elk.direction": "RIGHT",
        "elk.layered.spacing.nodeNodeBetweenLayers": "120",
        "elk.spacing.nodeNode": "32",
        "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
        "elk.layered.layering.strategy": "LONGEST_PATH_SOURCE",
        "elk.padding": `[top=${pad},left=${pad},bottom=${pad},right=${pad}]`,
      },
      children: members.map((e) => ({ id: e.id, width: CARD_W, height: cardMetrics(e).h })),
      edges,
    } as ElkNode;
    const out = await solve(graph, signal);
    const cards = new Map<string, CardBox>();
    let w = 0;
    let h = 0;
    for (const c of out.children ?? []) {
      const box = { id: c.id, x: c.x ?? 0, y: c.y ?? 0, w: c.width ?? CARD_W, h: c.height ?? 0 };
      cards.set(c.id, box);
      w = Math.max(w, box.x + box.w);
      h = Math.max(h, box.y + box.h);
    }
    return { cards, w: w + pad, h: h + pad };
  };
  if (!framed) {
    const r = await solveGroup(view.entities, MARGIN);
    return { width: r.w + MARGIN, height: r.h + MARGIN, frames: [], cards: r.cards };
  }
  const solved = await Promise.all(groups.map((g) => solveGroup(view.entities.filter((e) => e.group === g.id), 0)));
  const sizes = solved.map((r) => ({ w: r.w + FRAME_PAD * 2, h: r.h + FRAME_PAD * 2 + FRAME_TITLE_H }));
  // Shelf packing: fill rows up to a target width, widest frames first within reading order kept by group order.
  const area = sizes.reduce((a, z) => a + z.w * z.h, 0);
  const rowMax = Math.max(Math.max(...sizes.map((z) => z.w)), Math.sqrt(area * 2.2));
  const cards = new Map<string, CardBox>();
  const frames: FrameBox[] = [];
  let x = MARGIN;
  let y = MARGIN;
  let rowH = 0;
  let width = 0;
  groups.forEach((g, i) => {
    const z = sizes[i] as { w: number; h: number };
    const r = solved[i] as { cards: Map<string, CardBox> };
    if (x > MARGIN && x - MARGIN + z.w > rowMax) {
      x = MARGIN;
      y += rowH + FRAME_GAP;
      rowH = 0;
    }
    frames.push({ id: g.id, label: g.label, x, y, w: z.w, h: z.h });
    for (const c of r.cards.values()) cards.set(c.id, { ...c, x: c.x + x + FRAME_PAD, y: c.y + y + FRAME_TITLE_H + FRAME_PAD });
    x += z.w + FRAME_GAP;
    width = Math.max(width, x - FRAME_GAP);
    rowH = Math.max(rowH, z.h);
  });
  return { width: width + MARGIN, height: y + rowH + MARGIN, frames, cards };
}

export interface LinkPath {
  d: string;
  /** The arrowhead (a ref arrow or an extends triangle), as an SVG path. */
  head: string;
}

const arrowAt = (x: number, y: number, dx: number, dy: number, size: number, open: boolean): string => {
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const bx = x - ux * size;
  const by = y - uy * size;
  const px = -uy * size * 0.55;
  const py = ux * size * 0.55;
  return open ? `M${x} ${y} L${bx + px} ${by + py} L${bx - px} ${by - py} Z` : `M${x} ${y} L${bx + px} ${by + py} L${bx - px} ${by - py} Z`;
};

/** A ref curve: from the right edge of a field row to the left edge of the target's header (or around, for a back ref). */
export function refPath(from: CardBox, rowMidY: number, to: CardBox): LinkPath {
  const ty = to.y + HEADER_H / 2;
  if (from.id === to.id) {
    const x = from.x + from.w;
    const d = `M${x} ${from.y + rowMidY} C${x + 46} ${from.y + rowMidY} ${x + 46} ${ty} ${x + 1} ${ty}`;
    return { d, head: arrowAt(x + 1, ty, -1, 0, 7, false) };
  }
  const forward = to.x >= from.x + from.w + 8;
  const backward = to.x + to.w <= from.x - 8;
  const sx = backward ? from.x : from.x + from.w;
  const sy = from.y + rowMidY;
  let tx: number;
  let c1x: number;
  let c2x: number;
  if (forward) {
    tx = to.x;
    const k = Math.max(40, (tx - sx) * 0.5);
    c1x = sx + k;
    c2x = tx - k;
  } else if (backward) {
    tx = to.x + to.w;
    const k = Math.max(40, (sx - tx) * 0.5);
    c1x = sx - k;
    c2x = tx + k;
  } else {
    // Overlapping columns: leave by the right, enter the target's right edge.
    tx = to.x + to.w;
    const k = 60 + Math.abs(ty - sy) * 0.05;
    c1x = Math.max(sx, tx) + k;
    c2x = c1x;
  }
  const d = `M${sx} ${sy} C${c1x} ${sy} ${c2x} ${ty} ${tx} ${ty}`;
  const dir = forward ? 1 : backward ? -1 : -1;
  return { d, head: arrowAt(tx, ty, dir, 0, 7, false) };
}

/** An extends curve: from the child's side to the parent's side, ending in a hollow triangle. */
export function extendsPath(child: CardBox, parent: CardBox): LinkPath {
  const cy = child.y + HEADER_H / 2;
  const py = parent.y + HEADER_H / 2;
  const childMid = child.x + child.w / 2;
  const parentMid = parent.x + parent.w / 2;
  if (Math.abs(childMid - parentMid) < CARD_W * 0.6) {
    // Same column: bulge out of the left side.
    const x1 = child.x;
    const x2 = parent.x;
    const bulge = 34 + Math.min(40, Math.abs(cy - py) * 0.05);
    const d = `M${x1} ${cy} C${x1 - bulge} ${cy} ${x2 - bulge} ${py} ${x2} ${py}`;
    return { d, head: arrowAt(x2, py, 1, 0, 9, true) };
  }
  const right = parentMid > childMid;
  const x1 = right ? child.x + child.w : child.x;
  const x2 = right ? parent.x : parent.x + parent.w;
  const k = Math.max(40, Math.abs(x2 - x1) * 0.5);
  const d = `M${x1} ${cy} C${x1 + (right ? k : -k)} ${cy} ${x2 + (right ? -k : k)} ${py} ${x2} ${py}`;
  return { d, head: arrowAt(x2, py, right ? 1 : -1, 0, 9, true) };
}
