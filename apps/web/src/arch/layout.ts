import type { ArchEdge, ArchModel, ArchPackage } from "@insight/lens-dependencies";

// Pure geometry for the Arch tab. The view draws what archLayout returns and keeps no sizes of its own.

export const ARCH_BOX_W = 170;
export const ARCH_BOX_H = 52;
/** Space between two columns, where the arrows run. */
export const ARCH_COL_GAP = 90;
export const ARCH_BOX_GAP = 18;
/** Margin on every side. It also holds the loop of an arrow between two packages in one column. */
export const ARCH_PAD = 24;
/** Room above the first box of a column for its layer title. */
export const ARCH_HEADER_H = 44;
/** How far a curve between two packages in one column reaches out past the boxes. */
const LOOP_MIN = 40;
/** Vertical offset of the two curves of a pair of opposite arrows, so they do not overlap. */
const BEND = 14;

export interface ArchBox {
  id: string;
  pkg: ArchPackage;
  /** Index into `columns`. */
  column: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ArchColumn {
  layer: string;
  index: number;
  x: number;
}

export interface ArchArrow {
  key: string;
  from: string;
  to: string;
  edge: ArchEdge;
  /** SVG path data, from the edge of the importing box to the edge of the imported one. */
  d: string;
  /** The middle of the curve, where the import count is written. */
  label: { x: number; y: number };
  /** Stroke width in px, 1 to 4. */
  width: number;
  /** True when the import is not exact, so the arrow is drawn dashed. */
  dashed: boolean;
  /** True when a rule violation runs along this arrow. */
  violation: boolean;
}

export interface ArchLayout {
  width: number;
  height: number;
  columns: ArchColumn[];
  boxes: ArchBox[];
  arrows: ArchArrow[];
}

/** The key of the arrow from one package to another. */
export const arrowKey = (from: string, to: string): string => `${from}\0${to}`;

/** Stroke width of an arrow: 1 px for one import, growing with log2 of the count, clamped to 4 px. */
/** The number on an arrow: its imports, or its calls with a "c" when it has no import the IR could see. */
export function arrowLabel(edge: { imports: number; calls: number }): string {
  return edge.imports > 0 ? String(edge.imports) : `${edge.calls}c`;
}

export function arrowWidth(imports: number): number {
  return Math.min(4, Math.max(1, 1 + Math.log2(Math.max(1, imports))));
}

/**
 * The layers that hold packages, one column each, in the model's layer order. Packages keep the order the model gives
 * them within a column, which is by path.
 */
export function archLayout(model: ArchModel): ArchLayout {
  const byLayer = new Map<string, ArchPackage[]>();
  for (const pkg of model.packages) {
    const list = byLayer.get(pkg.layer);
    if (list) list.push(pkg);
    else byLayer.set(pkg.layer, [pkg]);
  }
  const order = [...model.layers];
  for (const layer of byLayer.keys()) if (!order.includes(layer)) order.push(layer);

  const columns: ArchColumn[] = [];
  const boxes: ArchBox[] = [];
  const boxById = new Map<string, ArchBox>();
  let tallest = 0;
  for (const layer of order) {
    const pkgs = byLayer.get(layer);
    if (!pkgs || pkgs.length === 0) continue;
    const index = columns.length;
    const x = ARCH_PAD + index * (ARCH_BOX_W + ARCH_COL_GAP);
    columns.push({ layer, index, x });
    pkgs.forEach((pkg, row) => {
      const box: ArchBox = {
        id: pkg.id,
        pkg,
        column: index,
        x,
        y: ARCH_PAD + ARCH_HEADER_H + row * (ARCH_BOX_H + ARCH_BOX_GAP),
        w: ARCH_BOX_W,
        h: ARCH_BOX_H,
      };
      boxes.push(box);
      boxById.set(box.id, box);
    });
    tallest = Math.max(tallest, pkgs.length);
  }

  const cols = columns.length;
  const width = cols === 0 ? ARCH_PAD * 2 : ARCH_PAD * 2 + cols * ARCH_BOX_W + (cols - 1) * ARCH_COL_GAP;
  const stack = tallest === 0 ? 0 : tallest * ARCH_BOX_H + (tallest - 1) * ARCH_BOX_GAP;
  const height = ARCH_PAD * 2 + ARCH_HEADER_H + stack;

  const reverse = new Set(model.edges.map((e) => arrowKey(e.to, e.from)));
  const violating = new Set(model.violations.map((v) => arrowKey(v.from, v.to)));
  const arrows: ArchArrow[] = [];
  for (const edge of model.edges) {
    const a = boxById.get(edge.from);
    const b = boxById.get(edge.to);
    if (!a || !b) continue;
    const key = arrowKey(edge.from, edge.to);
    // Of two opposite arrows, the one from the smaller id bends up and the other down.
    const bend = reverse.has(key) ? (edge.from < edge.to ? -BEND : BEND) : 0;
    const geom = curve(a, b, bend);
    arrows.push({
      key,
      from: edge.from,
      to: edge.to,
      edge,
      d: geom.d,
      label: geom.label,
      width: arrowWidth(edge.imports > 0 ? edge.imports : edge.calls),
      dashed: edge.confidence !== "exact",
      violation: violating.has(key),
    });
  }

  return { width, height, columns, boxes, arrows };
}

/**
 * A cubic curve from the box `a` to the box `b`. It leaves `a` on the side facing `b` and enters `b` on the side facing
 * `a`. Boxes in one column leave and enter on their right sides, so the curve loops out to the right.
 */
function curve(a: ArchBox, b: ArchBox, bend: number): { d: string; label: { x: number; y: number } } {
  const sy = a.y + a.h / 2;
  const ey = b.y + b.h / 2;
  let sx: number;
  let ex: number;
  let dirS: number;
  let dirE: number;
  if (b.column > a.column) {
    sx = a.x + a.w;
    ex = b.x;
    dirS = 1;
    dirE = -1;
  } else if (b.column < a.column) {
    sx = a.x;
    ex = b.x + b.w;
    dirS = -1;
    dirE = 1;
  } else {
    sx = a.x + a.w;
    ex = b.x + b.w;
    dirS = 1;
    dirE = 1;
  }
  const off = Math.max(LOOP_MIN, Math.abs(ex - sx) / 2);
  const c1x = sx + dirS * off;
  const c2x = ex + dirE * off;
  const c1y = sy + bend;
  const c2y = ey + bend;
  return {
    d: `M${sx} ${sy} C${c1x} ${c1y} ${c2x} ${c2y} ${ex} ${ey}`,
    // The point of the cubic at t = 0.5.
    label: { x: (sx + 3 * c1x + 3 * c2x + ex) / 8, y: (sy + 3 * c1y + 3 * c2y + ey) / 8 },
  };
}

/** The arrows into and out of one package, in the model's edge order. */
export function arrowsOf(model: ArchModel, id: string): { incoming: ArchEdge[]; outgoing: ArchEdge[] } {
  return {
    incoming: model.edges.filter((e) => e.to === id),
    outgoing: model.edges.filter((e) => e.from === id),
  };
}
