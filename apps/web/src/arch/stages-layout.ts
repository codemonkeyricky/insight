import type { DataEdge, StageGraph, StageNode } from "@insight/model";

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
export const MARGIN = 16;
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
export const ROW_INDENT = 18;
/** The space between two wrapped rows, where the return connector runs. */
const ROW_GAP = 64;
/** A stage is legible when its text stays at least 9px. The labels are 11px at most, so the scale must stay above 9/11. */
export const LEGIBLE_K = 0.85;
const MAX_K = 1;
/** A loop's or branch's condition is shown at most this many characters long; the full text is the title. */
export const CONDITION_MAX = 48;
/** A data pill: 10px monospace, about 0.64em a character, with this much room around the text. */
export const DATA_H = 16;
const DATA_CHAR_W = 6.4;
const DATA_PAD = 6;
/** Room kept between a data pill and the cards on either side of its connector. */
const PILL_GAP = 9;
/** A data pill's label is shown at most this many characters long. */
const DATA_TEXT_MAX = 26;
/**
 * A link's arc rises LINK_RISE above the higher of its two cards, plus LINK_STEP for its tier, so links over one span stay apart.
 * Its label sits at the apex and is nudged up by LABEL_NUDGE_Y, or sideways by LABEL_NUDGE_X, until it clears what it would hit.
 * No space is reserved for the arcs: they draw over the gaps between rows and the frames, and a top-row label stays in the margin.
 */
const LINK_RISE = 22;
const LINK_STEP = 14;
const LINK_TIERS = 3;
const LABEL_NUDGE_Y = DATA_H + 4;
const LABEL_NUDGE_X = 24;
const LABEL_NUDGE_STEPS = 6;
/** The room kept between a link label and what it must clear. */
const LABEL_GAP = 2;
/** The highest apex: a label's top sits at the margin's edge, so a label of the top row stays inside the stage at any scale up to 1. */
const MARGIN_TOP_LABEL = -MARGIN + DATA_H / 2;
const ARC_STEPS = 16;

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
      /** The stage this card draws (the call's id), for data edges. */
      stage?: string;
    }
  | {
      kind: "frame";
      key: string;
      x: number;
      y: number;
      w: number;
      h: number;
      label: string;
      titleFull: string;
      tone: "loop" | "helper" | "try";
      site?: Site;
      stage?: string;
    }
  | { kind: "diamond"; key: string; x: number; y: number; w: number; h: number; titleFull: string; site?: Site; stage?: string }
  | { kind: "pill"; key: string; x: number; y: number; w: number; h: number; text: string; how: "continue" | "break" | "return" | "throw"; site?: Site }
  | { kind: "text"; key: string; x: number; y: number; text: string; titleFull?: string; tone: "cond" | "lane" | "catch" | "muted" }
  /** A data edge drawn on the connector between two neighbouring stages. */
  | { kind: "data"; key: string; x: number; y: number; w: number; h: number; text: string; titleFull: string; from: string; to: string };

export interface LayoutPath {
  key: string;
  points: Point[];
  tone: "flow" | "return" | "catch" | "join";
  /** Whether the line ends in an arrowhead. */
  arrow: boolean;
}

/** A data edge between two stages that are not neighbours: a dashed arc from the producer's card to the consumer's. */
export interface LayoutDataLink {
  key: string;
  from: string;
  to: string;
  points: Point[];
  text: string;
  titleFull: string;
  /** The label's top-left corner, and its width. Its height is DATA_H. */
  x: number;
  y: number;
  w: number;
}

export interface StageLayout {
  width: number;
  height: number;
  /** Frames come first, so cards and labels draw on top of them. */
  nodes: LayoutNode[];
  /** Polylines, drawn above frames and below cards. */
  paths: LayoutPath[];
  /** Data edges that are not drawn on a connector: shown on hover of one of their stages. Empty unless `data` is set. */
  links: LayoutDataLink[];
  /** The highest y any link reaches. It is never above -MARGIN, so every arc and label is inside the stage at the fit. */
  top: number;
}

export interface StageLayoutOptions {
  /** Minor calls (utility callees) are shown. Hidden by default. */
  showAll?: boolean;
  /** When set, the top-level spine wraps into rows no wider than this many px (breaking only between items). */
  rowW?: number;
  /** Data edges are drawn: pills on the connectors of neighbouring stages, and links for the rest. Off by default. */
  data?: boolean;
}

