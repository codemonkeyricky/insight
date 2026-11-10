import { describe, expect, it } from "vitest";
import { CONNECTOR_HEAD, CONNECTOR_WIDTH, connectorD, headD } from "../src/zoom/connector.js";

describe("connector geometry", () => {
  it("runs a cubic from the start to the end, leaving and arriving horizontally", () => {
    expect(connectorD(100, 40, 300, 60)).toBe("M100 40 C200 40 200 60 300 60");
  });

  it("the path starts and ends at the given points", () => {
    const d = connectorD(10, 20, 90, 5);
    expect(d.startsWith("M10 20 ")).toBe(true);
    expect(d.endsWith(" 90 5")).toBe(true);
  });

  it("the head's tip is the end point, and it points back along the line", () => {
    expect(headD(300, 60, 7)).toBe("M300 60 L293 56.5 L293 63.5 Z");
  });

  it("is 1.5 px wide with a 7 px head by default", () => {
    expect(CONNECTOR_WIDTH).toBe(1.5);
    expect(CONNECTOR_HEAD).toBe(7);
  });
});
