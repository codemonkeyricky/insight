import { describe, expect, it } from "vitest";
import { calloutD } from "../src/zoom/connector.js";

describe("callout geometry", () => {
  it("is a curved ribbon: the anchor's top, a cubic to the expansion's top, down its left edge, a cubic back to the anchor's bottom", () => {
    expect(calloutD(100, 40, 80, 300, 52, 200)).toBe("M100 40 C200 40 200 52 300 52 L300 200 C200 200 200 80 100 80 Z");
  });

  it("starts at the anchor's top edge and closes back to it", () => {
    const d = calloutD(10, 20, 30, 90, 25, 60);
    expect(d.startsWith("M10 20 ")).toBe(true);
    expect(d.endsWith(" Z")).toBe(true);
  });
});
