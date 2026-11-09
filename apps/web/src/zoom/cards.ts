// The far tier of the Flow sheet: when a function tile is too small to read, the map draws one card per group of boxes
// (the file or module a box sits in), and one aggregated edge per pair of cards. Pure geometry, unit tested
// (test/cards.test.ts); the map draws it (ZoomMap).
import type { Rect } from "@insight/flow";

/** A drawn box and the group it belongs to (its parent's id). */
export interface CardBox {
  id: string;
  rect: Rect;
  group: string;
}

/** One group card: the padded bounds of its boxes, and the ids of those boxes. */
export interface GroupCard {
  id: string;
  rect: Rect;
  ids: string[];
}

/** A call edge between two cards, counting every call between their boxes. */
export interface AggEdge {
  a: string;
  b: string;
  count: number;
}

/** The card for each group: the union of its boxes, grown by `pad` on each side (world units). */
export function groupCards(boxes: readonly CardBox[], pad: number): GroupCard[] {
  const by = new Map<string, { rect: Rect; ids: string[] }>();
  for (const b of boxes) {
    const cur = by.get(b.group);
    if (cur === undefined) {
      by.set(b.group, { rect: { ...b.rect }, ids: [b.id] });
      continue;
    }
    const x = Math.min(cur.rect.x, b.rect.x);
    const y = Math.min(cur.rect.y, b.rect.y);
    const right = Math.max(cur.rect.x + cur.rect.w, b.rect.x + b.rect.w);
    const bottom = Math.max(cur.rect.y + cur.rect.h, b.rect.y + b.rect.h);
    cur.rect = { x, y, w: right - x, h: bottom - y };
    cur.ids.push(b.id);
  }
  return [...by].map(([id, c]) => ({
    id,
    rect: { x: c.rect.x - pad, y: c.rect.y - pad, w: c.rect.w + 2 * pad, h: c.rect.h + 2 * pad },
    ids: c.ids,
  }));
}

/**
 * The calls between cards: each edge maps to its two cards (`cardOf` gives a node's card, or undefined when it has none).
 * Calls within one card and calls to nothing are dropped. A pair is unordered, so A to B and B to A add up.
 */
export function aggregateEdges(
  edges: readonly { from: string; to: string; count: number }[],
  cardOf: (id: string) => string | undefined,
): AggEdge[] {
  const by = new Map<string, AggEdge>();
  for (const e of edges) {
    const p = cardOf(e.from);
    const q = cardOf(e.to);
    if (p === undefined || q === undefined || p === q) continue;
    const [a, b] = p < q ? [p, q] : [q, p];
    const key = `${a}\u0000${b}`;
    const cur = by.get(key);
    if (cur) cur.count += e.count;
    else by.set(key, { a, b, count: e.count });
  }
  return [...by.values()];
}

/** The stroke width in screen pixels of an aggregated edge: it grows with log(count), and is capped. */
export function farEdgeWidth(count: number): number {
  return Math.min(6, 1 + 1.5 * Math.log2(1 + Math.max(0, count)));
}

/**
 * Moves each anchor down, in order, until it is at least `minDist` from every anchor placed before it (offset, not
 * merged, so each badge keeps its count). Gives up after a few steps and keeps the last position.
 */
export function placeBadges(points: readonly { x: number; y: number }[], minDist: number): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (const p of points) {
    let at = { x: p.x, y: p.y };
    for (let tries = 0; tries < 12 && out.some((q) => Math.hypot(q.x - at.x, q.y - at.y) < minDist); tries++) {
      at = { x: at.x, y: at.y + minDist };
    }
    out.push(at);
  }
  return out;
}

/** The median of a list (the mean of the two middle values for an even count); 0 for an empty list. */
export function medianOf(nums: readonly number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}
