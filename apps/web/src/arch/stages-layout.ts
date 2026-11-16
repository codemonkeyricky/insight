import type { StageGraph, StageNode } from "@insight/model";

// The Stages view's geometry. A StageGraph (packages/core/model/src/stages.ts) becomes positioned cards, frames, diamonds,
// pills, text and polylines. The main spine runs left to right. A loop is a labelled frame with a return arrow along its
// bottom. A branch is a small diamond with its condition above, and its arms stack vertically as labelled lanes that re-join.
// A try is a frame with a dashed catch lane below. Text is measured with a fixed character width, a little wide, so labels fit
// rather than clip. Pure: no DOM, no React. The same graph and options always give the same layout.

type Site = Extract<StageNode, { kind: "call" }>["site"];
export type Point = [number, number];

/** Width of one character at the view's label sizes, a little over the average so labels fit. */
const CHAR_W = 6.6;
/** Room kept inside a card or a frame, in px. */
const PAD = 10;
/** Room kept around the whole diagram. */
const MARGIN = 16;
/** Space between two items on a spine. */
const GAP = 22;
const CARD_MIN_W = 110;
const CARD_MAX_W = 220;
const CARD_TOP = 8;
const TITLE_H = 16;
const SUB_H = 14;
const CHIP_H = 16;
/** The chip labels are 11px monospace: about 0.62em a character. Chips are sized from this, so a name is not cut to fit. */
const CHIP_CHAR_W = 0.62 * 11;
const CHIP_GAP = 4;
const CHIP_PAD = 12;
const CHIPS_MAX = 6;
export const LABEL_H = 20;
const RET_H = 18;
const CATCH_GAP = 14;
const LANE_LABEL_H = 16;
const LANE_GAP = 14;
const DIAMOND = 24;
/** A branch's condition sits just above its diamond. The diamond's centre is this far below the block's top, so the label fits above it. */
const COND_ABOVE = 12 + 4 + DIAMOND / 2;
/** The arm lanes start this far right of a branch's left edge; their elbows run in the gap. */
const LANE_X = DIAMOND + 22;
const ELBOW_X = DIAMOND + 10;
const PILL_H = 18;
const EMPTY_W = 24;
/** A top-level spine that wraps: each row starts this far in, so a connector can come back from the row's end on the left. */
const ROW_INDENT = 18;
/** The space between two wrapped rows, where the return connector runs. */
const ROW_GAP = 64;
/** A stage is legible when its text stays at least 9px. The labels are 11px at most, so the scale must stay above 9/11. */
export const LEGIBLE_K = 0.85;
const MAX_K = 1;
/** A loop's or branch's condition is shown at most this many characters long; the full text is the title. */
export const CONDITION_MAX = 48;

/** The text of an exit pill, by how the flow leaves. */
const EXIT_TEXT: Record<"continue" | "break" | "return" | "throw", string> = { continue: "skip", break: "break", return: "return", throw: "throw" };

export interface LayoutChip {
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
  title: string;
  /** The component's path, when the target has one: the chip links to its System scope. */
  component?: string;
}

export type LayoutNode =
  | {
      kind: "card";
      key: string;
      x: number;
      y: number;
      w: number;
      h: number;
      title: string;
      titleFull: string;
      sub?: string;
      tone: "call" | "minor" | "fanout" | "ambiguous" | "repeat";
      site?: Site;
      fn?: string;
      chips: LayoutChip[];
    }
  | { kind: "frame"; key: string; x: number; y: number; w: number; h: number; label: string; titleFull: string; tone: "loop" | "helper" | "try"; site?: Site }
  | { kind: "diamond"; key: string; x: number; y: number; w: number; h: number; titleFull: string; site?: Site }
  | { kind: "pill"; key: string; x: number; y: number; w: number; h: number; text: string; how: "continue" | "break" | "return" | "throw"; site?: Site }
  | { kind: "text"; key: string; x: number; y: number; text: string; titleFull?: string; tone: "cond" | "lane" | "catch" | "muted" };

