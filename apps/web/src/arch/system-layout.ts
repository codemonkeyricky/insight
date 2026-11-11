import type { SystemComponent, SystemEdge, SystemExternal, SystemModel, SystemRoute } from "@insight/model";

// Pure geometry for the System view. The view draws what layoutSystem returns and keeps no sizes of its own. The layout is
// deterministic: component columns follow the model's stages left to right, then one column of external systems grouped by
// category. No graph library: a column is a stack of cards, an edge is one cubic curve between two card sides.

export const SYS_CARD_W = 224;
export const SYS_EXT_W = 210;
/** Space between two columns, where the curves run and the verb pills sit. */
export const SYS_GAP_X = 170;
export const SYS_GAP_Y = 22;
export const SYS_PAD = 28;
export const SYS_HEADER_H = 34;
export const SYS_COMP_H = 64;
export const SYS_CHIP_H = 20;
export const SYS_EXT_H = 60;
export const SYS_GROUP_H = 30;
export const SYS_PILL_H = 24;
/** Route chips drawn on a card; the rest are counted in a "+N more" chip. */
export const SYS_MAX_CHIPS = 4;
const PORT_INSET = 16;
/** The first lane sits this far above (below) the cards; the next ones are a step further out. */
const LANE_FIRST = 16;
const LANE_STEP = 4;

export const CATEGORY_ORDER: ReadonlyArray<SystemExternal["category"]> = ["service", "store", "api", "process", "filesystem", "config", "worker"];
export const CATEGORY_TITLES: Record<SystemExternal["category"], string> = {
  service: "Services",
  store: "Stores",
  api: "This app's API",
  process: "Processes",
  filesystem: "Filesystem",
  config: "Config",
  worker: "Workers",
};

export interface SysBox {
  id: string;
  kind: "component" | "external";
  /** Index into SysLayout.columns. */
  column: number;
  x: number;
  y: number;
  w: number;
  h: number;
  /** The text on the card. */
  title: string;
  /** The line under the title: counts for a component, host / command / names for an external. */
  sub: string;
  /** Route chips of a component, e.g. "POST /api/index", ending in "+N more" when cut. */
  chips: string[];
  category?: SystemExternal["category"];
  component?: SystemComponent;
  external?: SystemExternal;
}

export interface SysColumn {
  index: number;
  title: string;
  x: number;
  w: number;
}

export interface SysGroup {
  category: SystemExternal["category"];
  title: string;
  x: number;
  y: number;
}

export interface SysArrow {
  id: string;
  edge: SystemEdge;
  from: string;
  to: string;
  /** SVG path data, from a side of the source card to a side of the target card. */
  d: string;
  /** Points along the path, for hit tests. */
  samples: Array<{ x: number; y: number }>;
  /** Set when the edge runs along a lane above or below the cards instead of straight between its columns. */
  lane?: "top" | "bottom";
  /** The verb pill: its centre, size and text. */
  pill: { x: number; y: number; w: number; h: number; text: string };
  /** runs and spawns are drawn dashed. */
  dashed: boolean;
  /** An inferred edge is drawn dashed and faded. */
  inferred: boolean;
}

