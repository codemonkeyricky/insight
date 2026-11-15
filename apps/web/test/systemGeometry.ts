import type { SysLayout } from "../src/arch/system-layout";

type P = [number, number];
interface R { x: number; y: number; w: number; h: number }

/** The points of an SVG path of M, L and C commands, as polyline vertices (a cubic is sampled finely). */
export function pathPoints(d: string): P[] {
  const out: P[] = [];
  const re = /([MLC])([^MLC]*)/g;
  for (let m = re.exec(d); m !== null; m = re.exec(d)) {
    const n = (m[2] as string).trim().split(/[\s,]+/).filter(Boolean).map(Number);
    if (m[1] === "C") {
      const [x0, y0] = out[out.length - 1] as P;
      const [c1x, c1y, c2x, c2y, x1, y1] = n as [number, number, number, number, number, number];
      for (let i = 1; i <= 60; i++) {
        const t = i / 60, u = 1 - t;
        out.push([u * u * u * x0 + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * x1, u * u * u * y0 + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * y1]);
      }
    } else {
      for (let i = 0; i + 1 < n.length; i += 2) out.push([n[i] as number, n[i + 1] as number]);
    }
  }
  return out;
}

/** True when the segment passes through the interior of the rectangle (touching its border does not count). */
export function segmentHitsRect(a: P, b: P, r: R): boolean {
  const eps = 0.5;
  const x0 = r.x + eps, x1 = r.x + r.w - eps, y0 = r.y + eps, y1 = r.y + r.h - eps;
  if (x1 <= x0 || y1 <= y0) return false;
  let t0 = 0, t1 = 1;
  const dx = b[0] - a[0], dy = b[1] - a[1];
  for (const [p, q] of [[-dx, a[0] - x0], [dx, x1 - a[0]], [-dy, a[1] - y0], [dy, y1 - a[1]]] as Array<[number, number]>) {
    if (p === 0) {
      if (q < 0) return false;
    } else {
      const t = q / p;
      if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t; }
      else { if (t < t0) return false; if (t < t1) t1 = t; }
    }
  }
  return t0 < t1;
}

/**
 * Every (path, rectangle) pair where an edge path runs through a frame header or a card it does not belong to.
 * Arrows are checked on their own path (`d`), trunks on theirs. An edge's own ends (and a trunk's process) are exempt.
 */
export function crossings(l: SysLayout): string[] {
  const hits: string[] = [];
  const rects: Array<R & { id: string; what: string }> = [
    ...(l.frames ?? []).map((f) => ({ id: f.id, what: "header", x: f.x, y: f.y, w: f.w, h: f.hdrH })),
    ...l.boxes.map((b) => ({ id: b.id, what: "card", x: b.x, y: b.y, w: b.w, h: b.h })),
  ];
  const check = (label: string, d: string, own: string[]): void => {
    const pts = pathPoints(d);
    for (const r of rects) {
      if (own.includes(r.id)) continue;
      for (let i = 0; i + 1 < pts.length; i++) {
        if (segmentHitsRect(pts[i] as P, pts[i + 1] as P, r)) {
          hits.push(`${label} through ${r.what} ${r.id}`);
          break;
        }
      }
    }
  };
  for (const a of l.arrows) check(`arrow ${a.id}`, a.d, [a.from, a.to]);
  for (const t of l.trunks ?? []) check(`trunk ${t.id}`, t.d, [t.process, t.to]);
  return hits;
}
