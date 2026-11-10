// The callout from the step (or function box) an expansion hangs from to the expansion beside it: a filled wedge from the
// anchor's right edge (its top and bottom) to the expansion's left edge (its top and bottom, inside the rounded corners),
// drawn behind the expansion like a zoom-in. Pure geometry, so it is unit tested (test/connector.test.ts). The map moves
// both edges with the side shift (see ZoomMap's writeShift).

/**
 * The wedge's outline: the anchor's top (ax, ayT) and bottom (ax, ayB), the expansion's bottom-left (ex, eyB) and top-left
 * (ex, eyT), in that order, closed back to the anchor's top.
 */
export function calloutD(ax: number, ayT: number, ayB: number, ex: number, eyT: number, eyB: number): string {
  return `M${ax} ${ayT} L${ex} ${eyT} L${ex} ${eyB} L${ax} ${ayB} Z`;
}
