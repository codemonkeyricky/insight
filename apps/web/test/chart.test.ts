import { describe, expect, it } from "vitest";
import { CHART_MIN_PX, chartShown, rangeOf, selectionRange } from "../src/zoom/chart.js";
import { lineClass } from "../src/components/FileViewer.js";

const open = { holdsChart: true, hasCharts: true, hasRef: true, expanded: true, widthPx: CHART_MIN_PX };

describe("chartShown", () => {
  it("draws a chart only when expanded and wide enough on screen", () => {
    expect(chartShown(open)).toBe(true);
    expect(chartShown({ ...open, expanded: false })).toBe(false);
    expect(chartShown({ ...open, widthPx: CHART_MIN_PX - 1 })).toBe(false);
  });

  it("needs a chart, a chart source and a function to load", () => {
    expect(chartShown({ ...open, holdsChart: false })).toBe(false);
    expect(chartShown({ ...open, hasCharts: false })).toBe(false);
    expect(chartShown({ ...open, hasRef: false })).toBe(false);
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
