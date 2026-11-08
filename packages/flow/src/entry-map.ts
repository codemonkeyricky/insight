// The entry view's scene: the unreferenced functions of one scope, as boxes in file frames, and the ladder of the
// scope's ancestors. Pure data and arithmetic. The view draws no edges: an unreferenced function cannot be the callee
// of a function in its scope, since that caller would make it referenced, so no two boxes call each other.
import type { Rect } from "./scope-map.js";
import { isNoisePath } from "./scope.js";
import type { ScopeFlow, UnreferencedFunction } from "./types.js";
import { ZOOM_SIZE, frameSize } from "./zoom-layout.js";

/** Boxes in one column of a file frame before the next column starts. */
export const ENTRY_ROWS = 10;
/** Gap between boxes, both across and down a frame. */
const BOX_GAP = 8;
/** Gap between frames, both across and down the map. */
const FRAME_GAP = 24;
/** A frame is never narrower than this, so its file name fits in the header. */
const MIN_FRAME_W = 260;
/** The width at which frames wrap onto a new row. */
export const ENTRY_WRAP = 1280;

const cmpText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** One unreferenced function as the entry view shows it. */
export interface EntryBox {
  id: string;
  name: string;
  file: string;
  /** 1-based line of the definition. */
  line: number;
  async: boolean;
  reach: number;
  /** A caller outside the scope reaches it. It still counts as an entry here. */
  calledFromOutside: boolean;
  /** Set for a function in a test, fixture or sample file. */
  noise: boolean;
}

/** The boxes of one file, in line order. `noise` is set for a test, fixture or sample file. */
export interface EntryFrame {
  file: string;
  noise: boolean;
  boxes: EntryBox[];
}

export interface PlacedEntryBox extends EntryBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PlacedEntryFrame {
  file: string;
  noise: boolean;
  x: number;
  y: number;
  w: number;
  h: number;
  boxes: PlacedEntryBox[];
}

export interface EntryLayout {
  width: number;
  height: number;
  frames: PlacedEntryFrame[];
}

export interface EntryOptions {
  /** Whether the functions of test, fixture and sample files are shown. */
  includeNoise: boolean;
  /** Width at which frames wrap. Defaults to `ENTRY_WRAP`. */
  wrap?: number;
}

/** The unreferenced functions to show, sorted by file and then line. Noise rows are left out unless asked for. */
export function entryBoxes(flow: ScopeFlow, includeNoise: boolean): EntryBox[] {
  const rows = flow.unreferenced.filter((f: UnreferencedFunction) => includeNoise || !f.noise);
  return rows
    .map((f) => ({
      id: f.id,
      name: f.name,
      file: f.file,
      line: f.line,
      async: f.async,
      reach: f.reach,
      calledFromOutside: f.calledFromOutside === true,
      noise: f.noise === true,
    }))
    .sort((a, b) => cmpText(a.file, b.file) || a.line - b.line || cmpText(a.id, b.id));
}

/** The frames of the entry view: one per file that has a shown box, in path order. */
export function entryFrames(flow: ScopeFlow, includeNoise: boolean): EntryFrame[] {
  const frames = new Map<string, EntryFrame>();
  for (const b of entryBoxes(flow, includeNoise)) {
    const fr = frames.get(b.file) ?? { file: b.file, noise: isNoisePath(b.file), boxes: [] };
    fr.boxes.push(b);
    frames.set(b.file, fr);
  }
  return [...frames.values()].sort((a, b) => cmpText(a.file, b.file));
}

/** The size of a frame that holds `count` boxes: a grid of up to `ENTRY_ROWS` boxes per column, inside its header. */
function frameBox(count: number): { w: number; h: number; cols: number } {
  const rows = Math.min(count, ENTRY_ROWS);
  const cols = Math.ceil(count / ENTRY_ROWS);
  const inner = {
    w: cols * ZOOM_SIZE.fn.w + (cols - 1) * BOX_GAP,
    h: rows * ZOOM_SIZE.fn.h + (rows - 1) * BOX_GAP,
  };
  const outer = frameSize(inner);
  return { w: Math.max(outer.w, MIN_FRAME_W), h: outer.h, cols };
}

/**
 * Lays the frames out in rows that wrap at `wrap` wide, each frame with its boxes in a grid. Frames sit in path order,
 * so a file stays near its neighbours. A frame wider than `wrap` takes a row to itself.
 */
export function layoutEntries(flow: ScopeFlow, opts: EntryOptions): EntryLayout {
  const wrap = opts.wrap ?? ENTRY_WRAP;
  const frames = entryFrames(flow, opts.includeNoise);
  const placed: PlacedEntryFrame[] = [];
  let x = 0;
  let y = 0;
  let rowH = 0;
  let width = 0;
  for (const fr of frames) {
    const size = frameBox(fr.boxes.length);
    if (x > 0 && x + size.w > wrap) {
      y += rowH + FRAME_GAP;
      x = 0;
      rowH = 0;
    }
    const boxes: PlacedEntryBox[] = fr.boxes.map((b, i) => {
      const col = Math.floor(i / ENTRY_ROWS);
      const row = i % ENTRY_ROWS;
      return {
        ...b,
        x: x + ZOOM_SIZE.pad + col * (ZOOM_SIZE.fn.w + BOX_GAP),
        y: y + ZOOM_SIZE.head + row * (ZOOM_SIZE.fn.h + BOX_GAP),
        w: ZOOM_SIZE.fn.w,
        h: ZOOM_SIZE.fn.h,
      };
    });
    placed.push({ file: fr.file, noise: fr.noise, x, y, w: size.w, h: size.h, boxes });
    x += size.w + FRAME_GAP;
    rowH = Math.max(rowH, size.h);
    width = Math.max(width, x - FRAME_GAP);
  }
  return { width, height: frames.length === 0 ? 0 : y + rowH, frames: placed };
}

