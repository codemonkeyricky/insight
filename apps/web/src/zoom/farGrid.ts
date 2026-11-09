// The far tier's card grid: each card is a child of the scope, sized by its function count and packed in rows in screen
// space (independent of the function layout). Pure geometry, unit tested (test/farGrid.test.ts); FarCards draws it.
import type { Rect } from "@insight/flow";

/** The smallest and the largest card, in screen px. A card's size grows with its function count between them. */
export const FAR_MIN = { w: 120, h: 72 };
export const FAR_MAX = { w: 360, h: 200 };
/** The space between cards, in screen px. */
export const FAR_GAP = 12;
/** Below this width (px) the cards fill two columns, as on a phone. */
export const FAR_TWO_COLUMNS_BELOW = 520;

export interface FarItem {
  id: string;
  count: number;
}

export interface FarPlaced extends Rect {
  id: string;
}

/** The card size for a function count: the square root of its share of the largest count, so the area grows evenly. */
export function cardSize(count: number, maxCount: number): { w: number; h: number } {
  const share = maxCount > 0 ? Math.min(1, Math.max(0, count) / maxCount) : 0;
  const s = Math.sqrt(share);
  return { w: FAR_MIN.w + (FAR_MAX.w - FAR_MIN.w) * s, h: FAR_MIN.h + (FAR_MAX.h - FAR_MIN.h) * s };
}

/**
 * A shelf packer: the cards sorted by count, largest first (ties keep their input order), placed left to right in rows
 * that fit `width`. Each row is as tall as its tallest card. Positions are relative to the grid's top-left corner, and
 * `height` is the total height used. No two cards overlap, and every card lies within `width` and `height`.
 */
export function packCards(items: readonly FarItem[], width: number, gap = FAR_GAP): { placed: FarPlaced[]; height: number } {
  const order = items.map((it, i) => ({ it, i })).sort((a, b) => b.it.count - a.it.count || a.i - b.i);
  const maxCount = order.reduce((m, o) => Math.max(m, o.it.count), 0);
  const narrow = width < FAR_TWO_COLUMNS_BELOW;
  const placed: FarPlaced[] = [];
  let x = 0;
  let y = 0;
  let rowH = 0;
  for (const { it } of order) {
    const size = cardSize(it.count, maxCount);
    const w = Math.min(width, narrow ? (width - gap) / 2 : size.w);
    const h = size.h;
    if (x > 0 && x + w > width) {
      y += rowH + gap;
      x = 0;
      rowH = 0;
    }
    placed.push({ id: it.id, x, y, w, h });
    x += w + gap;
    rowH = Math.max(rowH, h);
  }
  return { placed, height: placed.length > 0 ? y + rowH : 0 };
}

/** The point where the ray from a rect's centre towards `toward` leaves the rect. */
export function boundaryPoint(r: Rect, toward: { x: number; y: number }): { x: number; y: number } {
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  const dx = toward.x - cx;
  const dy = toward.y - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const sx = dx !== 0 ? r.w / 2 / Math.abs(dx) : Infinity;
  const sy = dy !== 0 ? r.h / 2 / Math.abs(dy) : Infinity;
  const t = Math.min(sx, sy);
  return { x: cx + dx * t, y: cy + dy * t };
}

/** A curved link between two cards, from edge to edge, bowed a little to one side (a quadratic path). */
export function linkPath(a: Rect, b: Rect): string {
  const ca = { x: a.x + a.w / 2, y: a.y + a.h / 2 };
  const cb = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  const p = boundaryPoint(a, cb);
  const q = boundaryPoint(b, ca);
  const len = Math.hypot(q.x - p.x, q.y - p.y) || 1;
  const bend = Math.min(40, len * 0.2);
  const cx = (p.x + q.x) / 2 - ((q.y - p.y) / len) * bend;
  const cy = (p.y + q.y) / 2 + ((q.x - p.x) / len) * bend;
  return `M${p.x} ${p.y}Q${cx} ${cy} ${q.x} ${q.y}`;
}