export interface LayoutPath {
  key: string;
  points: Point[];
  tone: "flow" | "return" | "catch" | "join";
  /** Whether the line ends in an arrowhead. */
  arrow: boolean;
}

export interface StageLayout {
  width: number;
  height: number;
  /** Frames come first, so cards and labels draw on top of them. */
  nodes: LayoutNode[];
  /** Polylines, drawn above frames and below cards. */
  paths: LayoutPath[];
}

export interface StageLayoutOptions {
  /** Minor calls (utility callees) are shown. Hidden by default. */
  showAll?: boolean;
  /** When set, the top-level spine wraps into rows no wider than this many px (breaking only between items). */
  rowW?: number;
}

// ---- measuring and clipping -------------------------------------------------------------------------------------------------

const textW = (s: string): number => s.length * CHAR_W;
/** The text cut to `maxChars` characters, with an ellipsis when it is cut. */
export function clip(s: string, maxChars: number): string {
  return s.length <= maxChars ? s : `${s.slice(0, Math.max(0, maxChars - 1))}…`;
}
const charsIn = (w: number): number => Math.max(1, Math.floor(w / CHAR_W));
const chipW = (s: string): number => s.length * CHIP_CHAR_W;
const base = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

// ---- sized blocks -----------------------------------------------------------------------------------------------------------

interface Out {
  nodes: LayoutNode[];
  paths: LayoutPath[];
  seq: number;
}
type NodeDraft = LayoutNode extends infer N ? (N extends unknown ? Omit<N, "key"> : never) : never;

/** A block of the layout: its size, the y of its spine inside it, and how to place it with its top-left at (x, y). */
interface Sized {
  w: number;
  h: number;
  /** The spine's y, measured from the block's top. Connectors meet the spine. */
  mid: number;
  /** Whether the block has no stage in it (an empty sequence draws only its spine stub). */
  empty: boolean;
  draw: (x: number, y: number, out: Out) => void;
}

function pushNode(out: Out, d: NodeDraft): void {
  out.nodes.push({ ...d, key: `n${out.seq++}` } as LayoutNode);
}
function pushPath(out: Out, points: Point[], tone: LayoutPath["tone"], arrow: boolean): void {
  out.paths.push({ key: `p${out.seq++}`, points, tone, arrow });
}

function leaf(w: number, h: number, draw: (x: number, y: number, out: Out) => void): Sized {
  return { w, h, mid: h / 2, empty: false, draw };
}

/** A sequence laid out left to right on one spine. Blocks are aligned on their spines; connectors join neighbours. */
function chain(nodes: StageNode[], o: StageLayoutOptions): Sized {
  return spine(nodes.map((n) => sizeOf(n, o)).filter((p): p is Sized => p !== undefined));
}

/** Blocks laid left to right on one spine, joined by arrows. */
function spine(parts: Sized[]): Sized {
  if (parts.length === 0) {
    return { w: EMPTY_W, h: 0, mid: 0, empty: true, draw: (x, y, out) => pushPath(out, [[x, y], [x + EMPTY_W, y]], "flow", false) };
  }
  const top = Math.max(...parts.map((p) => p.mid));
  const below = Math.max(...parts.map((p) => p.h - p.mid));
  const w = parts.reduce((sum, p) => sum + p.w, 0) + GAP * (parts.length - 1);
  return {
    w,
    h: top + below,
    mid: top,
    empty: false,
    draw(x, y, out) {
      let cx = x;
      let prevRight = x;
      parts.forEach((p, i) => {
        if (i > 0) pushPath(out, [[prevRight, y + top], [cx, y + top]], "flow", true);
        p.draw(cx, y + top - p.mid, out);
        prevRight = cx + p.w;
        cx = prevRight + GAP;
      });
    },
  };
}

