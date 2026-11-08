// The entry view's scene: the unreferenced functions of one scope, as boxes in file frames, and the ladder of the
// scope's ancestors. Pure data and arithmetic. The view draws no edges: an unreferenced function cannot be the callee
// of a function in its scope, since that caller would make it referenced, so no two boxes call each other.
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

/** The counts the ladder shows for one scope. `unreferenced` leaves out noise rows; `noise` counts them. */
export interface EntryCount {
  unreferenced: number;
  noise: number;
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
