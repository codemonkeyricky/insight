// The zoom map's gesture rule. When a wheel or drag gesture ends, the map decides which container is open (semantic
// zoom: children appear as the user zooms in, and collapse as they zoom out). The decision moves only the open node;
// it never moves the camera, changes the selection or writes the URL. Pure, so it is unit tested.
import { nextOpen, type Camera, type Rect } from "@insight/flow";
import { deepestAt, nearestBox, type Box } from "./source";

/**
 * A gap between boxes this close on screen (px) still counts as the nearest box: a gesture or Enter that ends in a gap
 * opens the nearest box within it.
 */
export const GAP_PX = 60;

/** The box a world point stands in: the deepest box under it, or else the nearest box within GAP_PX on screen. */
export function pickBox(boxes: readonly Box[], depth: (id: string) => number, x: number, y: number, k: number): string | undefined {
  return deepestAt(boxes, depth, x, y) ?? nearestBox(boxes, depth, x, y, GAP_PX / k);
}

export interface GestureInput {
  /** The node the map has open now. Its children are drawn. */
  open: string;
  camera: Camera;
  /** The world rectangle the camera shows. Its middle is the point a non-wheel gesture looks at. */
  visible: Rect;
  /** The world point under the pointer at the last wheel event of the gesture, when the gesture was a wheel. */
  point?: { x: number; y: number };
  /** The camera's scale when the gesture began. A gesture that ends above it may open a child. */
  gestureK: number;
  /** The boxes drawn now. */
  boxes: readonly Box[];
  /** The drawn rectangles, by node id. */
  rects: ReadonlyMap<string, Rect>;
  parentOf: (id: string) => string | undefined;
  depth: (id: string) => number;
}

/**
 * The node that should be open after a gesture ends. The open node stays open until it is narrower than 200 px on
 * screen; a node under the point opens once it is wider than 240 px (nextOpen). When nothing stays open, the open
 * node's parent is open instead, and the root stays the root. The result is `input.open` when nothing changes.
 */
export function openAfterGesture(input: GestureInput): string {
  const { open, camera, visible, gestureK, boxes, rects, parentOf, depth } = input;
  const at = input.point ?? { x: visible.x + visible.w / 2, y: visible.y + visible.h / 2 };
  const under = pickBox(boxes, depth, at.x, at.y, camera.k);
  const underRect = under === undefined ? undefined : rects.get(under);
  // The root is always open, so it is never the node that stays open; going up from it stays at it.
  const parent = parentOf(open);
  const cur = parent === undefined ? null : open;
  const curRect = cur === null ? undefined : rects.get(cur);
  // Only a gesture that zoomed in or panned may open a child. A zoom out would otherwise reopen the child it just left.
  const mayOpen = camera.k >= gestureK;
  const next = nextOpen(
    cur,
    curRect ? curRect.w * camera.k : null,
    mayOpen && under !== undefined && underRect ? { id: under, width: underRect.w * camera.k } : null,
  );
  return next ?? parent ?? open;
}