function sizeOf(n: StageNode, o: StageLayoutOptions): Sized | undefined {
  switch (n.kind) {
    case "call":
      return callSized(n, o);
    case "loop":
      return frameSized({
        label: `⟳ ${clip(n.condition ?? n.variant, CONDITION_MAX)}`,
        titleFull: `⟳ ${n.condition ?? n.variant}`,
        tone: "loop",
        site: n.site,
        body: chain(n.body, o),
        ret: true,
      });
    case "branch":
      return branchSized(n, o);
    case "try":
      return trySized(n, o);
    case "exit":
      return exitSized(n.how, n.site);
  }
}

// ---- calls ------------------------------------------------------------------------------------------------------------------

interface CardSpec {
  title: string;
  sub?: string;
  tone: LayoutNode extends infer N ? (N extends { kind: "card"; tone: infer T } ? T : never) : never;
  site?: Site;
  fn?: string;
  chips?: Array<{ label: string; title: string; component?: string }>;
  more?: number;
}

function callSized(n: Extract<StageNode, { kind: "call" }>, o: StageLayoutOptions): Sized | undefined {
  if (n.minor === true && o.showAll !== true) return undefined;
  if (n.body !== undefined) {
    return frameSized({ label: `${n.name}()`, titleFull: n.name, tone: "helper", site: n.site, body: chain(n.body, o), ret: false });
  }
  if (n.repeatOf !== undefined) return cardSized({ title: n.name, sub: "↺ same as above", tone: "repeat", site: n.site, fn: n.fn });
  if (n.fanout !== undefined) {
    // One chip per component the candidates live in, in target order; the rest are counted.
    const groups = new Map<string, { label: string; title: string; component?: string; names: string[] }>();
    for (const t of n.fanout.targets) {
      const key = t.component ?? `fn:${t.fn}`;
      const g = groups.get(key);
      if (g) g.names.push(t.name);
      else groups.set(key, { label: t.component !== undefined ? base(t.component) : t.name, title: t.component ?? t.name, ...(t.component !== undefined ? { component: t.component } : {}), names: [t.name] });
    }
    const all = [...groups.values()];
    const chips = all.slice(0, CHIPS_MAX).map((g) => ({
      label: g.label,
      title: `${g.names.join(", ")}${g.component !== undefined ? ` in ${g.component}` : ""}`,
      ...(g.component !== undefined ? { component: g.component } : {}),
    }));
    return cardSized({
      title: n.name,
      sub: `${n.fanout.how} · ${n.fanout.targets.length}${n.fanout.truncated === true ? "+" : ""} possible`,
      tone: "fanout",
      site: n.site,
      fn: n.fn,
      chips,
      more: all.length - chips.length,
    });
  }
  if (n.ambiguous === true) {
    const sub = n.candidates !== undefined ? `${n.candidates} possible` : "several possible";
    return cardSized({ title: n.name, sub, tone: "ambiguous", site: n.site });
  }
  return cardSized({ title: n.name, ...(n.file !== undefined ? { sub: base(n.file) } : {}), tone: n.minor === true ? "minor" : "call", site: n.site, fn: n.fn });
}

