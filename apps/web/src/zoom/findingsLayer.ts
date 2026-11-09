// The findings layer of the Flow sheet. A function with findings gets a revision cloud (a scalloped red outline around its
// box) and a marker: a red triangle on the cloud's top-left corner and a number badge on its top-right corner, the badge
// holding how many findings the function has. Findings join to the map by the function id they name (their `nodes`).
// The geometry is pure and unit tested (test/findingsLayer.test.ts); the map draws it (ZoomMap).
import type { Rect } from "@insight/flow";

/** The finding fields the layer reads: the ids of the nodes it names. */
export interface NamedFinding {
  nodes?: readonly string[];
}

/** How far a cloud stands off its box, in world units. */
export const CLOUD_PAD = 7;
/** The length of one scallop's chord, in world units. */
export const CLOUD_STEP = 16;
/** The triangle marker's shape, in screen pixels, centred on its anchor (the map scales it to a constant size). */
export const MARKER_TRIANGLE: readonly [number, number][] = [
  [-7, 6],
  [7, 6],
  [0, -8],
];
/** The number badge's radius in screen pixels, centred on its anchor. */
export const MARKER_BADGE_R = 9;

/**
 * How many findings name each function: a finding counts once for each distinct node it names. The map shows the count
 * on the function's badge.
 */
export function findingCounts(rows: readonly NamedFinding[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const f of rows) {
    for (const id of new Set(f.nodes ?? [])) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

/** The outline's corner-to-corner points of a cloud around `rect`, walked clockwise from the top-left corner. */
export function cloudPoints(rect: Rect, pad = CLOUD_PAD, step = CLOUD_STEP): [number, number][] {
  const x = rect.x - pad;
  const y = rect.y - pad;
  const w = rect.w + 2 * pad;
  const h = rect.h + 2 * pad;
  const pts: [number, number][] = [];
  const edge = (x1: number, y1: number, x2: number, y2: number) => {
    const n = Math.max(1, Math.round(Math.hypot(x2 - x1, y2 - y1) / step));
    for (let i = 0; i < n; i++) pts.push([x1 + ((x2 - x1) * i) / n, y1 + ((y2 - y1) * i) / n]);
  };
  edge(x, y, x + w, y);
  edge(x + w, y, x + w, y + h);
  edge(x + w, y + h, x, y + h);
  edge(x, y + h, x, y);
  return pts;
}

/**
 * The cloud as an SVG path: each chord between two of the points is a scallop, an arc bulging outwards. The path is closed.
 * The arc radius is a little over half the chord, so the scallops overlap slightly and read as a hand-drawn cloud.
 */
export function cloudPath(rect: Rect, pad = CLOUD_PAD, step = CLOUD_STEP): string {
  const pts = cloudPoints(rect, pad, step);
  const [x0, y0] = pts[0] ?? [rect.x, rect.y];
  let d = `M${fmt(x0)} ${fmt(y0)}`;
  for (let i = 1; i <= pts.length; i++) {
    const [ax, ay] = pts[i % pts.length] ?? [x0, y0];
    const [px, py] = pts[i - 1] ?? [x0, y0];
    const chord = Math.hypot(ax - px, ay - py);
    d += `A${fmt(chord * 0.62)} ${fmt(chord * 0.62)} 0 0 1 ${fmt(ax)} ${fmt(ay)}`;
  }
  return `${d}Z`;
}

/**
 * Where the markers of a cloud sit: the triangle's anchor at the cloud's top-left corner and the badge's at its top-right.
 * Both are world points; the marker's shape around each is in screen pixels (MARKER_TRIANGLE, MARKER_BADGE_R).
 */
export function markerAnchors(rect: Rect, pad = CLOUD_PAD): { triangle: { x: number; y: number }; badge: { x: number; y: number } } {
  const left = rect.x - pad;
  const right = rect.x + rect.w + pad;
  const top = rect.y - pad;
  return { triangle: { x: left, y: top }, badge: { x: right, y: top } };
}

/** A number as the badge shows it: the count itself, or "99+" past two digits. */
export function badgeText(count: number): string {
  return count > 999 ? "999+" : String(count);
}

const fmt = (n: number) => (Math.round(n * 100) / 100).toString();
