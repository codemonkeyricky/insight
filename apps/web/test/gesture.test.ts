import { describe, expect, it } from "vitest";
import { pickBox } from "../src/zoom/gesture.js";

// A small tree: the project holds a folder "dir" (with a file "a" under it) and a file "b". Boxes are drawn at scale 1
// with widths in world units, so a box's width on screen is its width times the camera's k.
const depths: Record<string, number> = { project: 0, dir: 1, a: 2, b: 1 };
const depth = (id: string) => depths[id] ?? -1;

const rectsList = {
  project: { x: 0, y: 0, w: 1000, h: 1000 },
  dir: { x: 0, y: 0, w: 400, h: 400 },
  a: { x: 20, y: 20, w: 200, h: 200 },
  b: { x: 600, y: 600, w: 300, h: 300 },
};
const boxes = [
  { id: "dir", ...rectsList.dir },
  { id: "a", ...rectsList.a },
  { id: "b", ...rectsList.b },
];

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