/** A stage card: the title, an optional sub line, and stacked component chips. Its width is its content's, within the card limits. */
function cardSized(s: CardSpec): Sized {
  const chips = s.chips ?? [];
  const more = s.more ?? 0;
  const need = Math.max(
    textW(clip(s.title, charsIn(CARD_MAX_W - 2 * PAD))),
    s.sub !== undefined ? textW(s.sub) : 0,
    ...chips.map((c) => chipW(c.label) + CHIP_PAD),
    more > 0 ? chipW(`+${more} more`) + CHIP_PAD : 0,
  );
  const w = Math.ceil(Math.min(CARD_MAX_W, Math.max(CARD_MIN_W, need + 2 * PAD)));
  const inner = w - 2 * PAD;
  const titleBottom = CARD_TOP + TITLE_H + (s.sub !== undefined ? SUB_H : 0);
  const rows = chips.length + (more > 0 ? 1 : 0);
  const chipsTop = rows > 0 ? titleBottom + 4 : titleBottom;
  const h = rows > 0 ? chipsTop + rows * (CHIP_H + CHIP_GAP) - CHIP_GAP + CARD_TOP : titleBottom + CARD_TOP;
  return leaf(w, h, (x, y, out) => {
    const chipAt = chips.map((c, i) => {
      const cw = Math.min(inner, chipW(c.label) + CHIP_PAD);
      return {
        x: x + PAD,
        y: y + chipsTop + i * (CHIP_H + CHIP_GAP),
        w: cw,
        h: CHIP_H,
        // A label that fits its chip is kept whole; only one wider than the chip is cut.
        label: cw >= chipW(c.label) + CHIP_PAD - 0.01 ? c.label : clip(c.label, Math.max(1, Math.floor((cw - CHIP_PAD) / CHIP_CHAR_W))),
        title: c.title,
        ...(c.component !== undefined ? { component: c.component } : {}),
      };
    });
    pushNode(out, {
      kind: "card",
      x,
      y,
      w,
      h,
      title: clip(s.title, charsIn(inner)),
      titleFull: s.title,
      ...(s.sub !== undefined ? { sub: clip(s.sub, charsIn(inner)) } : {}),
      tone: s.tone,
      ...(s.site !== undefined ? { site: s.site } : {}),
      ...(s.fn !== undefined ? { fn: s.fn } : {}),
      chips: chipAt,
    });
    if (more > 0) {
      pushNode(out, { kind: "text", x: x + PAD, y: y + chipsTop + chips.length * (CHIP_H + CHIP_GAP) + 12, text: `+${more} more`, tone: "muted" });
    }
  });
}

// ---- frames, branches, try ----------------------------------------------------------------------------------------------------

/** A labelled frame around a body. A loop has a return arrow along its bottom. */
function frameSized(s: { label: string; titleFull: string; tone: "loop" | "helper" | "try"; site?: Site; body: Sized; ret: boolean }): Sized {
  const w = Math.ceil(Math.max(s.body.w + 2 * PAD, textW(s.label) + 2 * PAD));
  const retH = s.ret ? RET_H : 0;
  const h = LABEL_H + PAD + s.body.h + retH + PAD;
  const mid = LABEL_H + PAD + s.body.mid;
  return leaf(w, h, (x, y, out) => {
    const sy = y + mid;
    pushNode(out, { kind: "frame", x, y, w, h, label: s.label, titleFull: s.titleFull, tone: s.tone, ...(s.site !== undefined ? { site: s.site } : {}) });
    s.body.draw(x + PAD, y + LABEL_H + PAD, out);
    const xr = x + PAD + s.body.w;
    pushPath(out, [[x, sy], [x + PAD, sy]], "flow", false);
    pushPath(out, [[xr, sy], [x + w, sy]], "flow", false);
    if (s.ret) {
      // The return runs under the body and comes up at the frame's left gap, into the spine.
      const retY = y + LABEL_H + PAD + s.body.h + RET_H / 2;
      pushPath(out, [[xr, sy], [xr + 8, sy], [xr + 8, retY], [x + PAD / 2, retY], [x + PAD / 2, sy]], "return", true);
    }
  });
}

