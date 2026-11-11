import type { SystemComponent, SystemEdge, SystemExternal, SystemModel, SystemRoute } from "@insight/model";

// Pure geometry for the System view. The view draws what layoutSystem returns and keeps no sizes of its own. The layout is
// deterministic: component columns follow the model's stages left to right, then one column of external systems grouped by
// category. No graph library: a column is a stack of cards, an edge is one cubic curve between two card sides.

export const SYS_CARD_W = 224;
export const SYS_EXT_W = 210;
/** Space between two columns, where the curves run and the verb pills sit. */
export const SYS_GAP_X = 190;
export const SYS_GAP_Y = 22;
export const SYS_PAD = 28;
export const SYS_HEADER_H = 34;
export const SYS_COMP_H = 64;
export const SYS_CHIP_H = 20;
export const SYS_EXT_H = 60;
export const SYS_GROUP_H = 30;
export const SYS_PILL_H = 20;
/** Route chips drawn on a card; the rest are counted in a "+N more" chip. */
export const SYS_MAX_CHIPS = 4;
const PORT_INSET = 16;

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
  /** The verb pill: its centre, size and text. */
  pill: { x: number; y: number; w: number; h: number; text: string };
  /** runs and spawns are drawn dashed. */
  dashed: boolean;
  /** An inferred edge is drawn dashed and faded. */
  inferred: boolean;
}

export interface SysLayout {
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

const pillWidth = (text: string): number => Math.round(text.length * 6.8 + 16);

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
  const empty: SysLayout = { width: 0, height: 0, columns: [], groups: [], boxes: [], arrows: [] };
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
          title: cut(e.label, 24),
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
  const height = top + tallest + SYS_PAD;
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

  const loopCount = new Map<string, number>();
  const raw = live.map((e, i) => {
    const { a, b, mode } = sides[i] as (typeof sides)[number];
    const sa = mode === "back" ? "l" : "r";
    const sb = mode === "fwd" ? "l" : "r";
    const y1 = portY.get(`${a.id}|${sa}|${i}`) as number;
    const y2 = portY.get(`${b.id}|${sb}|${i}`) as number;
    const x1 = sa === "l" ? a.x : a.x + a.w;
    const x2 = sb === "l" ? b.x : b.x + b.w;
    let d: string;
    let pts: (t: number) => { x: number; y: number };
    if (mode === "loop") {
      const k = loopCount.get(a.id) ?? 0;
      loopCount.set(a.id, k + 1);
      const bulge = 46 + 12 * k;
      const p = [x1, y1, x1 + bulge, y1, x2 + bulge, y2, x2, y2] as const;
      d = `M${p[0]} ${p[1]} C${p[2]} ${p[3]} ${p[4]} ${p[5]} ${p[6]} ${p[7]}`;
      pts = (t) => bezier(p, t);
    } else {
      const dx = Math.max(48, Math.abs(x2 - x1) * 0.5) * (mode === "fwd" ? 1 : -1);
      const p = [x1, y1, x1 + dx, y1, x2 - dx, y2, x2, y2] as const;
      d = `M${p[0]} ${p[1]} C${p[2]} ${p[3]} ${p[4]} ${p[5]} ${p[6]} ${p[7]}`;
      pts = (t) => bezier(p, t);
    }
    return { e: live[i] as SystemEdge, d, pts };
  });

  // Pills sit on their curve, moved along it until they touch no card and no other pill.
  const taken: Array<{ x: number; y: number; w: number; h: number }> = boxes.map((b) => ({ x: b.x - 4, y: b.y - 4, w: b.w + 8, h: b.h + 8 }));
  const arrows: SysArrow[] = [];
  const NUDGES = [0, 22, -22, 44, -44, 66, -66];
  const TS = [0.5, 0.42, 0.58, 0.34, 0.66, 0.26, 0.74, 0.18, 0.82];
  for (const { e, d, pts } of raw) {
    const text = pillText(e);
    const w = pillWidth(text);
    let chosen: { x: number; y: number } | undefined;
    // On the curve first, then nudged along it, then moved off it up or down, so two pills never overlap.
    for (const dy of NUDGES) {
      for (const t of TS) {
        const c = pts(t);
        const r = { x: c.x - w / 2, y: c.y + dy - SYS_PILL_H / 2, w, h: SYS_PILL_H };
        if (!taken.some((o) => overlaps(r, o))) {
          chosen = { x: c.x, y: c.y + dy };
          break;
        }
      }
      if (chosen !== undefined) break;
    }
    const c = chosen ?? pts(0.5);
    taken.push({ x: c.x - w / 2, y: c.y - SYS_PILL_H / 2, w, h: SYS_PILL_H });
    arrows.push({
      id: e.id,
      edge: e,
      from: e.from,
      to: e.to,
      d,
      pill: { x: c.x, y: c.y, w, h: SYS_PILL_H, text },
      dashed: e.verb === "runs" || e.verb === "spawns",
      inferred: e.confidence === "inferred",
    });
  }

  return { width, height, columns, groups, boxes, arrows };
}

function bezier(p: readonly [number, number, number, number, number, number, number, number], t: number): { x: number; y: number } {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return { x: a * p[0] + b * p[2] + c * p[4] + d * p[6], y: a * p[1] + b * p[3] + c * p[5] + d * p[7] };
}

function overlaps(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}
