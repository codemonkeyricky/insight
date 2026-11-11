import { describe, expect, it } from "vitest";
import { popDelay } from "../src/zoom/pop.js";

describe("popDelay", () => {
  it("starts the first card at 0 and caps the delay at 260 ms from the twelfth card on", () => {
    expect(popDelay(0)).toBe(0);
    expect(popDelay(12)).toBe(260);
    expect(popDelay(50)).toBe(260);
  });

  it("never goes back as the rank grows", () => {
    for (let r = 0; r < 20; r++) expect(popDelay(r + 1)).toBeGreaterThanOrEqual(popDelay(r));
  });

  it("steps further apart early than late", () => {
    expect(popDelay(1) - popDelay(0)).toBeGreaterThan(popDelay(12) - popDelay(11));
  });
});
