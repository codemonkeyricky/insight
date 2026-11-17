import { describe, expect, it } from "vitest";
import { CARD_CALLERS_ROOM, CARD_CHAR_W, CARD_GAP, CARD_GLYPH_CHARS, CARD_H, CARD_MAX_W, CARD_MIN_W, CARD_NAME_PAD, CARD_PAD_BOTTOM, CARD_PAD_TOP, CARD_WRAP_W, cardWidth, gridRootsLayout } from "../src/roots-grid.js";
import type { Scene, SceneNode } from "../src/scene.js";

function flat(labels: string[]): Scene {
  const nodes = new Map<string, SceneNode>();
  const ids = labels.map((l, i) => `f${i}`);
  nodes.set("root", { id: "root", kind: "project", label: "Project", children: ids, parent: undefined } as unknown as SceneNode);
  labels.forEach((l, i) => nodes.set(ids[i]!, { id: ids[i]!, kind: "function", label: l, children: [], parent: "root" } as unknown as SceneNode));
  return { root: "root", nodes, edges: [], levels: {} } as unknown as Scene;
}

describe("cardWidth", () => {
  it("reserves the compact Callers button's room and the padding beyond the name's characters", () => {
    // the glyph (2 characters), the label padding (20 px) and the button's room (52 px) sit beside the name's 8 px characters
    expect(cardWidth("settleChains")).toBe(8 * ("settleChains".length + 2) + 20 + 52);
  });

  it("keeps no button room for a card without a Callers button (the more card)", () => {
    const label = "x".repeat(20);
    expect(cardWidth(label, false)).toBe(8 * (label.length + 2) + 20);
    expect(cardWidth(label)).toBe(cardWidth(label, false) + 52);
  });

  it("fits the name between the minimum and the maximum", () => {
    expect(cardWidth("")).toBe(CARD_MIN_W);
    expect(cardWidth("a".repeat(60))).toBe(CARD_MAX_W);
    const mid = cardWidth("settleChains");
    expect(mid).toBeGreaterThanOrEqual(CARD_MIN_W);
    expect(mid).toBeLessThanOrEqual(CARD_MAX_W);
  });

  // The width ZoomMap needs for a name to fit whole at 1x: its budget is the width less the button's room and the padding,
  // and the ƒ glyph takes two characters of it (see ZoomMap's card), so the name needs (length + 2) characters of 8 px.
  it.each([["a"], ["settle"], ["settleChains"], ["bodyCountOfTheActuatorChain"], ["linkPlateLongNameHere"]])(
    "is wide enough for the whole name %s beside its compact button",
    (name) => {
      const needed = CARD_CHAR_W * (name.length + CARD_GLYPH_CHARS) + CARD_NAME_PAD + CARD_CALLERS_ROOM;
      const w = cardWidth(name);
      expect(w).toBeGreaterThanOrEqual(Math.min(CARD_MAX_W, needed));
      if (needed <= CARD_MAX_W) expect(w).toBeGreaterThanOrEqual(needed);
    },
  );
});

describe("gridRootsLayout: the shown name sizes a card", () => {
  it("a card with a stem line is as wide as its shown name, which carries the stem", () => {
    const sc = flat(["main"]);
    const n = sc.nodes.get("f0") as SceneNode;
    sc.nodes.set("f0", { ...n, shownName: "main · triaxial-tourbillon" });
    const slot = gridRootsLayout(sc).containers[sc.root]?.slots[0];
    expect(slot?.w).toBe(cardWidth("main · triaxial-tourbillon"));
    expect(slot?.w).toBeGreaterThan(cardWidth("main"));
  });
});

describe("gridRootsLayout: room on the left", () => {
  it("places the card `left` further right and keeps the next card clear", () => {
    const sc = flat(["alpha", "beta"]);
    const plain = gridRootsLayout(sc).containers.root!.slots;
    const withLeft = gridRootsLayout(sc, new Map([["f0", { left: 120, w: 30, h: 50 }]])).containers.root!.slots;
    expect(withLeft[0]!.x).toBe(plain[0]!.x + 120);
    expect(withLeft[1]!.x).toBe(plain[1]!.x + 120 + 30);
    expect(withLeft[0]!.x - 16).toBeGreaterThanOrEqual(120);
  });
});

describe("gridRootsLayout", () => {
  it("lays cards in rows of uniform height, top-left aligned, inside the padding", () => {
    const labels = Array.from({ length: 21 }, (_, i) => `fn${i}`);
    const layout = gridRootsLayout(flat(labels));
    const c = layout.containers.root!;
    expect(c.slots).toHaveLength(21);
    for (const s of c.slots) {
      expect(s.h).toBe(CARD_H);
      expect(s.y).toBeGreaterThanOrEqual(CARD_PAD_TOP);
      expect(s.x + s.w).toBeLessThanOrEqual(CARD_WRAP_W + 16);
    }
    expect(Math.min(...c.slots.map((s) => s.x))).toBe(16);
    expect(Math.min(...c.slots.map((s) => s.y))).toBe(CARD_PAD_TOP);
    const bottom = Math.max(...c.slots.map((s) => s.y + s.h));
    expect(c.h).toBe(bottom + CARD_PAD_BOTTOM);
  });

  it("never overlaps two cards", () => {
    const labels = ["beginJog", "bodyCountOfTheActuatorChain", "x", "settle", "linkPlateLongNameHere", "tick", "jog", "jogRoot"];
    const { slots } = gridRootsLayout(flat(labels)).containers.root!;
    for (let i = 0; i < slots.length; i++)
      for (let j = i + 1; j < slots.length; j++) {
        const a = slots[i]!;
        const b = slots[j]!;
        const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
        expect(apart).toBe(true);
      }
    expect(slots.every((s, i) => i === 0 || s.y >= slots[0]!.y)).toBe(true);
    expect(CARD_GAP).toBeGreaterThan(0);
  });

  it("is empty for a scene with no roots", () => {
    const c = gridRootsLayout(flat([])).containers.root!;
    expect(c.slots).toHaveLength(0);
  });
});
