import { describe, expect, it } from "vitest";
import { calloutD } from "../src/zoom/connector.js";

describe("callout geometry", () => {
  it("is a four-cornered wedge: the anchor's top and bottom, then the expansion's bottom and top", () => {
    expect(calloutD(100, 40, 80, 300, 52, 200)).toBe("M100 40 L300 52 L300 200 L100 80 Z");
  });

  it("starts at the anchor's top edge and closes back to it", () => {
    const d = calloutD(10, 20, 30, 90, 25, 60);
    expect(d.startsWith("M10 20 ")).toBe(true);
    expect(d.endsWith(" Z")).toBe(true);
  });
});
