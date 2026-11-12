// The roots-only map's layout: each root function is a uniform card, and the cards wrap in a grid, top-left aligned. The
// grid leaves room the map's own controls take (the title chip and the key plan at the bottom right, the Show button at the
// top left, the roots switch at the bottom left), so no card sits under them at the default fit. Pure, so it is unit tested.
import type { Scene, SceneLayout } from "./scene.js";
import type { ContainerLayout, Size, Slot } from "./zoom-layout.js";

/** A card's height: one name line and one file line. */
export const CARD_H = 56;
/** A card's width: the full name, between these bounds. Only a name past the maximum is truncated. */
export const CARD_MIN_W = 160;
export const CARD_MAX_W = 320;
/** The width of a monospace character at the card's name size (12 px), and the card's inner padding. */
const CHAR_W = 8;
const CARD_PAD_W = 28;
/** The gap between cards, both ways. */
export const CARD_GAP = 12;
/** The grid's width: it wraps here, so the grid fits a 1600 px window's map at 1x. */
export const CARD_WRAP_W = 800;
/** The room the grid keeps clear of the map's controls: the Show button (top), the title chip and key plan (bottom right). */
export const CARD_PAD_TOP = 64;
export const CARD_PAD_BOTTOM = 170;
export const CARD_PAD_SIDE = 16;

/** A card's width for a name: the name's width, between CARD_MIN_W and CARD_MAX_W. */
export function cardWidth(label: string): number {
  const w = Math.ceil(label.length * CHAR_W) + CARD_PAD_W;
  return Math.min(CARD_MAX_W, Math.max(CARD_MIN_W, w));
}

/**
 * The room an opened card takes beyond its own box, for the expansions drawn beside it: the width from the card's right
 * edge and the height from its top. A card with no entry takes only its own box. The web computes these from the open
 * expansions (footprintOf in apps/web/src/zoom/expand.ts).
 */
export type Footprint = ReadonlyMap<string, Size>;

/**
 * The roots-only layout of a flat scene: the root's children are the cards, wrapped in rows of at most CARD_WRAP_W, in
 * the order the scene lists them. The root's container is the grid plus the padding above. A card's slot is its own box;
 * the room in `footprint` is kept clear beside it, so the next card starts past it. Deterministic.
 */
export function gridRootsLayout(scene: Scene, footprint?: Footprint): SceneLayout {
  const rootNode = scene.nodes.get(scene.root);
  const kids = rootNode?.children ?? [];
  const slots: Slot[] = [];
  let x = 0;
  let y = 0;
  let rowH = 0;
  let width = 0;
  for (const id of kids) {
    const n = scene.nodes.get(id);
    const w = cardWidth(n?.label ?? id);
    const room = footprint?.get(id);
    const outerW = w + (room?.w ?? 0);
    const outerH = Math.max(CARD_H, room?.h ?? 0);
    if (x > 0 && x + outerW > CARD_WRAP_W) {
      y += rowH + CARD_GAP;
      x = 0;
      rowH = 0;
    }
    slots.push({ id, x: CARD_PAD_SIDE + x, y: CARD_PAD_TOP + y, w, h: CARD_H });
    x += outerW + CARD_GAP;
    rowH = Math.max(rowH, outerH);
    width = Math.max(width, x - CARD_GAP);
  }
  const height = kids.length === 0 ? 0 : y + rowH;
  const container: ContainerLayout = {
    w: CARD_PAD_SIDE + Math.max(width, 0) + CARD_PAD_SIDE,
    h: CARD_PAD_TOP + height + CARD_PAD_BOTTOM,
    slots,
  };
  return { containers: { [scene.root]: container } };
}
