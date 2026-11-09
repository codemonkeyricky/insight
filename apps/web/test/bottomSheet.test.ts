import { describe, expect, it } from "vitest";
import { landingFor, resolveHeight, restHeights, rubberband, SHEET_MID, SHEET_TOP } from "../src/components/sheet/bottomSheet.js";
import { momentumOffset } from "../src/zoom/spring.js";

const VH = 844;

describe("rest heights", () => {
  it("puts the middle rest at 40% and the top rest at 90% of the viewport, closed at 0", () => {
    const at = restHeights(VH);
    expect(SHEET_MID).toBe(0.4);
    expect(SHEET_TOP).toBe(0.9);
    expect(at.closed).toBe(0);
    expect(at.mid).toBeCloseTo(337.6, 6);
    expect(at.top).toBeCloseTo(759.6, 6);
  });
});

describe("landing (snap from the projected end)", () => {
  const at = restHeights(VH);

  it("keeps a slow release where it is, snapping to the nearest rest", () => {
    expect(landingFor(at.mid, 0, VH)).toBe("mid");
    expect(landingFor(at.mid + 40, 0, VH)).toBe("mid");
    expect(landingFor(at.top - 10, 0, VH)).toBe("top");
    expect(landingFor(60, 0, VH)).toBe("closed");
  });

  it("carries a fast upward flick from 40% to 90%", () => {
    // A 4000 px/s flick projects about 2000 px on: well past the top rest.
    expect(landingFor(at.mid, 4000, VH)).toBe("top");
    // A flick of 600 px/s projects 300 px: 338 + 300 lands between the rests, nearer the top.
    expect(landingFor(at.mid, 600, VH)).toBe("top");
  });

  it("does not move on a gentle upward push", () => {
    // 200 px/s projects 100 px, 338 + 100 is still nearer 40%.
    expect(landingFor(at.mid, 200, VH)).toBe("mid");
  });

  it("closes on a downward swipe past the threshold, and not on a short one", () => {
    // The closed threshold is the midpoint between closed and 40%: about 169 px.
    expect(landingFor(150, 0, VH)).toBe("closed");
    expect(landingFor(200, 0, VH)).toBe("mid");
    // A fast downward flick from 40% closes even when the finger is still near 40%.
    expect(landingFor(at.mid, -1500, VH)).toBe("closed");
    expect(landingFor(at.mid, -100, VH)).toBe("mid");
  });

  it("uses the projection, so a flick from just under the top rest reaches it", () => {
    expect(landingFor(at.top - 50, 400, VH)).toBe("top");
  });
});

describe("momentum projection", () => {
  it("is the Apple exponential form: (v/1000) * 0.998 / 0.002", () => {
    expect(momentumOffset(1000)).toBeCloseTo(499, 6);
    expect(momentumOffset(-1000)).toBeCloseTo(-499, 6);
    expect(momentumOffset(0)).toBe(0);
  });
});

describe("rubber band", () => {
  it("is zero at the bound and rises with overshoot", () => {
    expect(rubberband(0, VH)).toBe(0);
    expect(rubberband(-5, VH)).toBe(0);
    expect(rubberband(10, VH)).toBeGreaterThan(0);
    expect(rubberband(100, VH)).toBeGreaterThan(rubberband(10, VH));
  });

  it("resists more the further it goes, and never passes one viewport", () => {
    const first = rubberband(50, VH);
    const second = rubberband(100, VH) - rubberband(50, VH);
    expect(second).toBeLessThan(first);
    expect(rubberband(1e9, VH)).toBeLessThan(VH);
  });
});

describe("resolved height (rubber-banded past the ends)", () => {
  const top = VH * SHEET_TOP;

  it("passes heights inside the range through unchanged", () => {
    expect(resolveHeight(300, VH)).toBe(300);
    expect(resolveHeight(top, VH)).toBe(top);
    expect(resolveHeight(0, VH)).toBe(0);
  });

  it("gives past the top rest, and less than the finger moves", () => {
    const shown = resolveHeight(top + 120, VH);
    expect(shown).toBeGreaterThan(top);
    expect(shown).toBeLessThan(top + 120);
  });

  it("gives below closed as well, mirroring the top band", () => {
    const shown = resolveHeight(-80, VH);
    expect(shown).toBeLessThan(0);
    expect(shown).toBeGreaterThan(-80);
  });
});
