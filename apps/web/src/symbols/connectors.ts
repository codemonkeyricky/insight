// Connector geometry for the Symbols tab. Connectors are computed in the track's unscaled coordinates: each element's offset is
// summed up its offsetParent chain to the track, which ignores transforms (the pan and zoom, and the box enter motion). So a
// connector drawn once stays on its rows and boxes at any camera, and needs no recompute on pan or zoom.

/** The gap between two columns, where a connector runs. */
export const CONNECTOR_GAP = 72;

/** The layout fields of an element that offsetWithin reads (an HTMLElement has them). */
export interface Offsettable {
  offsetLeft: number;
  offsetTop: number;
  offsetParent: unknown;
}

/** The position of `el`'s top-left corner in the coordinates of `root`, by summing offsets up the offsetParent chain. */
export function offsetWithin(el: Offsettable, root: unknown): { x: number; y: number } {
  let x = 0;
  let y = 0;
  let node: Offsettable | null = el;
  while (node !== null && node !== root) {
    x += node.offsetLeft;
    y += node.offsetTop;
    node = node.offsetParent as Offsettable | null;
  }
  return { x, y };
}

/** The cubic path from the right edge of a row to the left edge of the box it opens, both at their own y. */
export function connectorPath(from: { right: number; y: number }, to: { left: number; y: number }, gap: number = CONNECTOR_GAP): string {
  return `M ${from.right} ${from.y} C ${from.right + gap / 2} ${from.y}, ${to.left - gap / 2} ${to.y}, ${to.left} ${to.y}`;
}
