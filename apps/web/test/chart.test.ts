import { describe, expect, it } from "vitest";
import { CHART_MIN_PX, chartShown, rangeOf, selectionRange } from "../src/zoom/chart.js";
import { lineClass } from "../src/components/FileViewer.js";

describe("chartShown", () => {
  it("draws a chart only when it is at least CHART_MIN_PX wide on screen", () => {
    expect(chartShown(CHART_MIN_PX)).toBe(true);
    expect(chartShown(CHART_MIN_PX + 200)).toBe(true);
    expect(chartShown(CHART_MIN_PX - 1)).toBe(false);
    expect(chartShown(0)).toBe(false);
  });
});

describe("rangeOf and selectionRange", () => {
  const span = { start: [4, 0] as [number, number], end: [9, 3] as [number, number] };

  it("turns a 0-based span into 1-based inclusive lines", () => {
    expect(rangeOf(span)).toEqual({ start: 5, end: 10 });
  });

  it("prefers the construct, then the whole function, then the definition line", () => {
    const fn = { start: [0, 0] as [number, number], end: [20, 0] as [number, number] };
    expect(selectionRange({ start: [6, 0], end: [8, 0] }, fn, 1)).toEqual({ start: 7, end: 9 });
    expect(selectionRange(undefined, fn, 1)).toEqual({ start: 1, end: 21 });
    expect(selectionRange(undefined, undefined, 3)).toEqual({ start: 3, end: 3 });
  });
});

describe("lineClass", () => {
  it("tints a range's lines and marks only the single line otherwise", () => {
    expect(lineClass(5, { range: { start: 4, end: 6 } })).toBe("hit-range");
    expect(lineClass(7, { range: { start: 4, end: 6 } })).toBeUndefined();
    expect(lineClass(4, { line: 4 })).toBe("hit");
    expect(lineClass(5, { line: 4 })).toBeUndefined();
  });

  it("keeps a flagged line's flag outside the range", () => {
    expect(lineClass(9, { range: { start: 4, end: 6 }, note: "x" })).toBe("flag");
  });
});
