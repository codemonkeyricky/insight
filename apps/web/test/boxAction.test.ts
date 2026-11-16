import { describe, expect, it } from "vitest";
import { boxAction, isTouchPointer } from "../src/zoom/boxAction";
import { zoomTakes } from "../src/zoom/gesture";

const chartClosed = { hasChart: true, open: false };
const chartOpen = { hasChart: true, open: true };
const noChart = { hasChart: false };
const touchClosed = { hasChart: true, open: false, touch: true };
const touchOpen = { hasChart: true, open: true, touch: true };

describe("boxAction click", () => {
  it("only selects a box with a chart, open or closed, when the click is a mouse's", () => {
    expect(boxAction("click", chartClosed)).toBe("select");
    expect(boxAction("click", chartOpen)).toBe("select");
    expect(boxAction("click", { ...chartClosed, touch: false })).toBe("select");
  });

  it("navigates a click on a box with no chart, as it always did (fit the camera)", () => {
    expect(boxAction("click", noChart)).toBe("navigate");
    expect(boxAction("click", { ...noChart, touch: true })).toBe("navigate");
  });

  it("opens the chart beside a box on a touch or pen tap, as a double-click does", () => {
    expect(boxAction("click", touchClosed)).toBe("open-side");
    expect(boxAction("click", touchOpen)).toBe("close-side");
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

describe("isTouchPointer", () => {
  it("is true for a touch or a pen, false for a mouse", () => {
    expect(isTouchPointer("touch")).toBe(true);
    expect(isTouchPointer("pen")).toBe(true);
    expect(isTouchPointer("mouse")).toBe(false);
    expect(isTouchPointer("")).toBe(false);
  });
});

describe("zoomTakes on touch", () => {
  const box = (sel: string) => ({ closest: (s: string) => (s.includes(sel) ? {} : null) });
  it("refuses a double-tap's touchend on a function box, so d3 does not zoom the map on it", () => {
    expect(zoomTakes({ type: "touchend", target: box(".zm-box") })).toBe(false);
  });
  it("takes a touch that starts a pan on empty map, and a touchend that is not on a box", () => {
    expect(zoomTakes({ type: "touchstart", target: box(".zm-box") })).toBe(true);
    expect(zoomTakes({ type: "touchend", target: { closest: () => null } })).toBe(true);
  });
});