/** A data edge as drawn: its label, and its width on a connector. */
interface DataPill {
  text: string;
  title: string;
  w: number;
}

/** The options plus what one layout pass shares: the pills by "from\0to", and the pills it drew. */
interface Ctx extends StageLayoutOptions {
  pills: Map<string, DataPill>;
  used: Set<string>;
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
  /** The stage at the block's left and right end, when that stage is a card, frame or diamond: a connector joins these. */
  first?: string;
  last?: string;
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
function chain(nodes: StageNode[], o: Ctx): Sized {
  return spine(
    nodes.map((n) => sizeOf(n, o)).filter((p): p is Sized => p !== undefined),
    o,
  );
}

const pillKey = (from: string | undefined, to: string | undefined): string | undefined => (from !== undefined && to !== undefined ? `${from}\0${to}` : undefined);

/** The data pill on the connector between two neighbours, when a data edge joins their stages. */
function pillBetween(prev: Sized, next: Sized, o: Ctx): { key: string; pill: DataPill } | undefined {
  const key = pillKey(prev.last, next.first);
  const pill = key !== undefined ? o.pills.get(key) : undefined;
  return key !== undefined && pill !== undefined ? { key, pill } : undefined;
}

/** The width of the connector before `next`: a data pill on it widens it to fit the pill. */
function connectorW(prev: Sized, next: Sized, o: Ctx): number {
  const hit = pillBetween(prev, next, o);
  return hit !== undefined ? Math.max(GAP, hit.pill.w + 2 * PILL_GAP) : GAP;
}

/** Blocks laid left to right on one spine, joined by arrows. A connector with a data pill is as wide as the pill. */
function spine(parts: Sized[], o: Ctx): Sized {
  if (parts.length === 0) {
    return { w: EMPTY_W, h: 0, mid: 0, empty: true, draw: (x, y, out) => pushPath(out, [[x, y], [x + EMPTY_W, y]], "flow", false) };
  }
  const top = Math.max(...parts.map((p) => p.mid));
  const below = Math.max(...parts.map((p) => p.h - p.mid));
  // gaps[i] is the connector before part i (unused for the first part).
  const gaps = parts.map((p, i) => {
    const prev = parts[i - 1];
    return prev === undefined ? 0 : connectorW(prev, p, o);
  });
  const w = parts.reduce((sum, p) => sum + p.w, 0) + gaps.reduce((sum, g) => sum + g, 0);
  return {
    w,
    h: top + below,
    mid: top,
    empty: false,
    first: parts[0]?.first,
    last: parts[parts.length - 1]?.last,
    draw(x, y, out) {
      let cx = x;
      let prevRight = x;
      parts.forEach((p, i) => {
        if (i > 0) {
          const at = y + top;
          pushPath(out, [[prevRight, at], [cx, at]], "flow", true);
          const hit = pillBetween(parts[i - 1] as Sized, p, o);
          if (hit !== undefined) {
            const { key, pill } = hit;
            o.used.add(key);
            const [from, to] = key.split("\0") as [string, string];
            const mid = (prevRight + cx) / 2;
            pushNode(out, { kind: "data", x: mid - pill.w / 2, y: at - DATA_H / 2, w: pill.w, h: DATA_H, text: pill.text, titleFull: pill.title, from, to });
          }
        }
        p.draw(cx, y + top - p.mid, out);
        prevRight = cx + p.w;
        cx = prevRight + (gaps[i + 1] ?? 0);
      });
    },
  };
}

/** The label of a data edge: `name: Type` when that fits, else the name; the full text is the title. */
function pillOf(e: DataEdge): DataPill {
  const short = e.type !== undefined && e.label.length + 2 + e.type.length <= DATA_TEXT_MAX ? `${e.label}: ${e.type}` : e.label;
  const text = clip(short, DATA_TEXT_MAX);
  return { text, title: e.type !== undefined ? `${e.label}: ${e.type}` : e.label, w: Math.ceil(text.length * DATA_CHAR_W + 2 * DATA_PAD) };
}

function sizeOf(n: StageNode, o: Ctx): Sized | undefined {
  const s = sizeOfNode(n, o);
  if (s === undefined || (n.kind !== "call" && n.kind !== "loop" && n.kind !== "branch")) return s;
  // A stage's card, frame or diamond is tagged with the stage's id as it is drawn, so data edges can find its box.
  const id = n.id;
  const draw = s.draw;
  return {
    ...s,
    first: id,
    last: id,
    draw(x, y, out) {
      const from = out.nodes.length;
      draw(x, y, out);
      for (let i = from; i < out.nodes.length; i++) {
        const d = out.nodes[i];
        if (d !== undefined && (d.kind === "card" || d.kind === "frame" || d.kind === "diamond") && d.stage === undefined) d.stage = id;
      }
    },
  };
}

function sizeOfNode(n: StageNode, o: Ctx): Sized | undefined {
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

function callSized(n: Extract<StageNode, { kind: "call" }>, o: Ctx): Sized | undefined {
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

function branchSized(n: Extract<StageNode, { kind: "branch" }>, o: Ctx): Sized {
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
function trySized(n: Extract<StageNode, { kind: "try" }>, o: Ctx): Sized {
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
function wrapRows(nodes: StageNode[], o: Ctx, rowW: number): Sized {
  const parts = nodes.map((n) => sizeOf(n, o)).filter((p): p is Sized => p !== undefined);
  const rows: Sized[][] = [];
  let cur: Sized[] = [];
  let curW = 0;
  for (const p of parts) {
    // A row's width counts its connectors as the spine draws them, a pill's width included.
    const prev = cur[cur.length - 1];
    if (prev === undefined) {
      curW = p.w;
    } else if (curW + connectorW(prev, p, o) + p.w > rowW) {
      rows.push(cur);
      cur = [];
      curW = p.w;
    } else {
      curW += connectorW(prev, p, o) + p.w;
    }
    cur.push(p);
  }
  if (cur.length > 0) rows.push(cur);
  if (rows.length <= 1) return spine(parts, o);
  const lines = rows.map((r) => spine(r, o));
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

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The box of each stage that drew a card, frame or diamond. A stage draws one, so the first is the one. */
function boxesOf(nodes: LayoutNode[]): Map<string, Box> {
  const boxes = new Map<string, Box>();
  for (const n of nodes) {
    if ((n.kind === "card" || n.kind === "frame" || n.kind === "diamond") && n.stage !== undefined && !boxes.has(n.stage)) {
      boxes.set(n.stage, { x: n.x, y: n.y, w: n.w, h: n.h });
    }
  }
  return boxes;
}

/** Whether two boxes overlap, with `gap` px of room kept between them. */
const overlaps = (a: Box, b: Box, gap = 0): boolean =>
  a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;

/** A dashed arc from the top middle of one box to the top middle of another, passing through `apex` at its midpoint. */
function arcBetween(a: Box, b: Box, apex: Point): Point[] {
  const xa = a.x + a.w / 2;
  const ya = a.y;
  const xb = b.x + b.w / 2;
  const yb = b.y;
  // A quadratic curve's midpoint is a quarter of the start, half the control and a quarter of the end: the control that puts it at `apex`.
  const cx = 2 * apex[0] - (xa + xb) / 2;
  const cy = 2 * apex[1] - (ya + yb) / 2;
  const pts: Point[] = [];
  for (let i = 0; i <= ARC_STEPS; i++) {
    const t = i / ARC_STEPS;
    const u = 1 - t;
    pts.push([u * u * xa + 2 * u * t * cx + t * t * xb, u * u * ya + 2 * u * t * cy + t * t * yb]);
  }
  return pts;
}

/** One drawing of the body: the nodes and paths, and the pills it drew on connectors. */
function drawPass(graph: StageGraph, opts: StageLayoutOptions, pills: Map<string, DataPill>) {
  const o: Ctx = { ...opts, pills, used: new Set() };
  const body = opts.rowW !== undefined ? wrapRows(graph.body, o, opts.rowW) : chain(graph.body, o);
  const out: Out = { nodes: [], paths: [], seq: 0 };
  body.draw(MARGIN, MARGIN, out);
  return { body, out, used: o.used };
}

/** A link to place: its data edge and the boxes of its two stages. */
interface LinkSpan {
  e: DataEdge;
  a: Box;
  b: Box;
}

/**
 * The arcs and labels of the links. A link's apex sits LINK_RISE above the higher of its two cards, plus a step for its tier. Its label
 * is centred on the apex, then nudged up, then sideways, until it clears the cards, frame headers, data pills and labels placed before it.
 * It stays inside the diagram's width, so its x is at least 0.
 */
function placeLinks(spans: LinkSpan[], obstacles: Box[], width: number): LayoutDataLink[] {
  const placed: Box[] = [];
  return spans.map(({ e, a, b }, i) => {
    const pill = pillOf(e);
    const top = Math.min(a.y, b.y);
    const ideal = (a.x + a.w / 2 + b.x + b.w / 2) / 2;
    // The apex stays low enough that its label's top is within the margin above the diagram, so the label is inside the stage.
    const apexY = Math.max(MARGIN_TOP_LABEL, top - (LINK_RISE + LINK_STEP * (i % LINK_TIERS)));
    const at = (dx: number, up: number): { apex: Point; label: Box } => {
      const x = Math.min(Math.max(0, ideal + dx - pill.w / 2), Math.max(0, width - pill.w));
      const y = apexY - up * LABEL_NUDGE_Y;
      return { apex: [x + pill.w / 2, y], label: { x, y: y - DATA_H / 2, w: pill.w, h: DATA_H } };
    };
    const clear = (label: Box): boolean =>
      label.y >= -MARGIN && !obstacles.some((o) => overlaps(label, o, LABEL_GAP)) && !placed.some((p) => overlaps(label, p, LABEL_GAP));
    // Labels in the top band can only move sideways, so the search reaches across the whole width.
    const maxSteps = Math.ceil(width / LABEL_NUDGE_X);
    let chosen: { apex: Point; label: Box } | undefined;
    for (let up = 0; up <= LABEL_NUDGE_STEPS && chosen === undefined; up++) {
      for (let k = 0; k <= maxSteps && chosen === undefined; k++) {
        for (const dx of k === 0 ? [0] : [k * LABEL_NUDGE_X, -k * LABEL_NUDGE_X]) {
          const c = at(dx, up);
          if (clear(c.label)) {
            chosen = c;
            break;
          }
        }
      }
    }
    const { apex, label } = chosen ?? at(0, 0);
    placed.push(label);
    return {
      key: `l${i}`,
      from: e.from,
      to: e.to,
      points: arcBetween(a, b, apex),
      text: pill.text,
      titleFull: pill.title,
      x: label.x,
      y: label.y,
      w: pill.w,
    };
  });
}

/**
 * The layout of a stage graph: the driver's body on one spine from the left, with its margin. A data edge between two neighbours
 * is a pill on their connector; an edge between stages further apart is a link, which arcs above the diagram. Deterministic.
 */
export function layoutStages(graph: StageGraph, opts: StageLayoutOptions = {}): StageLayout {
  const pills = new Map<string, DataPill>();
  if (opts.data === true) for (const e of graph.edges) pills.set(`${e.from}\0${e.to}`, pillOf(e));
  const pass = drawPass(graph, opts, pills);
  const boxes = boxesOf(pass.out.nodes);
  const width = Math.ceil(pass.body.w + 2 * MARGIN);
  // The links are the edges that are not on a connector and have both stages drawn (a minor stage is hidden).
  const linked = opts.data === true ? graph.edges.filter((e) => !pass.used.has(`${e.from}\0${e.to}`) && boxes.has(e.from) && boxes.has(e.to)) : [];
  const spans = linked.flatMap((e): LinkSpan[] => {
    const a = boxes.get(e.from);
    const b = boxes.get(e.to);
    return a !== undefined && b !== undefined ? [{ e, a, b }] : [];
  });
  // What a link label must clear: the cards and diamonds, the frame headers, and the data pills.
  const obstacles = pass.out.nodes.flatMap((n): Box[] => {
    if (n.kind === "card" || n.kind === "diamond" || n.kind === "data") return [n];
    if (n.kind === "frame") return [{ x: n.x, y: n.y, w: n.w, h: LABEL_H }];
    return [];
  });
  const links = placeLinks(spans, obstacles, width);
  const top = Math.min(0, ...links.flatMap((l) => [l.y, ...l.points.map((p) => p[1])]));
  return {
    width,
    height: Math.ceil(pass.body.h + 2 * MARGIN),
    nodes: pass.out.nodes,
    paths: pass.out.paths,
    links,
    top,
  };
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
