import { describe, expect, it } from "vitest";
import { LABEL_CHAR_PX, LABEL_PAD_PX, bucketScale, fitLabel, headerLabels, labelChars, lodBucket } from "../src/zoom/lod.js";
import { nearestBox, type Box } from "../src/zoom/source.js";

/** A screen width that gives exactly `n` characters at the default char width and padding. */
const widthFor = (n: number) => LABEL_PAD_PX + LABEL_CHAR_PX * n + 0.5;

describe("labelChars", () => {
  it("counts the characters that fit after the padding", () => {
    expect(labelChars(widthFor(12))).toBe(12);
    expect(labelChars(124, 10, 24)).toBe(10);
    expect(labelChars(124 + 3, 10, 24)).toBe(10);
  });

  it("is zero when the box has no room for the padding", () => {
    expect(labelChars(0)).toBe(0);
    expect(labelChars(LABEL_PAD_PX)).toBe(0);
    expect(labelChars(-50)).toBe(0);
    expect(labelChars(Number.NaN)).toBe(0);
  });

  it("never shrinks as the box grows", () => {
    let last = 0;
    for (let w = 0; w <= 600; w += 3) {
      const n = labelChars(w);
      expect(n).toBeGreaterThanOrEqual(last);
      last = n;
    }
  });
});

describe("fitLabel", () => {
  it("returns a label that fits whole", () => {
    expect(fitLabel("main", 10)).toBe("main");
    expect(fitLabel("abcde", 5)).toBe("abcde");
    expect(fitLabel("", 5)).toBe("");
  });

  it("cuts a label that is too long to maxChars, the last character an ellipsis", () => {
    expect(fitLabel("abcdefghij", 6)).toBe("abcde…");
    expect(fitLabel("doSomethingLong", 8)).toBe("doSomet…");
    expect(fitLabel("abcdefgh", 5)).toBe("abcd…");
  });

  it("cuts a file-like label from the front, so the file name stays visible", () => {
    expect(fitLabel("src/lib/ap.ts", 6)).toBe("…ap.ts");
    expect(fitLabel("foo.bar.baz", 6)).toBe("…r.baz");
    expect(fitLabel("packages/core/src/diff.ts", 10)).toBe("…c/diff.ts");
  });

  it("returns null when fewer than 5 characters fit", () => {
    expect(fitLabel("anything", 4)).toBeNull();
    expect(fitLabel("anything", 0)).toBeNull();
    expect(fitLabel("ab", 3)).toBeNull();
    expect(fitLabel("ab", Number.NaN)).toBeNull();
  });

  it("is never longer than maxChars, and keeps at least 4 characters plus the ellipsis when cut", () => {
    const labels = ["", "x", "main", "parseFunctionArguments", "src/lib/deep/path/ap.ts", "a.b", "中文字符测试一二三四五六"];
    for (const label of labels) {
      for (let max = 0; max <= 30; max++) {
        const out = fitLabel(label, max);
        if (out === null) {
          expect(max).toBeLessThan(5);
          continue;
        }
        expect(out.length).toBeLessThanOrEqual(Math.max(max, label.length));
        expect(out.length).toBeLessThanOrEqual(max);
        if (out !== label) {
          expect(out).toContain("…");
          expect(out.length - 1).toBeGreaterThanOrEqual(4);
        }
      }
    }
  });
});

describe("lodBucket", () => {
  it("is quarter-octave buckets, zero at scale 1", () => {
    expect(lodBucket(1)).toBe(0);
    expect(lodBucket(2)).toBe(4);
    expect(lodBucket(0.5)).toBe(-4);
    expect(lodBucket(Math.SQRT2)).toBe(2);
  });

  it("is monotonic in the scale", () => {
    let last = -Infinity;
    for (let k = 0.02; k <= 16; k *= 1.01) {
      const b = lodBucket(k);
      expect(b).toBeGreaterThanOrEqual(last);
      last = b;
    }
  });

  it("changes only once the zoom moves a quarter-octave", () => {
    expect(lodBucket(2 ** 0.1)).toBe(lodBucket(1));
    expect(lodBucket(2 ** 0.2)).toBe(lodBucket(1) + 1);
  });

  it("maps back to a scale within an eighth of an octave of the zoom", () => {
    for (const k of [0.02, 0.3, 1, 1.7, 5, 16]) {
      expect(Math.abs(Math.log2(bucketScale(lodBucket(k))) - Math.log2(k))).toBeLessThanOrEqual(1 / 8 + 1e-9);
    }
  });
});

