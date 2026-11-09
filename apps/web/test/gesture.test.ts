import { describe, expect, it } from "vitest";
import { openAfterGesture, pickBox, type GestureInput } from "../src/zoom/gesture.js";

// A small tree: the project holds a folder "dir" (with a file "a" under it) and a file "b". Boxes are drawn at scale 1
// with widths in world units, so a box's width on screen is its width times the camera's k.
const parents: Record<string, string | undefined> = { project: undefined, dir: "project", a: "dir", b: "project" };
const parentOf = (id: string) => parents[id];
const depths: Record<string, number> = { project: 0, dir: 1, a: 2, b: 1 };
const depth = (id: string) => depths[id] ?? -1;

const rectsList = {
  project: { x: 0, y: 0, w: 1000, h: 1000 },
  dir: { x: 0, y: 0, w: 400, h: 400 },
  a: { x: 20, y: 20, w: 200, h: 200 },
  b: { x: 600, y: 600, w: 300, h: 300 },
};
const rects = new Map(Object.entries(rectsList));
const boxes = [
  { id: "dir", ...rectsList.dir },
  { id: "a", ...rectsList.a },
  { id: "b", ...rectsList.b },
];

/** A gesture input at camera scale k, with the view's middle at (cx, cy) in world units. */
function input(over: Partial<GestureInput> & { k: number }): GestureInput {
  const { k, ...rest } = over;
  const visible = { x: 0, y: 0, w: 1000, h: 1000 };
  return {
    open: "project",
    camera: { k, x: 0, y: 0 },
    visible,
    gestureK: 1,
    boxes,
    rects,
    parentOf,
    depth,
    ...rest,
  };
}

describe("pickBox", () => {
  it("picks the deepest box under the point", () => {
    expect(pickBox(boxes, depth, 50, 50, 1)).toBe("a");
  });

  it("falls back to the nearest box within GAP_PX on screen", () => {
    // (430, 430) is in the gap beyond dir (ends at 400): 30 world units away at k 1, inside 60 px.
    expect(pickBox(boxes, depth, 430, 430, 1)).toBe("dir");
    // At k 4 the same gap is 120 world units wide on screen per 30 units, so the 60 px allowance is 15 world units.
    expect(pickBox(boxes, depth, 430, 430, 4)).toBeUndefined();
  });
});

describe("openAfterGesture", () => {
  it("zooming in over a closed container opens it", () => {
    // Open is the project; the pointer is over dir (but not a), which is 400 px wide at k 1: above the 240 px threshold.
    const next = openAfterGesture(input({ k: 1, point: { x: 300, y: 300 } }));
    expect(next).toBe("dir");
  });

  it("does not open a child when the gesture zoomed out", () => {
    // Zoomed out from k 2 to k 1: dir is 400 px wide, but a zoom out may not open a child.
    const next = openAfterGesture(input({ k: 1, gestureK: 2, point: { x: 300, y: 300 } }));
    expect(next).toBe("project");
  });

  it("keeps the open node while it is at least 200 px wide (hysteresis)", () => {
    // dir at k 0.55 is 220 px wide: below the 240 px open threshold, above the 200 px close threshold.
    const next = openAfterGesture(input({ open: "dir", k: 0.55, point: { x: 300, y: 300 } }));
    expect(next).toBe("dir");
  });

  it("collapses to the parent when the open node is narrower than 200 px", () => {
    // dir at k 0.4 is 160 px wide: narrower than the close threshold, so the open node falls back to its parent.
    const next = openAfterGesture(input({ open: "dir", k: 0.4, point: { x: 300, y: 300 } }));
    expect(next).toBe("project");
  });

  it("zooming out below the open node collapses it, and the root stays the root", () => {
    expect(openAfterGesture(input({ open: "a", k: 0.5, point: { x: 100, y: 100 } }))).toBe("dir");
    expect(openAfterGesture(input({ open: "project", k: 0.01, point: { x: 100, y: 100 } }))).toBe("project");
  });

  it("uses the middle of the view for a gesture without a pointer", () => {
    // The view's middle is (750, 750) at k 1: inside b (600..900), which is 300 px wide, so b opens.
    const next = openAfterGesture(input({ k: 1, visible: { x: 600, y: 600, w: 300, h: 300 } }));
    expect(next).toBe("b");
  });

  it("keeps the open node when the view's middle is over nothing close", () => {
    // The middle (500, 500) at k 1 is 141 px from b and inside nothing: no box opens, and the open node stays.
    const next = openAfterGesture(input({ k: 1, visible: { x: 350, y: 350, w: 300, h: 300 } }));
    expect(next).toBe("project");
  });

  it("is deterministic: the same input gives the same node", () => {
    const g = input({ k: 1, point: { x: 100, y: 100 } });
    expect(openAfterGesture(g)).toBe(openAfterGesture(g));
  });
});
