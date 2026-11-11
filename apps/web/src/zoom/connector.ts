// The beam from the step (or function box) an expansion hangs from to the expansion beside it: a curved ribbon from the
// anchor's right edge (its top and bottom) to the expansion's left edge (its top and bottom, inside the rounded corners),
// drawn behind the expansion like a light beam. Pure geometry, so it is unit tested (test/connector.test.ts). The map moves
// both edges with the side shift (see ZoomMap's writeShift).

/**
 * The beam's outline: the anchor's top (ax, ayT) and bottom (ax, ayB), the expansion's bottom-left (ex, eyB) and top-left
 * (ex, eyT), in that order, closed back to the anchor's top. Each side is a cubic that leaves horizontally and lands
 * horizontally, so the two edges ease into the anchor and the box.
 */
export function calloutD(ax: number, ayT: number, ayB: number, ex: number, eyT: number, eyB: number): string {
  const mx = (ax + ex) / 2;
  return `M${ax} ${ayT} C${mx} ${ayT} ${mx} ${eyT} ${ex} ${eyT} L${ex} ${eyB} C${mx} ${eyB} ${mx} ${ayB} ${ax} ${ayB} Z`;
}
