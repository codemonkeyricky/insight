// The connector from the step (or function box) an expansion hangs from to the expansion's title: a smooth cubic from the
// anchor's right edge to the title's left edge, with a small head at the title. Pure geometry, so it is unit tested
// (test/connector.test.ts). The map moves both ends with the side shift (see ZoomMap's writeShift).

/** The connector's stroke, in screen pixels. */
export const CONNECTOR_WIDTH = 1.5;
/** The connector's head, in screen pixels: its length from the tip back along the line. */
export const CONNECTOR_HEAD = 7;

/** The cubic from (x1, y1) to (x2, y2) that leaves horizontally and arrives horizontally. */
export function connectorD(x1: number, y1: number, x2: number, y2: number): string {
  const h = Math.max(0, (x2 - x1) / 2);
  return `M${x1} ${y1} C${x1 + h} ${y1} ${x2 - h} ${y2} ${x2} ${y2}`;
}

/** The head: a triangle whose tip is (x, y), pointing right, into the expansion's title. `size` is in the map's units. */
export function headD(x: number, y: number, size: number): string {
  return `M${x} ${y} L${x - size} ${y - size / 2} L${x - size} ${y + size / 2} Z`;
}