describe("headerLabels", () => {
  it("keeps the detail and gives the label the rest of the width", () => {
    expect(headerLabels("main", "12 functions", widthFor(20))).toEqual({ label: "main", detail: "12 functions" });
    expect(headerLabels("abcdefghijklmnop", "12 functions", widthFor(20))).toEqual({ label: "abcde…", detail: "12 functions" });
  });

  it("drops the detail first when the label would keep less than 5 characters beside it", () => {
    expect(headerLabels("main", "12 functions", widthFor(14))).toEqual({ label: "main", detail: null });
  });

  it("does not cut the detail: one that does not fit whole is dropped", () => {
    expect(headerLabels("main", "12 functions in this thread", widthFor(10))).toEqual({ label: "main", detail: null });
  });

  it("has no detail when there is none, and no label when there is no room", () => {
    expect(headerLabels("main", undefined, widthFor(10))).toEqual({ label: "main", detail: null });
    expect(headerLabels("main", "", widthFor(10))).toEqual({ label: "main", detail: null });
    expect(headerLabels("main", undefined, widthFor(3))).toEqual({ label: null, detail: null });
  });
});

describe("nearestBox", () => {
  const depths: Record<string, number> = { a: 1, b: 1, c: 1, deep: 2, shallow: 1, z: 1, r: 1 };
  const depth = (id: string) => depths[id] ?? -1;

  it("prefers a box that holds the point (distance 0) over a nearer-edge box at the same depth", () => {
    const boxes: Box[] = [
      { id: "a", x: 0, y: 0, w: 100, h: 100 },
      { id: "b", x: 105, y: 0, w: 10, h: 10 },
    ];
    expect(nearestBox(boxes, depth, 50, 50, 60)).toBe("a");
  });

  it("returns the box whose edge is nearest to the point", () => {
    const boxes: Box[] = [
      { id: "a", x: 0, y: 0, w: 10, h: 10 },
      { id: "b", x: 30, y: 0, w: 10, h: 10 },
    ];
    expect(nearestBox(boxes, depth, 22, 5, 60)).toBe("b");
    expect(nearestBox(boxes, depth, 12, 5, 60)).toBe("a");
  });

  it("measures the distance to the rectangle, corner to corner", () => {
    const boxes: Box[] = [{ id: "a", x: 0, y: 0, w: 10, h: 10 }];
    // (13, 14) is 3 right and 4 below the corner (10, 10): distance 5.
    expect(nearestBox(boxes, depth, 13, 14, 5)).toBe("a");
    expect(nearestBox(boxes, depth, 13, 14, 4.9)).toBeUndefined();
  });

  it("prefers the deepest depth that has a box within maxDist, even when a shallower box is nearer", () => {
    const boxes: Box[] = [
      { id: "a", x: 0, y: 0, w: 100, h: 100 },
      { id: "deep", x: 40, y: 0, w: 10, h: 10 },
    ];
    // From (5, 5): the shallow box holds it (distance 0) and the deep box is 35 away.
    expect(nearestBox(boxes, depth, 5, 5, 50)).toBe("deep");
    expect(nearestBox(boxes, depth, 5, 5, 20)).toBe("a");
  });

  it("excludes boxes farther than maxDist, and includes one exactly at maxDist", () => {
    const boxes: Box[] = [{ id: "a", x: 10, y: 0, w: 10, h: 10 }];
    expect(nearestBox(boxes, depth, 0, 5, 9.99)).toBeUndefined();
    expect(nearestBox(boxes, depth, 0, 5, 10)).toBe("a");
    expect(nearestBox([], depth, 0, 0, 100)).toBeUndefined();
  });

  it("breaks a tie on distance by the smaller box, then by the smaller id", () => {
    // Both boxes are 10 away from (20, 5); the right box is smaller, so it wins although its id is larger.
    const bySize: Box[] = [
      { id: "a", x: 0, y: 0, w: 10, h: 10 },
      { id: "z", x: 30, y: 0, w: 2, h: 10 },
    ];
    expect(nearestBox(bySize, depth, 20, 5, 60)).toBe("z");
    // Equal distance and equal area: the smaller id wins.
    const byId: Box[] = [
      { id: "b", x: 0, y: 0, w: 10, h: 10 },
      { id: "a", x: 30, y: 0, w: 10, h: 10 },
    ];
    expect(nearestBox(byId, depth, 20, 5, 60)).toBe("a");
  });
});