function branchSized(n: Extract<StageNode, { kind: "branch" }>, o: StageLayoutOptions): Sized {
  const arms = n.arms.map((a) => {
    const body = chain(a.body, o);
    return { text: body.empty ? `${a.label}: —` : a.label, body };
  });
  const laneW = arms.length > 0 ? Math.max(...arms.map((a) => Math.max(a.body.w, textW(a.text)))) : 0;
  const join = LANE_X + laneW + 14;
  const lanesH = arms.reduce((sum, a) => sum + LANE_LABEL_H + a.body.h, 0) + LANE_GAP * Math.max(0, arms.length - 1);
  const w = Math.ceil(Math.max(textW(clip(n.condition, CONDITION_MAX)), join + 14));
  // The spine runs through the diamond's centre. The lanes start at the diamond's top, so the condition above the diamond clears them.
  const laneTop = COND_ABOVE - DIAMOND / 2;
  const h = Math.max(laneTop + lanesH, COND_ABOVE);
  const mid = COND_ABOVE;
  const condText = clip(n.condition, CONDITION_MAX);
  return leaf(w, h, (x, y, out) => {
    const cy = y + mid;
    pushNode(out, { kind: "text", x, y: cy - DIAMOND / 2 - 4, text: condText, titleFull: n.condition, tone: "cond" });
    pushNode(out, { kind: "diamond", x, y: cy - DIAMOND / 2, w: DIAMOND, h: DIAMOND, titleFull: n.condition, site: n.site });
    const spines: number[] = [cy];
    let top = y + laneTop;
    for (const a of arms) {
      const laneX = x + LANE_X;
      pushNode(out, { kind: "text", x: laneX, y: top + 11, text: a.text, titleFull: a.text, tone: "lane" });
      a.body.draw(laneX, top + LANE_LABEL_H, out);
      const s = top + LANE_LABEL_H + a.body.mid;
      spines.push(s);
      pushPath(out, [[x + DIAMOND, cy], [x + ELBOW_X, cy], [x + ELBOW_X, s], [laneX, s]], "flow", true);
      pushPath(out, [[laneX + a.body.w, s], [x + join, s]], "join", false);
      top += LANE_LABEL_H + a.body.h + LANE_GAP;
    }
    if (spines.length > 1) pushPath(out, [[x + join, Math.min(...spines)], [x + join, Math.max(...spines)]], "join", false);
    pushPath(out, [[x + join, cy], [x + w, cy]], "join", false);
  });
}

/** A try: a frame around the try block, with a dashed catch lane below it when the handler has stages. */
function trySized(n: Extract<StageNode, { kind: "try" }>, o: StageLayoutOptions): Sized {
  const body = chain(n.body, o);
  const handler = chain(n.handler, o);
  const hasCatch = !handler.empty;
  const innerW = Math.max(body.w, hasCatch ? handler.w : 0);
  const w = Math.ceil(Math.max(innerW + 2 * PAD, textW("try") + 2 * PAD));
  const bodyBottom = LABEL_H + PAD + body.h;
  const catchTop = bodyBottom + CATCH_GAP;
  const h = hasCatch ? catchTop + LANE_LABEL_H + handler.h + PAD : bodyBottom + PAD;
  const mid = LABEL_H + PAD + body.mid;
  return leaf(w, h, (x, y, out) => {
    const sy = y + mid;
    pushNode(out, { kind: "frame", x, y, w, h, label: "try", titleFull: "try", tone: "try", site: n.site });
    body.draw(x + PAD, y + LABEL_H + PAD, out);
    pushPath(out, [[x, sy], [x + PAD, sy]], "flow", false);
    pushPath(out, [[x + PAD + body.w, sy], [x + w, sy]], "flow", false);
    if (hasCatch) {
      const hy = y + catchTop;
      pushNode(out, { kind: "text", x: x + PAD, y: hy + 11, text: "catch", tone: "catch" });
      handler.draw(x + PAD, hy + LANE_LABEL_H, out);
      const hs = hy + LANE_LABEL_H + handler.mid;
      pushPath(out, [[x + PAD / 2, sy], [x + PAD / 2, hs], [x + PAD, hs]], "catch", true);
      pushPath(out, [[x + PAD + handler.w, hs], [x + w - PAD / 2, hs], [x + w - PAD / 2, sy]], "catch", false);
    }
  });
}

/** An exit: a small pill, "skip" for a continue, "return", "throw" or "break". */
function exitSized(how: "continue" | "break" | "return" | "throw", site: Site): Sized {
  const text = EXIT_TEXT[how];
  const w = Math.ceil(textW(text) + 16);
  return leaf(w, PILL_H, (x, y, out) => {
    pushNode(out, { kind: "pill", x, y, w, h: PILL_H, text, how, site });
  });
}

