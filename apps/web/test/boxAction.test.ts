import { describe, expect, it } from "vitest";
import { boxAction } from "../src/zoom/boxAction";

const chartClosed = { hasChart: true, open: false };
const chartOpen = { hasChart: true, open: true };
const noChart = { hasChart: false };

describe("boxAction click", () => {
  it("only selects, whether or not the box has a chart or one is open", () => {
    expect(boxAction("click", chartClosed)).toBe("select");
    expect(boxAction("click", chartOpen)).toBe("select");
    expect(boxAction("click", noChart)).toBe("select");
  });
});

describe("boxAction double-click", () => {
  it("opens a closed chart in a box beside it", () => {
    expect(boxAction("dblclick", chartClosed)).toBe("open-side");
  });
  it("closes that side box when the chart is open", () => {
    expect(boxAction("dblclick", chartOpen)).toBe("close-side");
  });
  it("opens a box with no chart as a link does", () => {
    expect(boxAction("dblclick", noChart)).toBe("navigate");
  });
  it("treats a missing open flag as closed", () => {
    expect(boxAction("dblclick", { hasChart: true })).toBe("open-side");
  });
});

describe("boxAction enter", () => {
  it("toggles the chart in place, open or closed, as before", () => {
    expect(boxAction("enter", chartClosed)).toBe("toggle");
    expect(boxAction("enter", chartOpen)).toBe("toggle");
  });
  it("opens a box with no chart as a link does", () => {
    expect(boxAction("enter", noChart)).toBe("navigate");
  });
});
