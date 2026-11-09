// The sheet's zone grid. The map is cut into square zones of 480 world units from an origin at -160, so every box has a
// reference a reader can say: the letter of its column, then the number of its row, as the sheet's margins read ("C4").
// Pure geometry with no DOM, so it is unit tested (test/zones.test.ts).
import type { Rect } from "@insight/flow";

/** The side of one zone, in world units. */
export const ZONE_SIZE = 480;
/** The world point where the first zone's top-left corner sits. The zones on the grid start here, not at the map's 0. */
export const ZONE_ORIGIN = -160;

/** A zone's position: zero-based column and row, and its reference ("C4": column letter, then row number). */
export interface ZoneRef {
  col: number;
  row: number;
  label: string;
}

/** One zone of a grid, as drawn: its reference and its rectangle in world units. */
export interface ZoneCell extends ZoneRef {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The letter of a zero-based column: A to Z, then AA, AB and so on. Negative indexes read as A. */
export function zoneLetter(index: number): string {
  let n = Math.max(0, Math.floor(index));
  let s = "";
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

/** The zone a world point is in. A point left of or above the origin is in the first zone. */
export function zoneAt(x: number, y: number): ZoneRef {
  const col = Math.max(0, Math.floor((x - ZONE_ORIGIN) / ZONE_SIZE));
  const row = Math.max(0, Math.floor((y - ZONE_ORIGIN) / ZONE_SIZE));
  return { col, row, label: `${zoneLetter(col)}${row + 1}` };
}

/** The zone a rectangle is in, by its centre: a box that straddles a zone line belongs to the zone its middle is in. */
export function zoneOf(rect: Rect): ZoneRef {
  return zoneAt(rect.x + rect.w / 2, rect.y + rect.h / 2);
}

/**
 * The zones that cover a world rectangle (for the map's extent, or the visible area). Each cell is clipped to the
 * rectangle, so a label placed at its corner stays on the map. An empty rectangle has no cells.
 */
export function zoneCells(bounds: Rect): ZoneCell[] {
  if (!(bounds.w > 0) || !(bounds.h > 0)) return [];
  const right = bounds.x + bounds.w;
  const bottom = bounds.y + bounds.h;
  const c0 = Math.max(0, Math.floor((bounds.x - ZONE_ORIGIN) / ZONE_SIZE));
  const c1 = Math.max(0, Math.floor((right - ZONE_ORIGIN) / ZONE_SIZE));
  const r0 = Math.max(0, Math.floor((bounds.y - ZONE_ORIGIN) / ZONE_SIZE));
  const r1 = Math.max(0, Math.floor((bottom - ZONE_ORIGIN) / ZONE_SIZE));
  const cells: ZoneCell[] = [];
  for (let row = r0; row <= r1; row++) {
    for (let col = c0; col <= c1; col++) {
      const x0 = ZONE_ORIGIN + col * ZONE_SIZE;
      const y0 = ZONE_ORIGIN + row * ZONE_SIZE;
      const x = Math.max(x0, bounds.x);
      const y = Math.max(y0, bounds.y);
      const w = Math.min(x0 + ZONE_SIZE, right) - x;
      const h = Math.min(y0 + ZONE_SIZE, bottom) - y;
      if (w <= 0 || h <= 0) continue;
      cells.push({ col, row, label: `${zoneLetter(col)}${row + 1}`, x, y, w, h });
    }
  }
  return cells;
}

/**
 * The grid lines inside a world rectangle, as one SVG path string. Lines on the rectangle's own edges are included, so
 * the grid closes the extent. Empty for an empty rectangle.
 */
export function zoneLines(bounds: Rect): string {
  if (!(bounds.w > 0) || !(bounds.h > 0)) return "";
  const right = bounds.x + bounds.w;
  const bottom = bounds.y + bounds.h;
  const parts: string[] = [];
  const first = Math.floor((bounds.x - ZONE_ORIGIN) / ZONE_SIZE);
  const last = Math.ceil((right - ZONE_ORIGIN) / ZONE_SIZE);
  for (let i = first; i <= last; i++) {
    const x = ZONE_ORIGIN + i * ZONE_SIZE;
    if (x < bounds.x || x > right) continue;
    parts.push(`M${x} ${bounds.y}V${bottom}`);
  }
  const firstRow = Math.floor((bounds.y - ZONE_ORIGIN) / ZONE_SIZE);
  const lastRow = Math.ceil((bottom - ZONE_ORIGIN) / ZONE_SIZE);
  for (let j = firstRow; j <= lastRow; j++) {
    const y = ZONE_ORIGIN + j * ZONE_SIZE;
    if (y < bounds.y || y > bottom) continue;
    parts.push(`M${bounds.x} ${y}H${right}`);
  }
  return parts.join("");
}