export interface SysLayout {
  /** Where a clamped (panned) view starts: the vertical centre of the first column of cards. */
  focusY: number;
  width: number;
  height: number;
  columns: SysColumn[];
  groups: SysGroup[];
  boxes: SysBox[];
  arrows: SysArrow[];
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** The end of a path that fits `max` characters, cut at a segment: "…/hosted/src/github.ts". */
export function shortLabel(label: string, max: number): string {
  if (label.length <= max) return label;
  const parts = label.split("/");
  let out = parts[parts.length - 1] as string;
  for (let i = parts.length - 2; i >= 0; i--) {
    const next = `${parts[i]}/${out}`;
    if (next.length + 2 > max) break;
    out = next;
  }
  return out.length + 1 > max ? `…${out.slice(out.length - max + 1)}` : `…/${out}`;
}

/** A route as it reads on a chip: "POST /api/index". An exported handler has no path in code. */
export function routeText(r: Pick<SystemRoute, "method" | "path">): string {
  return r.path === "" ? `${r.method} handler` : `${r.method} ${r.path}`;
}

const cut = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** The words on an edge's pill: its label, led by the verb unless the label already starts with it. */
export function pillText(edge: Pick<SystemEdge, "verb" | "label">): string {
  const text = edge.label.startsWith(edge.verb) ? edge.label : `${edge.verb} · ${edge.label}`;
  return cut(text, 24);
}

function externalSub(e: SystemExternal): string {
  if (e.names !== undefined && e.names.length > 0) {
    const first = e.names.slice(0, 3).join(", ");
    return e.names.length > 3 ? `${first} +${e.names.length - 3}` : first;
  }
  return e.host ?? e.command ?? "";
}

const pillWidth = (text: string): number => Math.round(text.length * 8.2 + 20);

/** The label of a component card: its path under the scope (or under the folder the scope passed through), cut at a segment. */
function cardTitle(c: SystemComponent, base: string): string {
  if (c.label === "(scope)") return c.path.slice(c.path.lastIndexOf("/") + 1);
  if (base !== "" && c.label.startsWith(`${base}/`)) return shortLabel(c.label.slice(base.length + 1), 24);
  return shortLabel(c.label, 24);
}

interface Port {
  arrow: number;
  other: number;
  id: string;
}

export function layoutSystem(sys: SystemModel): SysLayout {
  const empty: SysLayout = { focusY: 0, width: 0, height: 0, columns: [], groups: [], boxes: [], arrows: [] };
  if (sys.components.length === 0) return empty;

  const base = sys.via !== undefined ? (sys.scope === "" ? sys.via : `${sys.scope}/${sys.via}`) : sys.scope;
  const compById = new Map(sys.components.map((c) => [c.id, c]));
  const routesBy = new Map<string, SystemRoute[]>();
  for (const r of sys.routes) {
    const list = routesBy.get(r.component) ?? [];
    list.push(r);
    routesBy.set(r.component, list);
  }

  const columns: SysColumn[] = [];
  const boxes: SysBox[] = [];
  const groups: SysGroup[] = [];
  let x = SYS_PAD;
  const top = SYS_PAD + SYS_HEADER_H;

  // Component columns, one per stage. Stages with no known component (never from the model) are skipped.
  const stages = sys.stages.map((s) => s.filter((id) => compById.has(id))).filter((s) => s.length > 0);
  const placed = new Set(stages.flat());
  const stray = sys.components.filter((c) => !placed.has(c.id)).map((c) => c.id);
  if (stray.length > 0) stages.push(stray);
  // A last column of components nothing connects to is folded into the column before it, so it does not cost a column of width.
  const linked = new Set(sys.edges.filter((e) => e.from !== e.to).flatMap((e) => [e.from, e.to]));
  while (stages.length > 1 && (stages[stages.length - 1] as string[]).every((id) => !linked.has(id))) {
    const last = stages.pop() as string[];
    (stages[stages.length - 1] as string[]).push(...last);
  }
  const stacks: Array<{ column: number; items: SysBox[]; headers: Array<{ category: SystemExternal["category"]; before: number }> }> = [];
  stages.forEach((stage, i) => {
    columns.push({ index: i, title: i === 0 ? "Entry" : "", x, w: SYS_CARD_W });
    const items = stage.map((id): SysBox => {
      const c = compById.get(id) as SystemComponent;
      const routes = routesBy.get(id) ?? [];
      const chips = routes.slice(0, SYS_MAX_CHIPS).map((r) => cut(routeText(r), 30));
      if (routes.length > SYS_MAX_CHIPS) chips.push(`+${routes.length - SYS_MAX_CHIPS} more`);
      return {
        id,
        kind: "component",
        column: i,
        x,
        y: 0,
        w: SYS_CARD_W,
        h: SYS_COMP_H + chips.length * SYS_CHIP_H,
        title: cardTitle(c, base),
        sub: `${plural(c.files, "file")} · ${plural(c.functions, "function")}`,
        chips,
        component: c,
      };
    });
    stacks.push({ column: i, items, headers: [] });
    x += SYS_CARD_W + SYS_GAP_X;
  });

  // The external systems: one column, grouped by category with a small header per group.
  if (sys.externals.length > 0) {
    const col = columns.length;
    columns.push({ index: col, title: "Outside", x, w: SYS_EXT_W });
    const items: SysBox[] = [];
    const headers: Array<{ category: SystemExternal["category"]; before: number }> = [];
    for (const category of CATEGORY_ORDER) {
      const list = sys.externals.filter((e) => e.category === category);
      if (list.length === 0) continue;
      headers.push({ category, before: items.length });
      for (const e of list) {
        items.push({
          id: e.id,
          kind: "external",
          column: col,
          x,
          y: 0,
          w: SYS_EXT_W,
          h: SYS_EXT_H,
          title: cut(e.label, 19),
          sub: cut(externalSub(e), 30),
          chips: [],
          category,
          external: e,
        });
      }
    }
    stacks.push({ column: col, items, headers });
    x += SYS_EXT_W + SYS_GAP_X;
  }

  // Heights: each stack is centred on the tallest one.
  const heightOf = (s: (typeof stacks)[number]): number =>
    s.items.reduce((sum, b) => sum + b.h, 0) + Math.max(0, s.items.length - 1) * SYS_GAP_Y + s.headers.length * SYS_GROUP_H;
  const tallest = Math.max(...stacks.map(heightOf));
  for (const s of stacks) {
    let y = top + (tallest - heightOf(s)) / 2;
    const headerAt = new Map(s.headers.map((h) => [h.before, h.category]));
    s.items.forEach((b, i) => {
      const category = headerAt.get(i);
      if (category !== undefined) {
        groups.push({ category, title: CATEGORY_TITLES[category], x: b.x, y: y + 18 });
        y += SYS_GROUP_H;
      }
      b.y = y;
      y += b.h + SYS_GAP_Y;
      boxes.push(b);
    });
  }

  const width = x - SYS_GAP_X + SYS_PAD + 56;
  const bottom = top + tallest;
  const byId = new Map(boxes.map((b) => [b.id, b]));
  const cy = (b: SysBox): number => b.y + b.h / 2;

  // Ports: the ends of the edges on one side of a card, spread along it in the order of the cards they lead to.
  const live = sys.edges.filter((e) => byId.has(e.from) && byId.has(e.to));
  const ports = new Map<string, Port[]>();
  const addPort = (boxId: string, side: "l" | "r", p: Port) => {
    const key = `${boxId}|${side}`;
    const list = ports.get(key) ?? [];
    list.push(p);
    ports.set(key, list);
  };
  const sides = live.map((e) => {
    const a = byId.get(e.from) as SysBox;
    const b = byId.get(e.to) as SysBox;
    const mode: "fwd" | "back" | "loop" = a.column < b.column ? "fwd" : a.column > b.column ? "back" : "loop";
    return { a, b, mode };
  });
  live.forEach((e, i) => {
    const { a, b, mode } = sides[i] as (typeof sides)[number];
    addPort(a.id, mode === "back" ? "l" : "r", { arrow: i, other: cy(b), id: e.id });
    addPort(b.id, mode === "fwd" ? "l" : "r", { arrow: i, other: cy(a), id: e.id });
  });
  const portY = new Map<string, number>();
  for (const [key, list] of ports) {
    const box = byId.get(key.slice(0, key.lastIndexOf("|"))) as SysBox;
    list.sort((p, q) => p.other - q.other || (p.id < q.id ? -1 : p.id > q.id ? 1 : 0));
    list.forEach((p, i) => portY.set(`${key}|${p.arrow}`, box.y + PORT_INSET + ((box.h - 2 * PORT_INSET) * (i + 1)) / (list.length + 1)));
  }

  // Paths. An edge between neighbouring columns (or inside one) is one curve that stays in the gap. A longer edge whose
  // straight curve would cross a card instead leaves into the gap, runs along a lane above or below every card and
  // enters the gap before its target.
  const loopCount = new Map<string, number>();
  interface Geo {
    segs: number[][];
    lane?: "top" | "bottom";
  }
  const geos: Array<Geo | undefined> = live.map(() => undefined);
  const ends = live.map((_, i) => {
    const { a, b, mode } = sides[i] as (typeof sides)[number];
    const sa = mode === "back" ? "l" : "r";
    const sb = mode === "fwd" ? "l" : "r";
    return {
      x1: sa === "l" ? a.x : a.x + a.w,
      y1: portY.get(`${a.id}|${sa}|${i}`) as number,
      x2: sb === "l" ? b.x : b.x + b.w,
      y2: portY.get(`${b.id}|${sb}|${i}`) as number,
    };
  });
  const pending: Array<{ i: number; span: number }> = [];
  live.forEach((_, i) => {
    const { a, b, mode } = sides[i] as (typeof sides)[number];
    const { x1, y1, x2, y2 } = ends[i] as (typeof ends)[number];
    if (mode === "loop") {
      const k = loopCount.get(a.id) ?? 0;
      loopCount.set(a.id, k + 1);
      const bulge = Math.min(46 + 12 * k, SYS_GAP_X - 30);
      geos[i] = { segs: [[x1, y1, x1 + bulge, y1, x2 + bulge, y2, x2, y2]] };
      return;
    }
    const dx = Math.max(48, Math.abs(x2 - x1) * 0.5) * (mode === "fwd" ? 1 : -1);
    const segs = [[x1, y1, x1 + dx, y1, x2 - dx, y2, x2, y2]];
    const span = Math.abs(a.column - b.column);
    if (span > 1 && polyline(segs).some((q) => boxes.some((o) => o.id !== a.id && o.id !== b.id && inside(q, o, 4)))) pending.push({ i, span });
    else geos[i] = { segs };
  });
  pending.sort((p, q) => p.span - q.span || p.i - q.i);
  // A lane runs just above the top card (below the bottom card) of the columns it crosses, so it stays inside the layout's
  // bounds. Parallel lanes sit LANE_STEP apart.
  const colBoxes = new Map<number, SysBox[]>();
  for (const bx of boxes) colBoxes.set(bx.column, [...(colBoxes.get(bx.column) ?? []), bx]);
  let nTop = 0;
  let nBot = 0;
  let minLane = top;
  let maxLane = bottom;
  for (const { i } of pending) {
    const { x1, y1, x2, y2 } = ends[i] as (typeof ends)[number];
    const { a, b } = sides[i] as (typeof sides)[number];
    const dir = x2 > x1 ? 1 : -1;
    const crossed: SysBox[] = [];
    for (let c = Math.min(a.column, b.column) + 1; c < Math.max(a.column, b.column); c++) crossed.push(...(colBoxes.get(c) ?? []));
    const spanTop = crossed.length > 0 ? Math.min(...crossed.map((q) => q.y)) : top;
    const spanBottom = crossed.length > 0 ? Math.max(...crossed.map((q) => q.y + q.h)) : bottom;
    const lane: "top" | "bottom" = (y1 + y2) / 2 < (spanTop + spanBottom) / 2 ? "top" : "bottom";
    const ly = lane === "top" ? spanTop - LANE_FIRST - nTop++ * LANE_STEP : spanBottom + LANE_FIRST + nBot++ * LANE_STEP;
    minLane = Math.min(minLane, ly);
    maxLane = Math.max(maxLane, ly);
    const xa = x1 + dir * SYS_GAP_X * 0.4;
    const xb = x2 - dir * SYS_GAP_X * 0.4;
    const k = SYS_GAP_X * 0.2;
    geos[i] = {
      lane,
      segs: [
        [x1, y1, x1 + dir * k, y1, xa - dir * k, ly, xa, ly],
        [xa, ly, xa + (xb - xa) / 3, ly, xa + (2 * (xb - xa)) / 3, ly, xb, ly],
        [xb, ly, xb + dir * k, ly, x2 - dir * k, y2, x2, y2],
      ],
    };
  }
  // Room for the lanes: everything moves down by what the top lanes need, and the canvas grows for the bottom ones.
  const dy = minLane < top ? Math.max(0, 54 - minLane) : 0;
  const height = dy + maxLane + SYS_PAD;
  if (dy > 0) {
    for (const bx of boxes) bx.y += dy;
    for (const g of groups) g.y += dy;
    for (const geo of geos) for (const seg of geo?.segs ?? []) for (let j = 1; j < 8; j += 2) seg[j] = (seg[j] as number) + dy;
  }
  const num = (n: number): string => String(Math.round(n * 10) / 10);

  // Pills sit on their curve, slid along it (t 0.3 to 0.7) and then offset off it until they touch no card and no other pill.
  const taken: Array<{ x: number; y: number; w: number; h: number }> = boxes.map((b) => ({ x: b.x - 4, y: b.y - 4, w: b.w + 8, h: b.h + 8 }));
  for (const g of groups) taken.push({ x: g.x - 2, y: g.y - 16, w: 150, h: 22 });
  const arrows: SysArrow[] = [];
  const NUDGES = [0, 26, -26, 52, -52, 78, -78, 104, -104, 130, -130, 156, -156, 182, -182, 208, -208, 234, -234, 260, -260, 312, -312, 364, -364, 416, -416];
  const TS = [0.5, 0.45, 0.55, 0.4, 0.6, 0.35, 0.65, 0.3, 0.7];
  const WIDE_TS = [0.5, 0.4, 0.6, 0.3, 0.7, 0.2, 0.8, 0.12, 0.88, 0.06, 0.94];
  live.forEach((e, i) => {
    const geo = geos[i] as Geo;
    const samples = polyline(geo.segs);
    const at = arcPoint(samples);
    const text = pillText(e);
    const w = pillWidth(text);
    let chosen: { x: number; y: number } | undefined;
    for (const ts of [TS, WIDE_TS]) {
      for (const off of NUDGES) {
        for (const t of ts) {
          const c = at(t);
          const r = { x: c.x - w / 2, y: c.y + off - SYS_PILL_H / 2, w, h: SYS_PILL_H };
          if (!taken.some((o) => overlaps(r, o))) {
            chosen = { x: c.x, y: c.y + off };
            break;
          }
        }
        if (chosen !== undefined) break;
      }
      if (chosen !== undefined) break;
    }
    const c = chosen ?? at(0.5);
    taken.push({ x: c.x - w / 2, y: c.y - SYS_PILL_H / 2, w, h: SYS_PILL_H });
    const d = `M${num(geo.segs[0]?.[0] ?? 0)} ${num(geo.segs[0]?.[1] ?? 0)} ${geo.segs.map((s) => `C${num(s[2] as number)} ${num(s[3] as number)} ${num(s[4] as number)} ${num(s[5] as number)} ${num(s[6] as number)} ${num(s[7] as number)}`).join(" ")}`;
    arrows.push({
      id: e.id,
      edge: e,
      from: e.from,
      to: e.to,
      d,
      samples,
      ...(geo.lane !== undefined ? { lane: geo.lane } : {}),
      pill: { x: c.x, y: c.y, w, h: SYS_PILL_H, text },
      dashed: e.verb === "runs" || e.verb === "spawns",
      inferred: e.confidence === "inferred",
    });
  });

  const first = boxes.filter((b) => b.column === 0);
  const focusY = first.length === 0 ? height / 2 : first.reduce((sum, b) => sum + b.y + b.h / 2, 0) / first.length;
  return { focusY, width, height, columns, groups, boxes, arrows };
}

type Pt = { x: number; y: number };

function bezier(p: readonly number[], t: number): Pt {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return {
    x: a * (p[0] as number) + b * (p[2] as number) + c * (p[4] as number) + d * (p[6] as number),
    y: a * (p[1] as number) + b * (p[3] as number) + c * (p[5] as number) + d * (p[7] as number),
  };
}

/** Points along a path of cubic segments, about 24 per segment. */
function polyline(segs: number[][]): Pt[] {
  const out: Pt[] = [];
  segs.forEach((s, k) => {
    for (let j = k === 0 ? 0 : 1; j <= 24; j++) out.push(bezier(s, j / 24));
  });
  return out;
}

/** The point at a fraction of the length of a polyline. */
function arcPoint(pts: Pt[]): (t: number) => Pt {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push((cum[i - 1] as number) + Math.hypot((pts[i] as Pt).x - (pts[i - 1] as Pt).x, (pts[i] as Pt).y - (pts[i - 1] as Pt).y));
  const total = cum[cum.length - 1] as number;
  return (t) => {
    const target = total * t;
    let i = 1;
    while (i < cum.length - 1 && (cum[i] as number) < target) i++;
    const span = (cum[i] as number) - (cum[i - 1] as number);
    const f = span === 0 ? 0 : (target - (cum[i - 1] as number)) / span;
    const p = pts[i - 1] as Pt;
    const q = pts[i] as Pt;
    return { x: p.x + (q.x - p.x) * f, y: p.y + (q.y - p.y) * f };
  };
}

function inside(p: Pt, b: { x: number; y: number; w: number; h: number }, margin = 0): boolean {
  return p.x > b.x - margin && p.x < b.x + b.w + margin && p.y > b.y - margin && p.y < b.y + b.h + margin;
}

function overlaps(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}