/**
 * The counts the ladder shows for one scope, as `unreferenced/total`. With the toggle off both leave out noise, so the
 * total is the functions outside test, fixture and sample files. With it on both include them.
 */
export interface EntryCount {
  unreferenced: number;
  total: number;
}

export function entryCount(flow: ScopeFlow, includeNoise: boolean): EntryCount {
  const s = flow.stats;
  return includeNoise
    ? { unreferenced: s.unreferenced + s.unreferencedNoise, total: s.functionsTotal }
    : { unreferenced: s.unreferenced, total: s.functionsNonNoise };
}

/** The summary line of the entry view. `hiddenNoise` is what the Include toggle would add. */
export interface EntrySummary {
  shown: number;
  files: number;
  noise: number;
  hiddenNoise: number;
  outside: number;
}

export function entrySummary(flow: ScopeFlow, includeNoise: boolean): EntrySummary {
  const shown = entryBoxes(flow, includeNoise).length;
  return {
    shown,
    files: entryFrames(flow, includeNoise).length,
    noise: flow.stats.unreferencedNoise,
    hiddenNoise: includeNoise ? 0 : flow.stats.unreferencedNoise,
    outside: flow.stats.unreferencedOutside,
  };
}

/** The scope and its ancestors, nearest first, ending with the project scope "". */
export function scopeChain(scope: string): string[] {
  const out = [scope];
  let cur = scope;
  while (cur !== "") {
    const at = cur.lastIndexOf("/");
    cur = at === -1 ? "" : cur.slice(0, at);
    out.push(cur);
  }
  return out;
}

/** One rung of the ladder. `counts` is undefined while that scope's flow is not loaded. */
export interface LadderRung {
  scope: string;
  name: string;
  current: boolean;
  counts: EntryCount | undefined;
}

/**
 * The ladder of a scope: the project at the top, then each folder down to the scope, which is last and marked
 * `current`. `countOf` gives the counts of an ancestor, when its flow is known.
 */
export function ladderOf(scope: string, countOf: (scope: string) => EntryCount | undefined): LadderRung[] {
  return scopeChain(scope)
    .reverse()
    .map((s) => ({
      scope: s,
      name: s === "" ? "project" : s.slice(s.lastIndexOf("/") + 1),
      current: s === scope,
      counts: countOf(s),
    }));
}

/** A box opens when it is wider than this on screen, judged at the end of a gesture that zoomed in or panned. */
export const ENTRY_OPEN_PX = 360;
/** An open function closes when its card is narrower than this on screen. The gap to ENTRY_OPEN_PX stops a flicker. */
export const ENTRY_CLOSE_PX = 200;
/** Room under a card's header for its message when the chart is too large to draw, or has no steps. */
const MESSAGE_H = 60;

/** The box whose rectangle holds a world point, or undefined. A point on an edge counts as inside. */
export function entryBoxAt(layout: EntryLayout, x: number, y: number): PlacedEntryBox | undefined {
  for (const fr of layout.frames) {
    for (const b of fr.boxes) {
      if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return b;
    }
  }
  return undefined;
}

/** The frame that holds a box, or undefined when no shown box has that id. */
export function entryFrameOf(layout: EntryLayout, boxId: string): PlacedEntryFrame | undefined {
  return layout.frames.find((fr) => fr.boxes.some((b) => b.id === boxId));
}

/**
 * The card an open function's chart sits in, in world units, at the box's top-left. It is as wide as the box or the
 * chart with its padding, whichever is wider, and as tall as the header, the chart and the padding. A chart too large
 * to draw, or with no steps, gets the box's width and room for a message. So does a chart still loading (`undefined`).
 */
export function entryCard(box: PlacedEntryBox, chart: { width: number; height: number; tooLarge?: boolean; empty?: boolean } | undefined): Rect {
  const { pad, head } = ZOOM_SIZE;
  if (chart === undefined || chart.tooLarge || chart.empty) return { x: box.x, y: box.y, w: box.w, h: head + MESSAGE_H };
  return { x: box.x, y: box.y, w: Math.max(box.w, chart.width + 2 * pad), h: head + chart.height + 2 * pad };
}

/** What a gesture does to the open function: open a box, close the open one, or keep things as they are. */
export type EntryDecision = { kind: "open"; id: string } | { kind: "close" };

/**
 * The decision at the end of a user gesture. `open` is the open function, if any, and `cardPx` its card's width on
 * screen. `under` is the box under the wheel pointer or the view's centre, with its width on screen. `mayOpen` is false
 * for a gesture that zoomed out, which must not reopen the box it just left. Only one function is open at a time, so a
 * box opens only when nothing is open, and an open function closes only when its card is narrower than ENTRY_CLOSE_PX.
 */
export function entryDecision(input: {
  open: string | undefined;
  cardPx: number | undefined;
  under: { id: string; px: number } | undefined;
  mayOpen: boolean;
}): EntryDecision | undefined {
  if (input.open === undefined) {
    const under = input.under;
    return input.mayOpen && under !== undefined && under.px > ENTRY_OPEN_PX ? { kind: "open", id: under.id } : undefined;
  }
  return input.cardPx !== undefined && input.cardPx < ENTRY_CLOSE_PX ? { kind: "close" } : undefined;
}