// ---- the whole diagram ------------------------------------------------------------------------------------------------------

/**
 * The top-level spine of a driver, broken into rows no wider than `rowW`. A row breaks only between two items. The end of each row
 * runs a connector down into the gap and back to the start of the next row, so the order reads row by row.
 */
function wrapRows(nodes: StageNode[], o: StageLayoutOptions, rowW: number): Sized {
  const parts = nodes.map((n) => sizeOf(n, o)).filter((p): p is Sized => p !== undefined);
  const rows: Sized[][] = [];
  let cur: Sized[] = [];
  let curW = 0;
  for (const p of parts) {
    if (cur.length > 0 && curW + GAP + p.w > rowW) {
      rows.push(cur);
      cur = [];
      curW = 0;
    }
    curW = cur.length === 0 ? p.w : curW + GAP + p.w;
    cur.push(p);
  }
  if (cur.length > 0) rows.push(cur);
  if (rows.length <= 1) return spine(parts);
  const lines = rows.map(spine);
  const tops: number[] = [];
  let h = 0;
  lines.forEach((r, i) => {
    if (i > 0) h += ROW_GAP;
    tops.push(h);
    h += r.h;
  });
  const first = lines[0];
  return {
    w: Math.max(...lines.map((r) => r.w)) + 2 * ROW_INDENT,
    h,
    mid: (tops[0] ?? 0) + (first?.mid ?? 0),
    empty: false,
    draw(x, y, out) {
      lines.forEach((r, i) => {
        const ry = y + (tops[i] ?? 0);
        r.draw(x + ROW_INDENT, ry, out);
        const next = lines[i + 1];
        if (next === undefined) return;
        const spineA = ry + r.mid;
        const spineB = y + (tops[i + 1] ?? 0) + next.mid;
        const rowRight = x + ROW_INDENT + r.w;
        const bandY = ry + r.h + ROW_GAP / 2;
        const outX = rowRight + 10;
        const inX = x + ROW_INDENT - 10;
        pushPath(out, [[rowRight, spineA], [outX, spineA], [outX, bandY], [inX, bandY], [inX, spineB], [x + ROW_INDENT, spineB]], "flow", true);
      });
    },
  };
}

/** The layout of a stage graph: the driver's body on one spine from the left, with its margin. Deterministic. */
export function layoutStages(graph: StageGraph, opts: StageLayoutOptions = {}): StageLayout {
  const body = opts.rowW !== undefined ? wrapRows(graph.body, opts, opts.rowW) : chain(graph.body, opts);
  const out: Out = { nodes: [], paths: [], seq: 0 };
  body.draw(MARGIN, MARGIN, out);
  return { width: Math.ceil(body.w + 2 * MARGIN), height: Math.ceil(body.h + 2 * MARGIN), nodes: out.nodes, paths: out.paths };
}

/**
 * The layout of a stage graph fitted to a stage `stageW` px wide. It is drawn on one row while that fits at a scale of at least
 * LEGIBLE_K. Otherwise its top-level spine wraps into rows as wide as the stage at LEGIBLE_K. `k` is the scale it is shown at.
 */
export function planStages(graph: StageGraph, o: StageLayoutOptions & { stageW: number }): { layout: StageLayout; k: number } {
  const { stageW, ...opts } = o;
  const flat = layoutStages(graph, opts);
  if (!(stageW > 0)) return { layout: flat, k: MAX_K };
  const kFlat = Math.min(MAX_K, stageW / flat.width);
  if (kFlat >= LEGIBLE_K) return { layout: flat, k: kFlat };
  const rowW = Math.max(1, stageW / LEGIBLE_K - 2 * MARGIN - 2 * ROW_INDENT);
  const layout = layoutStages(graph, { ...opts, rowW });
  return { layout, k: Math.min(MAX_K, stageW / layout.width) };
}
