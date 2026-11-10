// The zoom map: one d3-zoom camera over a scene from a MapSource (the execution canvas of a scope). The camera only moves
// (wheel, drag, keys, minimap). A click, a key or a link opens a box, and the URL follows the focus. A function box with
// a control-flow chart opens an expansion: its chart drawn in a box to the right of the function (zoom/expand.ts), and a
// call step in that chart opens the callee's expansion to the right of the step. Expansions are the map's own state, so
// no layout depends on them. The camera transform is written straight onto a <g>; React re-renders only when the set of
// drawn items changes.
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as KeyEvent, type PointerEvent as PointerEv, type ReactNode } from "react";
import { select } from "d3-selection";
import { zoom, zoomIdentity, type D3ZoomEvent, type ZoomBehavior, type ZoomTransform } from "d3-zoom";
import { MORE_SUFFIX, ZOOM_SIZE, fitCamera, fitChartCamera, visibleWorld, type Camera, type FlowNode, type FlowSpan, type FunctionFlow, type PlacedItem, type Rect } from "@insight/flow";
import { nameOfId } from "../../flowTargets";
import { hrefView } from "../../router";
import { CHART_MIN_PX } from "../../zoom/chart";
import { anchoredTo, calloutOf, closeExpansion, footprintOf, openExpansion, refresh, revealCamera, rootBoxOf, sameFootprint, SLOT_PAD, shiftAt, type Expansion, type ExpandAnchor } from "../../zoom/expand";
import { calloutD } from "../../zoom/connector";
import { popDelay } from "../../zoom/pop";
import { displayName } from "../../zoom/names";
import { releaseVelocity, type DragSample } from "../../zoom/spring";
import { useCameraSpring } from "../../zoom/useCameraSpring";
import { motionFor, progressAt, TWEEN_MS } from "../../zoom/tween";
import { pickBox } from "../../zoom/gesture";
import { clampTop } from "../../zoom/clampTop";
import { edgeClass, edgeKey, edgeTitle, edgeWidth, lineClass, runtimeLine, type MapBuild, type MapEdge, type MapNode, type MapSelected, type MapSource, type RuntimeLine } from "../../zoom/source";
import { bucketScale, FAR_TILE_PX, fitLabel, headerLabels, labelChars, lodBucket, MID_TILE_PX } from "../../zoom/lod";
import { badgeText, cloudPath, markerAnchors, MARKER_BADGE_R, MARKER_TRIANGLE } from "../../zoom/findingsLayer";
import { aggregateEdges, cardKeyAt, groupCards, medianOf, pickCardDepth, segmentsBelow } from "../../zoom/cards";
import { FarCards, type FarCard } from "./FarCards";
import { zoneCells, zoneLetter, zoneLines } from "../../zoom/zones";
import { offMapSelected } from "../../zoom/offMap";
import type { ZoomStore } from "../../zoom/scene";
import { CalloutShape, ExpansionShape, type CalloutEnds } from "./Expansion";

/** The camera's scale range: from the whole project down to a single line of a chart. */
const SCALE: [number, number] = [0.02, 16];
/** Items this far (world units) outside the view are still drawn, so a pan does not show a blank edge. */
const CULL_MARGIN = 120;
const PAN_PX = 80;
/**
 * Room at the bottom of the stage that a fit leaves clear for the minimap: its height (110 px, see styles.css), its 10 px
 * inset and a 10 px margin. A selected function fits above it, so the minimap never covers the chart.
 */
const MINI_RESERVE = 130;
/**
 * Room at the top of the stage that a fit leaves clear for the header chips: the Show card and the breadcrumb (see the
 * flow view's styles). A fitted box sits below them, so its frame's header is not drawn under a chip.
 */
const TOP_RESERVE = 76;
/** On a phone-width stage the key plan sits higher, so the far grid keeps clear of it by more. */
const MINI_RESERVE_NARROW = 184;
const NARROW_STAGE_PX = 520;
/** The gap a fit keeps above a bottom sheet's top edge. */
const SHEET_ROOM_MARGIN = 16;
/** A function tile at least this tall on screen (px) shows its name in the mid tier. */
const TILE_LABEL_PX = 16;

const sameList = <T,>(a: readonly T[], b: readonly T[], key: (t: T) => string): boolean =>
  a.length === b.length &&
  a.every((x, i) => {
    const y = b[i];
    return y !== undefined && key(x) === key(y);
  });

const intersects = (a: Rect, b: Rect) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

const union = (a: Rect, b: Rect): Rect => {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
};

/** The rectangle `rect` grown to hold every open expansion in `list`. */
const unionWith = (rect: Rect, list: readonly Expansion[]): Rect => list.reduce((r, e) => union(r, { x: e.x, y: e.y, w: e.w, h: e.h }), rect);

const toCamera = (t: ZoomTransform): Camera => ({ k: t.k, x: t.x, y: t.y });
const toTransform = (c: Camera): ZoomTransform => zoomIdentity.translate(c.x, c.y).scale(c.k);
/** How long a closing detail stays drawn while it shrinks and fades: the exit's length (see styles.css). */
const EXIT_CLOSE_MS = 200;
const reduceMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** A d3 event that came from the user's pointer (a drag), not from a programmatic move of the camera. */
const isPointerGesture = (e: unknown) => e instanceof Event && /^(pointer|mouse|touch)/.test(e.type);

/**
 * The side shift on screen: each open detail pushes the columns right of its pivot over by its width. `base` is the shift
 * being eased away from, `to` the expansions it eases toward, and `p` the eased progress from 0 (base) to 1 (to). `t0` is
 * when the ease started (set on its first frame), so the ease runs on the map's shared 260 ms curve.
 */
interface ShiftState {
  base: (x: number) => number;
  to: readonly Expansion[];
  p: number;
  t0?: number;
  frame?: number;
}

/** The shift an item at x shows now: the eased value between the base and the target expansions. */
function displayShift(sh: ShiftState, x: number): number {
  const b = sh.base(x);
  return b + (shiftAt(sh.to, x) - b) * sh.p;
}

/**
 * Writes the side shift onto the world's drawn parts, without React: an item marked `data-sx` (its unshifted x) moves by
 * its shift, and an edge's curve (`data-sd`, its unshifted path) is redrawn with each point moved by the shift at its x, so
 * a call that crosses a pivot stretches. Runs once a frame while the shift eases, and after each render.
 */
function writeShift(root: SVGGElement, sh: ShiftState) {
  for (const el of root.querySelectorAll<SVGElement>("[data-sx]")) {
    const dx = displayShift(sh, Number(el.getAttribute("data-sx")));
    if (dx === 0) el.removeAttribute("transform");
    else el.setAttribute("transform", `translate(${dx} 0)`);
  }
  for (const el of root.querySelectorAll<SVGPathElement>("path[data-sd]")) {
    const nums = (el.getAttribute("data-sd") ?? "").match(/-?\d+(?:\.\d+)?/g)?.map(Number);
    if (nums === undefined || nums.length !== 8) continue;
    const [sx, sy, c1x, c1y, c2x, c2y, ex, ey] = nums as [number, number, number, number, number, number, number, number];
    const at = (x: number) => x + displayShift(sh, x);
    el.setAttribute("d", `M${at(sx)} ${sy} C${at(c1x)} ${c1y} ${at(c2x)} ${c2y} ${at(ex)} ${ey}`);
  }
  // A callout's edges: its anchor edge moves with the anchor's shift (data-s1), its expansion edge with the detail's (data-s2).
  // Its top and bottom are unshifted. It is redrawn from its unshifted edges, so it stays on its boxes through a slide.
  for (const el of root.querySelectorAll<SVGPathElement>("path.zm-callout[data-ax]")) {
    const num = (name: string) => Number(el.getAttribute(name));
    const ax = num("data-ax") + displayShift(sh, num("data-s1"));
    const ex = num("data-ex") + displayShift(sh, num("data-s2"));
    el.setAttribute("d", calloutD(ax, num("data-ayt"), num("data-ayb"), ex, num("data-eyt"), num("data-eyb")));
  }
}

/** The ends of the callout of an expansion, in world units: from its anchor's right edge to its box, see calloutOf. */
function endsOf(e: Expansion, list: readonly Expansion[]): CalloutEnds | undefined {
  const c = calloutOf(e, list);
  if (c === undefined) return undefined;
  return { ...c, s1: e.anchor.kind === "box" ? e.anchor.rect.x : e.pivot, s2: e.pivot };
}

/** What the map has selected, for the page's source panel: the function, its build, and the construct picked in its chart. */
export interface MapSelection {
  build: MapBuild;
  selected: MapSelected;
  /** The span of the construct picked in the function's chart. Undefined for the whole function. */
  construct?: FlowSpan;
}

interface Props {
  id: string;
  /** Where the scene comes from. The map draws whatever it builds. */
  source: MapSource;
  /** The URL's scope: a folder, or a file (a function's file). Empty is the project. */
  scope: string;
  /** The URL's function, when one is picked. */
  fn?: string;
  /** What the page draws below the map for the focus, such as the function panel. `open` moves the map to a node id. */
  detail?: (build: MapBuild, open: (nodeId: string) => void) => ReactNode;
  /** Where a function's control-flow chart is loaded from. Without it, function boxes open no expansion. */
  charts?: ChartSource;
  /** Reports the function the map selects (undefined when the focus is not a function), with the construct picked in it. */
  onSelect?: (sel: MapSelection | undefined) => void;
  /** Reports the build the map is showing (its focus), or undefined before the first one. */
  onFocus?: (build: MapBuild | undefined) => void;
  /** Whether the map shows its key hints under the stage. The sheet keeps them in the layers panel instead. */
  hint?: boolean;
  /** Room the map gives up on the right, in px, such as a side panel over the stage. Fits and reveals keep clear of it. */
  inset?: number;
  /** Room the map gives up on the left, in px, such as the Layers panel. Fits and the zone rulers start after it. */
  leftInset?: number;
  /**
   * Room the map gives up at the bottom, in px: a bottom sheet over the stage. A fit leaves it clear, and the reader's open
   * detail is fitted above it once, when the sheet opens. Closing it does not move the camera.
   */
  bottomInset?: number;
  /** The findings layer: how many findings each function (by its id) has. Undefined when the layer is off. */
  findings?: ReadonlyMap<string, number>;
  /** Which parts of the map are drawn: the frames (file and runtime frames) and the call edges. Both on by default. */
  layers?: { frames: boolean; calls: boolean };
  /** The roots-only flat map: its boxes are cards with a file line, and the zone rulers and lines are off. */
  flat?: boolean;
  /** Whether the charts' edges march and the back-edges pulse (the Flow motion choice). On by default. */
  motion?: boolean;
}

/** What an expansion needs to draw its chart: the project, the scope its links resolve in, and the flow store. */
export interface ChartSource {
  id: string;
  scope: string;
  store: ZoomStore;
}

/** A construct picked in an expansion's chart: the function whose chart it is, the step, and its span. */
interface Construct {
  ref: string;
  nodeId: string;
  span?: FlowSpan;
}

/** A function selected without a box on the map, with the build it was selected on (the map's build stays as it is). */
interface OffMap {
  build: MapBuild;
  selected: MapSelected;
}

/**
 * The execution map: one camera over a scope's scene. Each node is a focus of the source; the map's items and edges
 * are named by node id, so a click or key that names a node is turned into a focus by the source first (`focusOf`).
 */
/** The smallest scale the whole project fits at. Below it the first program (the Browser one) fills the stage instead. */
const READABLE_FIT_K = 0.9;

export function ZoomMap({ id, source, scope, fn, detail, charts, onSelect, onFocus, hint = true, inset = 0, leftInset = 0, bottomInset = 0, findings, layers = { frames: true, calls: true }, flat = false, motion = true }: Props) {
  /** The details that are closing: they stay drawn for EXIT_CLOSE_MS while they shrink and fade (see setExp). */
  const [leaving, setLeaving] = useState<readonly Expansion[]>([]);
  /** The key plan's open state. It is closed by default, so it does not cover the boxes. */
  const [keyOpen, setKeyOpen] = useState(false);
  /** The selection: the focus the breadcrumb, the detail panel and the URL show. Only explicit actions change it. */
  const [build, setBuild] = useState<MapBuild>();
  /** The map as drawn: the selection's build. Only a click or a key changes it; gestures move the camera alone. */
  const [view, setView] = useState<MapBuild>();
  /** `lod` is the camera's quarter-octave bucket (lod.ts): labels are cut to it, and it changes only with the bucket. */
  const [shown, setShown] = useState<{ view?: MapBuild; items: PlacedItem[]; edges: MapEdge[]; lod: number }>({ items: [], edges: [], lod: 0 });
  /** The stage's size as the far layer lays out in it (set on each refit). */
  const [stageSize, setStageSize] = useState<{ width: number; height: number }>();
  const [error, setError] = useState<string>();
  /** The open expansions, in the order they opened (the last is closed first by Escape). */
  const [expansions, setExpansions] = useState<readonly Expansion[]>([]);
  /** The same list, for the handlers and the async `show`, which read it when they run. */
  const expRef = useRef<readonly Expansion[]>([]);
  /** The construct picked in an expansion's chart. */
  const [construct, setConstruct] = useState<Construct>();
  /** The off-map selection, when the reader selected a function the map does not draw (see selectFunction). */
  const [offMap, setOffMapState] = useState<OffMap>();
  /** The same selection, for the handlers and the async selects, which read it when they run. */
  const offMapRef = useRef<OffMap | undefined>(undefined);
  const stageRef = useRef<HTMLDivElement>(null);
  /** The stage's size at the last resize, so a resize that changes nothing does not refit the camera. */
  const lastSizeRef = useRef<{ width: number; height: number } | undefined>(undefined);
  /** Refits the selected focus when the usable size changed since the last refit. Set by the stage's effect. */
  const refitRef = useRef<((force?: boolean) => void) | undefined>(undefined);
  const svgRef = useRef<SVGSVGElement>(null);
  const worldRef = useRef<SVGGElement>(null);
  const miniRef = useRef<SVGSVGElement>(null);
  const miniViewRef = useRef<SVGRectElement>(null);
  /** The screen-space rulers (zone letters along the top, numbers down the left). Written by drawRulers, not by React. */
  const rulerRef = useRef<SVGSVGElement>(null);
  const zoomRef = useRef<ZoomBehavior<SVGSVGElement, unknown> | undefined>(undefined);
  const cameraRef = useRef<Camera>({ k: 1, x: 0, y: 0 });
  /** The selection's build. Its `nodeId` is the node the focus stands for. */
  const buildRef = useRef<MapBuild | undefined>(undefined);
  /** The build as drawn (see `view`). Its placed boxes are what the pointer looks at. */
  const viewRef = useRef<MapBuild | undefined>(undefined);
  /** The focus the map shows (the selection). Its build's `nodeId` is the node it stands for. */
  const focusRef = useRef<string | undefined>(undefined);
  const boxesRef = useRef<{ id: string; x: number; y: number; w: number; h: number }[]>([]);
  const seqRef = useRef(0);
  const miniDragRef = useRef(false);
  /** The side shift's state (see ShiftState). The spring starts at rest on the shift of the open details. */
  const shiftRef = useRef<ShiftState>({ base: () => 0, to: [], p: 1 });
  const arrowId = `zm-arrow-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const hintId = useId();

  /** The inset in use. A ref, so the size readers below see it without a new closure. */
  const insetRef = useRef(inset);
  /** The room given up on the left (the Layers panel). Fits and reveals start after it; the rulers start after it. */
  const leftRef = useRef(leftInset);
  /** The bottom sheet's room in use (see bottomInset). */
  const bottomRef = useRef(bottomInset);
  const sizeOf = () => ({
    width: Math.max(1, (stageRef.current?.clientWidth ?? 0) - insetRef.current),
    height: stageRef.current?.clientHeight ?? 0,
  });
  /** The stage's room above the minimap, and right of the left inset: where a fit or a reveal may put things. */
  const roomOf = () => {
    const s = sizeOf();
    // Above a bottom sheet the room ends at its top edge, with the same margin the minimap keeps.
    const reserve = bottomRef.current > 0 ? bottomRef.current + SHEET_ROOM_MARGIN : MINI_RESERVE;
    return { width: Math.max(1, s.width - leftRef.current), height: Math.max(1, s.height - reserve - TOP_RESERVE) };
  };

  /** The camera's spring. Every programmatic move goes through it; a user's gesture stops it (see the camera effect). */
  const cam = useCameraSpring(
    () => cameraRef.current,
    (c) => {
      const svg = svgRef.current;
      const z = zoomRef.current;
      if (svg && z) select(svg).call(z.transform, toTransform(c));
      else applyCamera(c);
    },
  );

  /** One frame of the side shift's ease: eases the columns on the shared curve, then writes them. Lands on the target. */
  const shiftFrame = (now: number) => {
    const sh = shiftRef.current;
    sh.frame = undefined;
    sh.t0 ??= now;
    sh.p = progressAt(sh.t0, now);
    if (sh.p >= 1) {
      const to = sh.to;
      sh.p = 1;
      sh.t0 = undefined;
      sh.base = (x) => shiftAt(to, x);
    } else {
      sh.frame = requestAnimationFrame(shiftFrame);
    }
    const root = worldRef.current;
    if (root) writeShift(root, sh);
  };

  /**
   * Starts the side shift easing toward `next`, from the shift on screen now, so an interrupted ease does not jump (the
   * ease restarts from there). Reduced motion, and a map crowded enough that sliding every box costs more than it shows,
   * cut to it.
   */
  const retargetShift = (next: readonly Expansion[]) => {
    const sh = shiftRef.current;
    const from = sh.base;
    const toPrev = sh.to;
    const pPrev = sh.p;
    sh.to = next;
    const mode = motionFor({ reduced: reduceMotion(), boxes: boxesRef.current.length });
    if (mode === "fade") {
      sh.base = (x) => shiftAt(next, x);
      sh.p = 1;
      sh.t0 = undefined;
      if (sh.frame !== undefined) cancelAnimationFrame(sh.frame);
      sh.frame = undefined;
      const root = worldRef.current;
      if (root) writeShift(root, sh);
      return;
    }
    // The shift on screen now becomes the base: the ease starts at 0, so nothing jumps.
    sh.base = (x) => {
      const b = from(x);
      return b + (shiftAt(toPrev, x) - b) * pPrev;
    };
    sh.p = 0;
    sh.t0 = undefined;
    if (sh.frame === undefined) sh.frame = requestAnimationFrame(shiftFrame);
  };

  const setExp = (next: readonly Expansion[]) => {
    // A slotted build keeps room for its expansions in the layout: when the open ones need different room, the build is
    // laid out again and the expansions are placed on its boxes (refresh), so an opened box never runs into another.
    let list = next;
    const b = buildRef.current;
    if (b?.slotted && source.rebuild) {
      const room = footprintOf(list);
      if (!sameFootprint(room, b.footprint ?? new Map())) {
        const nb = source.rebuild(b, room);
        buildRef.current = nb;
        setBuild(nb);
        showView(nb);
        list = refresh(list, (id) => nb.placed.rects.get(id), undefined);
      }
    }
    const gone = expRef.current.filter((e) => !list.some((x) => x.fnId === e.fnId));
    expRef.current = list;
    setExpansions(list);
    retargetShift(list);
    if (gone.length > 0) {
      // A closing detail is kept drawn for the exit's length, so it shrinks and fades instead of vanishing.
      setLeaving((prev) => [...prev.filter((p) => !gone.some((g) => g.fnId === p.fnId)), ...gone]);
      window.setTimeout(() => setLeaving((prev) => prev.filter((p) => !gone.includes(p))), EXIT_CLOSE_MS);
    }
  };

  const setOffMap = (v: OffMap | undefined) => {
    offMapRef.current = v;
    setOffMapState(v);
  };

  /** Works out which items and edges are on screen, and stores them only when they differ from the last set. */
  const cull = (c: Camera) => {
    const b = viewRef.current;
    if (!b) return;
    const v = visibleWorld(c, sizeOf());
    const area = { x: v.x - CULL_MARGIN, y: v.y - CULL_MARGIN, w: v.w + 2 * CULL_MARGIN, h: v.h + 2 * CULL_MARGIN };
    const items = b.placed.items.filter((i) => intersects(i.rect, area));
    const edges = b.edges.filter((e) => {
      const a = b.placed.rects.get(e.from);
      const z = b.placed.rects.get(e.to);
      return a !== undefined && z !== undefined && intersects(union(a, z), area);
    });
    const lod = lodBucket(c.k);
    setShown((prev) =>
      prev.view === b && prev.lod === lod && sameList(prev.items, items, (i) => i.id) && sameList(prev.edges, edges, edgeKey)
        ? prev
        : { view: b, items, edges, lod },
    );
  };

  /**
   * Writes the zone rulers for the visible area: a letter at each zone column's left edge along the top, and a number at
   * each row's top edge down the left. They sit in screen space, so they keep their size and stay on the stage.
   */
  const drawRulers = (c: Camera) => {
    const g = rulerRef.current;
    const sheetPlaced = viewRef.current?.placed;
    if (!g) return;
    if (sheetPlaced === undefined || flat) {
      g.replaceChildren();
      return;
    }
    const s = sizeOf();
    const left = leftRef.current;
    // The world on screen right of the left inset, cut to the sheet: rulers run only across the map's extent.
    const x0 = Math.max(0, (left - c.x) / c.k);
    const x1 = Math.min(sheetPlaced.width, (s.width - c.x) / c.k);
    const y0 = Math.max(0, -c.y / c.k);
    const y1 = Math.min(sheetPlaced.height, (s.height - c.y) / c.k);
    const cells = x1 > x0 && y1 > y0 ? zoneCells({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 }) : [];
    const cols = new Map<number, number>();
    const rows = new Map<number, number>();
    for (const z of cells) {
      if (!cols.has(z.col)) cols.set(z.col, z.x);
      if (!rows.has(z.row)) rows.set(z.row, z.y);
    }
    const NS = "http://www.w3.org/2000/svg";
    const nodes: SVGElement[] = [];
    const text = (x: number, y: number, t: string) => {
      const el = document.createElementNS(NS, "text");
      el.setAttribute("x", String(x));
      el.setAttribute("y", String(y));
      el.textContent = t;
      nodes.push(el);
    };
    const tick = (x1: number, y1: number, x2: number, y2: number) => {
      const el = document.createElementNS(NS, "line");
      el.setAttribute("x1", String(x1));
      el.setAttribute("y1", String(y1));
      el.setAttribute("x2", String(x2));
      el.setAttribute("y2", String(y2));
      nodes.push(el);
    };
    for (const [col, wx] of cols) {
      const sx = c.x + wx * c.k;
      if (sx < left || sx > s.width - 12) continue;
      tick(sx, 0, sx, 6);
      text(sx + 3, 12, zoneLetter(col));
    }
    for (const [row, wy] of rows) {
      const sy = c.y + wy * c.k;
      if (sy < 0 || sy > s.height - 12) continue;
      tick(left, sy, left + 6, sy);
      text(left + 3, sy + 12, String(row + 1));
    }
    g.replaceChildren(...nodes);
  };

  /** Puts the camera on the world: the transform goes straight onto the <g>, and the minimap's view box follows. */
  const applyCamera = (c: Camera) => {
    cameraRef.current = c;
    const world = worldRef.current;
    if (world) {
      world.setAttribute("transform", `translate(${c.x} ${c.y}) scale(${c.k})`);
      world.style.setProperty("--zinv", String(1 / c.k));
    }
    const v = visibleWorld(c, sizeOf());
    const mv = miniViewRef.current;
    if (mv) {
      mv.setAttribute("x", String(v.x));
      mv.setAttribute("y", String(v.y));
      mv.setAttribute("width", String(v.w));
      mv.setAttribute("height", String(v.h));
    }
    cull(c);
    drawRulers(c);
  };

  /** Writes the focus into the URL without a history entry, then tells the router the hash changed. */
  const syncUrl = (b: MapBuild, focus: string) => {
    const target = source.url(b, focus);
    if (target === undefined) return;
    const href = hrefView(id, "flow", target);
    if (window.location.hash === href) return;
    window.history.replaceState(window.history.state, "", href);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  };

  /**
   * Draws the map for the selection's build: the boxes are placed for it, and the pointer looks at them. The camera is
   * not touched here.
   */
  const showView = (v: MapBuild) => {
    viewRef.current = v;
    boxesRef.current = v.placed.items.map((i) => ({ id: i.id, x: i.rect.x, y: i.rect.y, w: i.rect.w, h: i.rect.h }));
    setView(v);
    cull(cameraRef.current);
  };

  /** The camera that fits the build's node in the stage's room (a function with a chart is capped, see fitChartCamera). */
  const fitTarget = (b: MapBuild, list: readonly Expansion[] = []): Camera | undefined => {
    const focus = b.placed.rects.get(b.nodeId);
    if (!focus || !svgRef.current || !zoomRef.current) return undefined;
    const room = roomOf();
    // The focus and its open expansions are fitted together, so an opened detail is framed with its card.
    const rect = unionWith(focus, list);
    const opens = b.placed.items.some((i) => i.id === b.nodeId && i.kind === "frame");
    // A roots-only grid fits at 1x when it fits: the cards are never enlarged past their size.
    let c = opens || b.node(b.nodeId)?.chart !== undefined ? fitChartCamera(rect, room, CHART_MIN_PX) : fitCamera(rect, room, flat ? { maxK: 1 } : {});
    // The whole project too small to read: the first program (the Browser one, listed first) fills the stage instead, and
    // the rest of the map is panned to.
    if (b.node(b.nodeId)?.kind === "project" && c.k < READABLE_FIT_K) {
      const first = b.placed.items.find((i) => i.kind === "frame" && b.node(i.id)?.kind === "program");
      const prect = first !== undefined ? b.placed.rects.get(first.id) : undefined;
      if (prect !== undefined) c = fitCamera(prect, room, { minK: READABLE_FIT_K });
    }
    const placed = { ...c, x: c.x + leftRef.current, y: c.y + TOP_RESERVE };
    // No empty band above the scene: the scene's top edge lands at the reserve, unless that would push the focus's bottom
    // above the room's top edge.
    let sceneTop = Infinity;
    for (const r of b.placed.rects.values()) sceneTop = Math.min(sceneTop, r.y);
    if (!Number.isFinite(sceneTop)) return placed;
    const clamped = clampTop(placed, sceneTop, TOP_RESERVE + 8);
    return clamped.y + (focus.y + focus.h) * clamped.k >= TOP_RESERVE ? clamped : placed;
  };

  /**
   * On a phone with the bottom sheet open, the camera fits the focus and every open detail into the room above the sheet,
   * scaling them down as needed. Undefined otherwise: the focus alone is fitted, as on a desktop.
   */
  const fitDetails = (b: MapBuild, list: readonly Expansion[]): Camera | undefined => {
    if (bottomRef.current <= 0 || list.length === 0) return undefined;
    const rect = b.placed.rects.get(b.nodeId);
    if (!rect) return undefined;
    const all = unionWith(rect, list);
    // The scale stays at the mid tier's floor, so the boxes stay out of the far tier while the details scale down.
    const boxH = medianOf(b.placed.items.filter((i) => i.kind === "box").map((i) => i.rect.h));
    const c = fitCamera(all, roomOf(), { minK: boxH > 0 ? MID_TILE_PX / boxH : undefined });
    return { ...c, x: c.x + leftRef.current, y: c.y + TOP_RESERVE };
  };

  /** Moves the camera to `target`. `animate` is false for a move that must not animate (a resize, the first view). */
  const moveTo = (target: Camera, animate: boolean) => {
    cam.to(target, !animate);
  };

  /** The camera that shows an expansion from `from`, the least it can move (see revealCamera). */
  const revealOf = (from: Camera, e: Expansion, minPx = CHART_MIN_PX): Camera => {
    // The reveal works in the room's own coordinates (from the left and top insets), so the insets are taken off and put back.
    const left = leftRef.current;
    const c = revealCamera({ ...from, x: from.x - left, y: from.y - TOP_RESERVE }, { x: e.x, y: e.y, w: e.w, h: e.h }, e.chart.width, roomOf(), minPx);
    return { ...c, x: c.x + left, y: c.y + TOP_RESERVE };
  };

  /** The expansions as the build places them: the boxes they hang from, in the build's layout, placed on the current view. */
  const placeAll = (b: MapBuild, list: readonly Expansion[]): Expansion[] => refresh(list, (nodeId) => b.placed.rects.get(nodeId), placeView(b));

  /** The view an expansion is placed on: the visible world, except on a slotted build, where the layout keeps the room. */
  const placeView = (b: MapBuild) => (b.slotted ? undefined : visibleWorld(cameraRef.current, sizeOf()));

  /** A function's chart, or undefined when it has none to draw (no chart source, no such function, too large, empty). */
  const loadChart = async (fnId: string): Promise<FunctionFlow | undefined> => {
    if (charts === undefined) return undefined;
    try {
      const f = await charts.store.chartOf(fnId);
      return f === undefined || f.tooLarge || f.nodes.length === 0 ? undefined : f;
    } catch {
      return undefined;
    }
  };

  /**
   * Makes `focus` the selection: loads what it needs, builds the map for it, and draws its expansions. A function focus
   * opens its expansion beside its box (`toggle` is false), or closes it when `toggle` is true and it is open. The camera
   * fits the focus, unless a toggle left it alone, then shows the expansion it opened or closed.
   */
  const show = async (focus: string, animate: boolean, writeUrl: boolean, toggle = false, select = false) => {
    const seq = ++seqRef.current;
    let b: MapBuild;
    try {
      // A focus reached by a click may not be loaded yet: the source loads what it needs first.
      await source.ensureFocus(focus);
      b = await source.build(focus);
    } catch (e) {
      if (seq === seqRef.current) setError(messageOf(e));
      return;
    }
    if (seq !== seqRef.current) return;
    buildRef.current = b;
    focusRef.current = focus;
    setBuild(b);
    // A focus the map shows is an on-map selection, so an off-map one gives way to it.
    setOffMap(undefined);
    setError(undefined);
    showView(b);

    // A selection alone moves the source panel and the URL. The expansions stay open, placed on this build, and the camera
    // does not move. The construct picked in a chart is kept: the panel shows it only for its own function.
    if (select) {
      setExp(placeAll(b, expRef.current));
      if (writeUrl) syncUrl(b, focus);
      return;
    }
    setConstruct(undefined);

    const node = b.node(b.nodeId);
    const boxRect = b.placed.rects.get(b.nodeId);
    const ref = node?.ref;
    const holds = ref !== undefined && node?.chart !== undefined && boxRect !== undefined && charts !== undefined;
    const openBefore = expRef.current.length;
    let list = placeAll(b, expRef.current);
    if (holds) {
      const anchored = anchoredTo(list, b.nodeId);
      if (toggle && anchored !== undefined) {
        list = closeExpansion(list, anchored.fnId);
      } else {
        const chart = await loadChart(ref);
        if (seq !== seqRef.current) return;
        if (chart !== undefined) {
          list = placeAll(b, expRef.current);
          list = openExpansion(list, ref, { kind: "box", nodeId: b.nodeId, rect: boxRect }, chart, placeView(b));
        }
      }
    }
    setExp(list);
    if (writeUrl) syncUrl(b, focus);

    // A toggle keeps the camera where it is; any other focus fits. Opening or closing a detail never moves the camera on a
    // desktop. On a phone, a detail that opens is fitted with the sheet over the map: the one move that is allowed there.
    const fit = !(toggle && holds) || (bottomRef.current > 0 && list.length > openBefore);
    if (fit) {
      const target = fitDetails(b, list) ?? fitTarget(b, list);
      if (target !== undefined) moveTo(target, animate);
    } else if (list.length > openBefore) {
      // A detail opened off the stage's edge is panned into view; a camera that already shows it does not move.
      const newest = list[list.length - 1];
      if (newest !== undefined) moveTo(revealOf(cameraRef.current, newest, 0), true);
    }
  };

  /** Opens the node a click, key or link names: the source turns the node into its focus, then the map shows it. */
  /** A click on a "+N more" card shows the rest of its thread's cards in place. Undefined when `nodeId` is another box. */
  const expandMore = (nodeId: string): boolean => {
    const b = buildRef.current;
    if (!b || !source.expandMore || !nodeId.endsWith(MORE_SUFFIX)) return false;
    void source.expandMore(b, nodeId).then(() => show(b.focus, false, true));
    return true;
  };

  const openNode = (nodeId: string) => {
    const b = buildRef.current;
    if (expandMore(nodeId)) return;
    // The keys go to the map after a click: the chart's link that had the focus is removed by the re-render, and the
    // focus would fall to the page, so the stage takes it here.
    stageRef.current?.focus({ preventScroll: true });
    // A function with a chart toggles its detail, as a click does, so the camera stays put.
    if (b) void show(source.focusOf?.(b, nodeId) ?? nodeId, true, true, b.node(nodeId)?.chart !== undefined);
  };

  /** A click on a box. A function with a chart toggles its expansion; any other box opens as a link does. */
  const boxClick = (nodeId: string) => {
    const b = buildRef.current;
    if (expandMore(nodeId)) return;
    stageRef.current?.focus({ preventScroll: true });
    if (!b) return;
    const toggle = b.node(nodeId)?.chart !== undefined;
    void show(source.focusOf?.(b, nodeId) ?? nodeId, true, true, toggle);
  };

  /**
   * Opens the expansion of a call step's callee to the right of the step, and shows it. The step's rect is in the parent
   * expansion's chart units. Nothing else moves: the focus stays where it is.
   */
  const openStep = async (fnId: string, node: FlowNode, callee: string) => {
    const b = buildRef.current;
    if (!b || !expRef.current.some((e) => e.fnId === fnId)) return;
    const chart = await loadChart(callee);
    if (chart === undefined) return;
    // The step's callee replaces what is right of its function: the calls it had open are closed, except this one.
    let list = placeAll(b, expRef.current);
    for (const e of list) {
      if (e.anchor.kind === "step" && e.anchor.fnId === fnId && e.fnId !== callee) list = closeExpansion(list, e.fnId);
    }
    const anchor: ExpandAnchor = { kind: "step", fnId, rect: { x: node.x, y: node.y, w: node.w, h: node.h } };
    const next = openExpansion(list, callee, anchor, chart, placeView(b));
    if (next === list) return;
    setExp(next);
    // The new detail is panned into view when it is off the stage (the camera zooms only for a detail too narrow to read).
    const opened = next.find((e) => e.fnId === callee);
    if (opened !== undefined) moveTo(revealOf(cameraRef.current, opened, 0), true);
    // The code pane follows the chain: the callee is the last function clicked.
    if (opened !== undefined) void selectFunction(callee);
  };

  /**
   * Selects a function of the build: the source panel shows it, and the camera and the open expansions stay where they
   * are. A function the scope draws is selected on the map, and the URL shows it. A function with no box (a callee outside
   * the scope, or hidden by the roots-only view) is selected off the map: the panel takes its name and file from its
   * chart. The URL is not written for it, since a `fn` the map does not draw would re-resolve and move the map; it keeps
   * the last on-map focus.
   */
  const selectFunction = async (fnId: string) => {
    const b = buildRef.current;
    if (!b) return;
    const node = source.placeFunction?.(b, fnId);
    if (node !== undefined) {
      if (node === b.nodeId && offMapRef.current === undefined) return;
      void show(source.focusOf?.(b, node) ?? node, false, true, false, true);
      return;
    }
    if (charts === undefined) return;
    const seq = ++seqRef.current;
    let fn: FunctionFlow | undefined;
    try {
      fn = await charts.store.chartOf(fnId);
    } catch {
      return;
    }
    // A newer selection or focus that started meanwhile wins.
    if (seq !== seqRef.current || buildRef.current !== b || fn === undefined) return;
    setOffMap({ build: b, selected: offMapSelected(fnId, fn) });
  };

  /**
   * A click on a step of an expansion's chart. A call to a function opens that function's expansion beside the step, and
   * selects the callee. Any other step becomes the construct the source panel highlights, and selects the expansion's
   * function. A step never navigates.
   */
  const chartStep = (fnId: string, node: FlowNode): boolean => {
    stageRef.current?.focus({ preventScroll: true });
    const b = buildRef.current;
    const callee = node.target !== undefined && node.target !== fnId ? node.target : undefined;
    // A handler (`ctx.onmessage = (e) => …`) is how a worker processes its messages: it opens, even as a folded lambda.
    if (callee !== undefined && node.handler !== true && isLambdaCall(b, fnId, callee)) void highlightLambda(fnId, node, callee);
    else if (callee !== undefined) void openStep(fnId, node, callee);
    else {
      setConstruct({ ref: fnId, nodeId: node.id, ...(node.span ? { span: node.span } : {}) });
      void selectFunction(fnId);
    }
    return true;
  };

  /**
   * A call to a lambda: a closure written inside the calling function (`findMate.consider`), or a lambda the model folded
   * into its owner (not a function of the model). Such a call opens no box.
   */
  const isLambdaCall = (b: MapBuild | undefined, fnId: string, callee: string): boolean =>
    callee.startsWith(`${fnId}.`) || (b !== undefined && source.isFunction?.(b, callee) === false);

  /**
   * Highlights a lambda's block in the calling function's source: the lambda's own span when its chart is known, else the
   * call. The code pane shows the calling function, with the block lit.
   */
  const highlightLambda = async (fnId: string, node: FlowNode, callee: string) => {
    let span = node.span;
    try {
      const f = await charts?.store.chartOf(callee);
      if (f?.span !== undefined) span = f.span;
    } catch {
      // The call's own span stays.
    }
    setConstruct({ ref: fnId, nodeId: node.id, ...(span ? { span } : {}) });
    void selectFunction(fnId);
  };

  /**
   * Shows a call chain's first function (its box, with its chart open), then the chain's charts. When every call of the
   * chain is a step in its caller's chart, each call opens in turn, to the right of its step (openStep). Otherwise the
   * chain is reached through references, which have no step: the chain's last function opens beside the box the chain
   * starts at, in place of the box's own chart, and it is selected.
   */
  const showChain = async (focus: string, chain: readonly string[]) => {
    await show(focus, false, false);
    const b = buildRef.current;
    const root = chain[0];
    const last = chain[chain.length - 1];
    if (!b || root === undefined || last === undefined || chain.length < 2) return;
    const steps: { parent: string; callee: string; node: FlowNode }[] = [];
    for (let i = 0; i + 1 < chain.length; i++) {
      const parent = chain[i];
      const callee = chain[i + 1];
      if (parent === undefined || callee === undefined) break;
      const node = (await loadChart(parent))?.nodes.find((n) => n.target === callee);
      if (node === undefined) break;
      steps.push({ parent, callee, node });
    }
    if (steps.length === chain.length - 1) {
      for (const s of steps) await openStep(s.parent, s.node, s.callee);
      return;
    }
    const rect = b.placed.rects.get(b.nodeId);
    const chart = await loadChart(last);
    if (rect === undefined || chart === undefined) {
      void selectFunction(last);
      return;
    }
    const list = openExpansion(closeExpansion(placeAll(b, expRef.current), root), last, { kind: "box", nodeId: b.nodeId, rect }, chart, placeView(b));
    setExp(list);
    const opened = list.find((e) => e.fnId === last);
    if (opened !== undefined) moveTo(revealOf(cameraRef.current, opened, 0), true);
    void selectFunction(last);
  };

  /** A key's zoom: about the middle of the stage, as d3's scaleBy does. */
  const zoomStep = (factor: number) => {
    const svg = svgRef.current;
    const z = zoomRef.current;
    if (!svg || !z) return;
    const c = cameraRef.current;
    const k = Math.min(SCALE[1], Math.max(SCALE[0], c.k * factor));
    const ratio = k / c.k;
    const cx = svg.clientWidth / 2;
    const cy = svg.clientHeight / 2;
    cam.to({ k, x: cx - (cx - c.x) * ratio, y: cy - (cy - c.y) * ratio }, false);
  };

  const panStep = (dx: number, dy: number) => {
    const z = zoomRef.current;
    if (!z) return;
    const c = cameraRef.current;
    cam.to({ k: c.k, x: c.x + dx, y: c.y + dy }, false);
  };

  /** Moves the view so the point under the pointer is the middle of the stage. The minimap maps pixels to the world. */
  const miniPan = (e: PointerEv<SVGSVGElement>) => {
    const b = buildRef.current;
    const svg = svgRef.current;
    const z = zoomRef.current;
    if (!b || !svg || !z) return;
    const r = e.currentTarget.getBoundingClientRect();
    const W = Math.max(1, b.placed.width);
    const H = Math.max(1, b.placed.height);
    const s = Math.max(W / r.width, H / r.height);
    const wx = (e.clientX - r.left - (r.width - W / s) / 2) * s;
    const wy = (e.clientY - r.top - (r.height - H / s) / 2) * s;
    const c = cameraRef.current;
    const size = sizeOf();
    cam.stop();
    select(svg).call(z.transform, zoomIdentity.translate(size.width / 2 - wx * c.k, size.height / 2 - wy * c.k).scale(c.k));
  };

  // The side shift is written after each render, so the items React just drew take the shift they should have now.
  useLayoutEffect(() => {
    const root = worldRef.current;
    if (root) writeShift(root, shiftRef.current);
  });

  // The camera. Wheel and drag are d3-zoom's, and only move the camera.
  useEffect(() => {
    const svg = svgRef.current;
    const stage = stageRef.current;
    if (!svg || !stage) return;
    buildRef.current = undefined;
    viewRef.current = undefined;
    focusRef.current = undefined;
    setExp([]);
    setConstruct(undefined);
    setOffMap(undefined);
    // The pointer samples of the drag in progress: a release carries the drag's speed as a fling.
    let samples: DragSample[] = [];
    const z = zoom<SVGSVGElement, unknown>()
      .scaleExtent(SCALE)
      .on("start", (ev: D3ZoomEvent<SVGSVGElement, unknown>) => {
        // A user's gesture takes the camera back from a move in flight, where it is.
        if (ev.sourceEvent) {
          cam.stop();
          samples = [];
        }
      })
      .on("zoom", (ev: D3ZoomEvent<SVGSVGElement, unknown>) => {
        applyCamera(toCamera(ev.transform));
        if (isPointerGesture(ev.sourceEvent)) samples.push({ t: performance.now(), x: ev.transform.x, y: ev.transform.y });
      })
      .on("end", (ev: D3ZoomEvent<SVGSVGElement, unknown>) => {
        if (!isPointerGesture(ev.sourceEvent)) return;
        const v = releaseVelocity(samples, performance.now());
        samples = [];
        cam.fling(v.vx, v.vy);
      });
    zoomRef.current = z;
    const sel = select(svg).call(z);
    // A resize that changes the stage's size refits a selected focus, so the panel opening or a window change keeps it
    // in view above the minimap. Culling alone is not enough for that.
    lastSizeRef.current = sizeOf();
    refitRef.current = (force = false) => {
      const size = sizeOf();
      const last = lastSizeRef.current;
      lastSizeRef.current = size;
      setStageSize({ width: size.width, height: size.height });
      cull(cameraRef.current);
      const b = buildRef.current;
      const changed = last !== undefined && (last.width !== size.width || last.height !== size.height);
      if (b?.selected !== undefined && (force || changed)) {
        // The refit keeps the newest expansion in view too: the source panel opening narrows the stage under it.
        const newest = expRef.current[expRef.current.length - 1];
        const fit = fitDetails(b, expRef.current) ?? fitTarget(b, expRef.current);
        const target = fit === undefined ? undefined : newest === undefined || bottomRef.current > 0 ? fit : revealOf(fit, newest);
        // A forced fit (a sheet opening) glides; a resize cuts, as it always has.
        if (target !== undefined) moveTo(target, force);
      }
    };
    const ro = new ResizeObserver(() => refitRef.current?.());
    ro.observe(stage);
    return () => {
      refitRef.current = undefined;
      ro.disconnect();
      sel.on(".zoom", null);
      zoomRef.current = undefined;
      seqRef.current += 1;
    };
    // The handlers read only refs and the source, so the ones from this render stay correct for the life of the effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, id]);

  // A panel opening or closing over the stage changes the usable width without resizing it: refit as a resize would.
  useEffect(() => {
    insetRef.current = inset;
    refitRef.current?.();
  }, [inset]);

  // A bottom sheet opening fits the selection above it, once. Closing it leaves the camera where the reader put it.
  useEffect(() => {
    const grew = bottomInset > bottomRef.current;
    bottomRef.current = bottomInset;
    if (grew) refitRef.current?.(true);
  }, [bottomInset]);

  // The Layers panel opening or closing over the stage's left edge refits the same way.
  useEffect(() => {
    leftRef.current = leftInset;
    refitRef.current?.();
  }, [leftInset]);

  // The URL drives the focus. A change this map made itself is already the focus, so it is skipped.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // A URL this map wrote for its focus names that focus. Several nodes can share a URL (an exec helper drawn in two
      // threads, or a thread, which writes only its scope), so the URL is not resolved again.
      const b = buildRef.current;
      const here = b && focusRef.current !== undefined ? source.url(b, focusRef.current) : undefined;
      if (here !== undefined && here.scope === scope && here.fn === fn) return;
      // A function the scope draws no box for (a callee hidden by the roots-only view) opens the chain of calls that reaches it.
      const chained = fn === undefined ? undefined : await source.chainTo?.(scope, fn);
      if (cancelled) return;
      if (chained !== undefined && fn !== undefined) {
        await showChain(chained.focus, chained.chain);
        return;
      }
      const next = await source.resolve(scope, fn);
      if (cancelled) return;
      if (next === focusRef.current && buildRef.current !== undefined) return;
      await show(next, buildRef.current !== undefined, false);
    })().catch((e: unknown) => {
      if (!cancelled) setError(messageOf(e));
    });
    return () => {
      cancelled = true;
    };
    // show and showChain read only the source, refs and the expansions, so they need no dependency of their own.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, scope, fn]);

  // A new view may arrive while the camera stays put. Its minimap view box and world transform are set here.
  useEffect(() => {
    if (view) applyCamera(cameraRef.current);
    // applyCamera reads the refs only, so it runs once per view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  // The page's source panel follows the selected function, and the construct picked in its chart while it is selected. An
  // off-map selection is reported in preference to the build's own.
  useEffect(() => {
    onFocus?.(build);
    // onFocus is a page's state setter, so it is only called when the build changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [build]);

  useEffect(() => {
    if (!onSelect) return;
    if (offMap !== undefined) {
      const span = construct !== undefined && construct.ref === offMap.selected.ref ? construct.span : undefined;
      onSelect({ build: offMap.build, selected: offMap.selected, ...(span !== undefined ? { construct: span } : {}) });
      return;
    }
    if (build?.selected === undefined) {
      onSelect(undefined);
      return;
    }
    const span = construct !== undefined && construct.ref === build.selected.ref ? construct.span : undefined;
    onSelect({ build, selected: build.selected, ...(span !== undefined ? { construct: span } : {}) });
    // onSelect is the page's state setter: only the selection and the construct change what it receives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [build, construct, offMap]);

  const onKey = (e: KeyEvent<HTMLDivElement>) => {
    const b = buildRef.current;
    // Escape that the map acts on stops here, so a page-level Escape (the side panel's) does not close as well.
    if (e.key === "Escape" && b && (expRef.current.length > 0 || b.node(b.nodeId)?.parent !== undefined)) e.preventDefault();
    switch (e.key) {
      case "+":
      case "=":
        zoomStep(1.5);
        break;
      case "-":
      case "_":
        zoomStep(1 / 1.5);
        break;
      case "ArrowLeft":
        panStep(PAN_PX, 0);
        break;
      case "ArrowRight":
        panStep(-PAN_PX, 0);
        break;
      case "ArrowUp":
        panStep(0, PAN_PX);
        break;
      case "ArrowDown":
        panStep(0, -PAN_PX);
        break;
      case "Escape": {
        if (!b) break;
        const list = expRef.current;
        const last = list[list.length - 1];
        const parent = b.node(b.nodeId)?.parent;
        if (last === undefined) {
          // Nothing is expanded: Escape goes up one level.
          if (parent !== undefined) void show(source.focusOf?.(b, parent) ?? parent, true, true);
          break;
        }
        // Escape closes the last expansion (and any chained from it). When it hangs from the selected box, the selection
        // moves to the box's parent; a container selects nothing, so the source panel closes with it. When the selected
        // function is the callee of a chained expansion, the selection returns to the expansion it hangs from.
        const selectedRef = offMapRef.current?.selected.ref ?? b.node(b.nodeId)?.ref;
        setExp(closeExpansion(list, last.fnId));
        if (last.anchor.kind === "box" && last.anchor.nodeId === b.nodeId && parent !== undefined) {
          void show(source.focusOf?.(b, parent) ?? parent, true, true);
        } else if (last.anchor.kind === "step" && selectedRef === last.fnId) {
          void selectFunction(last.anchor.fnId);
        }
        break;
      }
      case "Enter": {
        const v = viewRef.current;
        if (!b || !v) break;
        const c = cameraRef.current;
        const v2 = visibleWorld(c, sizeOf());
        const at = { x: v2.x + v2.w / 2, y: v2.y + v2.h / 2 };
        const under = pickBox(boxesRef.current, (id) => v.depth(id), at.x, at.y, c.k);
        if (under !== undefined && under !== b.nodeId) openNode(under);
        break;
      }
      default:
        return;
    }
    e.preventDefault();
  };

  const miniItems = useMemo(() => (view ? view.placed.items : []), [view]);
  /** The sheet's zone grid lines over the map's extent. Built once per view. */
  const zonePath = useMemo(() => (view ? zoneLines({ x: 0, y: 0, w: view.placed.width, h: view.placed.height }) : ""), [view]);
  /** The median height of a drawn function tile, in world units: the far tier is decided from it. */
  const tileH = useMemo(() => (view ? medianOf(view.placed.items.filter((i) => i.kind === "box").map((i) => i.rect.h)) : 0), [view]);
  /** The line type of every drawn node, from its own kind and the container it sits in. Built once per view. */
  const lines = useMemo(() => (view ? lineMap(view) : new Map<string, RuntimeLine>()), [view]);
  // The items and edges drawn are only those of the current view, so a stale set never shows.
  const live = view !== undefined && shown.view === view ? shown : undefined;

  // A box or frame that the layout moved (a reflow after an open or a close) slides from its old place: it is drawn back at
  // the old place, then transitions to the new one on the map's curve. Reduced motion cuts it.
  const flipRef = useRef(new Map<string, { x: number; y: number }>());
  useLayoutEffect(() => {
    const world = worldRef.current;
    const prev = flipRef.current;
    const next = new Map<string, { x: number; y: number }>();
    for (const it of live?.items ?? []) {
      if (it.kind !== "box" && it.kind !== "frame") continue;
      next.set(it.id, { x: it.rect.x, y: it.rect.y });
      const p = prev.get(it.id);
      if (p === undefined || !world || reduceMotion()) continue;
      const dx = p.x - it.rect.x;
      const dy = p.y - it.rect.y;
      if (dx === 0 && dy === 0) continue;
      const el = world.querySelector<SVGGElement>(`[data-fid="${CSS.escape(it.id)}"]`);
      if (!el) continue;
      el.style.transition = "none";
      el.style.transform = `translate(${dx}px, ${dy}px)`;
      void el.getBoundingClientRect();
      el.style.transition = `transform ${TWEEN_MS}ms ease`;
      el.style.transform = "";
    }
    flipRef.current = next;
  }, [live]);
  const drawn = (kind: PlacedItem["kind"]) => (live ? live.items.filter((i) => i.kind === kind) : []);
  /** A root card's entrance rank: its place in reading order (rect y, then x), so the first cards on the map pop first. */
  const cardRank = useMemo(() => {
    const boxes = (live?.items ?? []).filter((i) => i.kind === "box").slice().sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
    return new Map(boxes.map((it, i) => [it.id, i] as const));
  }, [live]);
  /** The camera scale of the labels' bucket: labels are fitted to the boxes' width on screen at this scale. */
  const labelScale = bucketScale(shown.lod);
  /**
   * Far out (a function tile under FAR_TILE_PX on screen) the map draws one card per group of boxes instead of the boxes,
   * and one aggregated edge per pair of cards. Near, it draws the boxes and every edge, as before.
   */
  const tileScreen = tileH * labelScale;
  const far = tileScreen < FAR_TILE_PX;
  /** Between the tiers: the cards are drawn with their function tiles, bare (no labels). Near, the tiles carry labels. */
  const mid = !far && tileScreen < MID_TILE_PX;
  /** The group cards show (the far and the mid tier). */
  const cards = far || mid;
  const isCall = (e: MapEdge) => e.kind === undefined || e.kind === "call";
  const edgesShown = cards ? [] : (live?.edges ?? []).filter((e) => !isCall(e) || layers.calls);
  /**
   * The far tier's cards: the boxes grouped by their parent. A group that a drawn frame already stands for is left to the
   * frame. Built from the whole view (not the culled set), so the cards do not pop in while panning.
   */
  const cardModel = useMemo(() => {
    if (!view || !far) return undefined;
    const frameIds = new Set(view.placed.items.filter((i) => i.kind === "frame").map((i) => i.id));
    const boxItems = view.placed.items.filter((i) => i.kind === "box" && !frameIds.has(view.node(i.id)?.parent ?? ""));
    // The cards are the children of the scope: the shallowest folder level with at least three cards, down to files.
    const segsOf = (id: string): string[] | undefined => {
      const f = view.node(id)?.file;
      return f === undefined ? undefined : segmentsBelow(f, view.path);
    };
    const depth = pickCardDepth(boxItems.flatMap((i) => {
      const s = segsOf(i.id);
      return s !== undefined && s.length > 0 ? [s] : [];
    }));
    // A card's drill-in scope: the file's path down to the card's level.
    const scopeDepth = view.path === "" ? 0 : view.path.split("/").length;
    const cardOf = new Map<string, string>();
    const labels = new Map<string, string>();
    const paths = new Map<string, string>();
    const boxes = boxItems.map((i) => {
      const segs = segsOf(i.id);
      const file = view.node(i.id)?.file;
      let key: string;
      let label: string;
      if (file !== undefined && segs !== undefined && segs.length > 0) {
        key = cardKeyAt(segs, depth);
        label = key.slice(key.lastIndexOf("/") + 1);
        paths.set(key, file.split("/").slice(0, scopeDepth + key.split("/").length).join("/"));
      } else {
        // A function with no source file keeps its own parent's card (it does not open).
        const parent = view.node(i.id)?.parent ?? i.id;
        key = `#${parent}`;
        label = view.node(parent)?.label ?? parent;
      }
      cardOf.set(i.id, key);
      labels.set(key, label);
      return { id: i.id, rect: i.rect, group: key };
    });
    const groups = groupCards(boxes, 0);
    const byId = new Map(groups.map((c) => [c.id, c]));
    return { cards: groups, byId, cardOf, labels, paths };
  }, [view, far]);
  /** The far tier's cards: one per child of the scope, with its function count and the sum of its findings. */
  const farCards = useMemo<FarCard[]>(() => {
    if (!cardModel || !view) return [];
    return cardModel.cards.map((c) => {
      let found = 0;
      if (findings !== undefined) {
        for (const id of c.ids) {
          const ref = view.node(id)?.ref;
          if (ref !== undefined) found += findings.get(ref) ?? 0;
        }
      }
      return { id: c.id, label: cardModel.labels.get(c.id) ?? "", count: c.ids.length, findings: found, path: cardModel.paths.get(c.id) };
    });
  }, [cardModel, view, findings]);
  /** Calls between cards: one aggregated edge per pair, drawn by the far layer (all of the view's calls, not the culled set). */
  const farEdges = useMemo(() => {
    if (!cardModel || !view || !layers.calls) return [];
    return aggregateEdges(view.edges.filter(isCall), (id) => cardModel.cardOf.get(id)).filter(
      (e) => cardModel.byId.has(e.a) && cardModel.byId.has(e.b),
    );
  }, [cardModel, view, layers.calls]);
  /** The free part of the stage for the far cards: right of the Layers panel, below the header, above the minimap. */
  const farArea: Rect = {
    x: leftInset + 16,
    y: 76,
    w: Math.max(120, (stageSize?.width ?? 0) - leftInset - 32),
    h: Math.max(72, (stageSize?.height ?? 0) - 76 - ((stageSize?.width ?? 0) < NARROW_STAGE_PX ? MINI_RESERVE_NARROW : MINI_RESERVE)),
  };
  /** A click on a far card drills into that child: the URL's scope moves to it, which refits the map to it. */
  const openScope = (path: string) => {
    window.location.hash = hrefView(id, "flow", { scope: path });
  };
  /** A wheel over the far layer (where it cannot scroll) zooms the map: the camera listens on the svg. */
  const forwardWheel = (ev: WheelEvent) => {
    svgRef.current?.dispatchEvent(new WheelEvent("wheel", ev));
  };
  /** The functions with an expansion open, by id: their boxes are drawn as expanded. */
  const expandedFns = new Set(expansions.map((e) => e.fnId));
  // A chain box whose function is a dispatch target of its thread is an async box: it gets a dashed frame.
  const asyncFns = new Set(
    view === undefined
      ? []
      : expansions.filter((e) => {
          const root = rootBoxOf(expansions, e);
          return root !== undefined && source.asyncOf?.(view, e.fnId, root) === true;
        }).map((e) => e.fnId),
  );

  return (
    <div className="zm zm-exec">
      {build && expansions.length === 0 && (
        <nav className="zm-crumbs" aria-label="Breadcrumb">
          <ol>
            {build.crumbs.map((n, i, all) => {
              const label = n.label;
              if (i === all.length - 1) {
                return (
                  <li key={n.id}>
                    <strong aria-current="page">{label}</strong>
                  </li>
                );
              }
              return (
                <li key={n.id}>
                  <a
                    href={hrefView(id, "flow", source.url(build, source.focusOf?.(build, n.id) ?? n.id) ?? {})}
                    onClick={(e) => {
                      e.preventDefault();
                      openNode(n.id);
                    }}
                  >
                    {label}
                  </a>
                </li>
              );
            })}
          </ol>
        </nav>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div
        className="zm-stage"
        ref={stageRef}
        tabIndex={0}
        role="application"
        aria-label="Execution map of the scope"
        aria-describedby={hint ? hintId : undefined}
        onKeyDown={onKey}
      >
        <svg
          ref={svgRef}
          className="zm-svg"
          width="100%"
          height="100%"
          style={{ ["--card-fill" as string]: `url(#${arrowId}-card)`, ["--beam-fill" as string]: `url(#${arrowId}-beam)` }}
        >
          <defs>
            <marker
              id={arrowId}
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="10"
              markerHeight="10"
              markerUnits="userSpaceOnUse"
              orient="auto-start-reverse"
            >
              <path d="M0,0 L10,5 L0,10 z" className="zm-arrow" />
            </marker>
            <linearGradient id={`${arrowId}-card`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" className="zm-card-g0" />
              <stop offset="1" className="zm-card-g1" />
            </linearGradient>
            <linearGradient id={`${arrowId}-beam`} x1="0" y1="0" x2="1" y2="0">
              <stop offset="0" className="zm-beam-g0" />
              <stop offset="1" className="zm-beam-g1" />
            </linearGradient>
          </defs>
          <g ref={worldRef} className={far ? "zm-world zm-far" : mid ? "zm-world zm-mid" : "zm-world"}>
            {!flat && <ZoneGrid path={zonePath} />}
            {layers.frames &&
              drawn("frame").map((it) => (
                <FrameShape key={it.id} item={it} node={view?.node(it.id)} line={lines.get(it.id) ?? "none"} k={labelScale} onOpen={openNode} />
              ))}
            {edgesShown.map((e) => (
              <path
                key={edgeKey(e)}
                d={e.d}
                data-sd={e.d}
                className={edgeClass(e)}
                style={{ strokeWidth: edgeWidth(e) }}
                markerEnd={`url(#${arrowId})`}
              >
                <title>{edgeTitle(e)}</title>
              </path>
            ))}
            {!far &&
              drawn("box").map((it) => {
                const node = view?.node(it.id);
                if (node === undefined) return null;
              return (
                <BoxShape
                  key={it.id}
                  item={it}
                  node={node}
                  line={lines.get(it.id) ?? "none"}
                  k={labelScale}
                  onOpen={boxClick}
                  chartOpen={node.ref !== undefined && expandedFns.has(node.ref)}
                  bare={mid && it.rect.h * labelScale < TILE_LABEL_PX}
                  small={mid}
                  card={flat}
                  rank={cardRank.get(it.id) ?? 0}
                />
              );
            })}
            {findings !== undefined && !cards &&
              drawn("box").map((it) => {
                const node = view?.node(it.id);
                const count = node?.ref !== undefined ? findings.get(node.ref) : undefined;
                if (node?.ref === undefined || count === undefined) return null;
                const ref = node.ref;
                return <FindingShape key={`finding-${it.id}`} rect={it.rect} count={count} k={labelScale} onSelect={() => void selectFunction(ref)} />;
              })}
            {/* The callouts sit outside the detail groups and behind them: the side shift writes their edges (see writeShift), so they are not moved as a group. */}
            {expansions.map((e) => {
              const ends = endsOf(e, expansions);
              return ends === undefined ? null : <CalloutShape key={`conn-${e.fnId}`} ends={ends} reduced={reduceMotion()} />;
            })}
            {leaving.map((e) => {
              const ends = endsOf(e, [...expansions, ...leaving]);
              return ends === undefined ? null : <CalloutShape key={`leave-conn-${e.fnId}`} ends={ends} closing reduced={reduceMotion()} />;
            })}
            {expansions.map((e) => {
              return (
                <g key={`exp-${e.fnId}`} className="zm-expansion-group" data-sx={e.pivot}>
                  {/* The entrance plays on this wrapper, not the group: the group carries the side shift as its transform. */}
                  <g className="zm-expansion-motion">
                    {asyncFns.has(e.fnId) && <AsyncFrame expansion={e} k={labelScale} />}
                    <ExpansionShape
                      id={id}
                      scope={charts?.scope ?? scope}
                      expansion={e}
                      k={labelScale}
                      selectedId={construct !== undefined && construct.ref === e.fnId ? construct.nodeId : undefined}
                      onNodeClick={(n) => chartStep(e.fnId, n)}
                      onSelect={() => void selectFunction(e.fnId)}
                      onClose={() => setExp(closeExpansion(expRef.current, e.fnId))}
                      motion={motion}
                    />
                  </g>
                </g>
              );
            })}
            {leaving.map((e) => (
              <g key={`leave-${e.fnId}`} className="zm-expansion-group is-leaving" data-sx={e.pivot} aria-hidden="true">
                <g className="zm-expansion-motion">
                  <ExpansionShape id={id} scope={charts?.scope ?? scope} expansion={e} k={labelScale} selectedId={undefined} onNodeClick={() => false} onSelect={() => undefined} onClose={() => undefined} motion={false} />
                </g>
              </g>
            ))}
          </g>
        </svg>
        {stageSize !== undefined && (
          <FarCards
            cards={farCards}
            pairs={farEdges}
            area={farArea}
            shown={far && cardModel !== undefined}
            findingsOn={findings !== undefined}
            onOpen={openScope}
            onWheel={forwardWheel}
          />
        )}
        {!build && !error && <p className="zm-loading muted">Loading</p>}
        <svg ref={rulerRef} className={far ? "zm-rulers zm-rulers-off" : "zm-rulers"} width="100%" height="100%" aria-hidden="true" />
        {build && (
          <figure className={keyOpen ? "zm-keyplan" : "zm-keyplan is-closed"}>
          <button type="button" className="zm-keyplan-toggle" aria-expanded={keyOpen} onClick={() => setKeyOpen((o) => !o)}>
            Key plan
          </button>
          <svg
            ref={miniRef}
            className="zm-mini"
            viewBox={`0 0 ${Math.max(1, build.placed.width)} ${Math.max(1, build.placed.height)}`}
            role="img"
            aria-label="Minimap: click or drag to move the view"
            onPointerDown={(e) => {
              miniDragRef.current = true;
              e.currentTarget.setPointerCapture(e.pointerId);
              miniPan(e);
            }}
            onPointerMove={(e) => {
              if (miniDragRef.current) miniPan(e);
            }}
            onPointerUp={() => {
              miniDragRef.current = false;
            }}
            onPointerCancel={() => {
              miniDragRef.current = false;
            }}
          >
            {miniItems.map((it) => (
              <rect
                key={it.id}
                x={it.rect.x}
                y={it.rect.y}
                width={it.rect.w}
                height={it.rect.h}
                className={it.kind === "frame" ? "zm-mini-frame" : "zm-mini-box"}
              />
            ))}
            <rect ref={miniViewRef} className="zm-mini-view" />
          </svg>
          </figure>
        )}
      </div>
      {hint && (
        <p id={hintId} className="muted small zm-hint">
          Scroll or press + and - to zoom; zooming never opens a box. Arrow keys pan. Click a function to open its chart beside
          it, and a call step in the chart to open the callee beside the step. Click a step that is not a call to see its
          source. Enter opens the item at the centre. Escape closes the last chart opened.
        </p>
      )}
      {build && detail?.(build, openNode)}
    </div>
  );
}

/**
 * The dashed frame around an async chain box: SLOT_PAD outside the expansion, labelled "Async · <name>" at its top-left, on
 * the frame's top edge. It is drawn inside the expansion's group, so it moves with the expansion.
 */
function AsyncFrame({ expansion, k }: { expansion: Expansion; k: number }) {
  const { x, y, w, h, chart } = expansion;
  const label = fitLabel(`Async · ${chart.name}`, labelChars(w * k, 6.6, 12));
  return (
    <g className="zm-async" aria-hidden="true">
      <rect x={x - SLOT_PAD} y={y - SLOT_PAD} width={w + 2 * SLOT_PAD} height={h + 2 * SLOT_PAD} rx={22} className="zm-async-frame" />
      {label !== null && (
        <text x={x + 10} y={y - SLOT_PAD} dominantBaseline="central" className="zm-async-label">
          <title>{`Async · ${chart.name}`}</title>
          {label}
        </text>
      )}
    </g>
  );
}

/**
 * A frame's header and a box's label are cut to the room they have on screen at the label scale `k` (lod.ts). The full
 * text stays in the tooltip.
 */
export function FrameShape({
  item,
  node,
  line,
  k,
  onOpen,
}: {
  item: PlacedItem;
  node: MapNode | undefined;
  line: RuntimeLine;
  k: number;
  onOpen: (id: string) => void;
}) {
  const { rect } = item;
  const head = ZOOM_SIZE.head;
  const text = headerLabels(node?.label ?? nameOfId(item.id), node?.detail, rect.w * k);
  return (
    <g className={`zm-frame${node ? ` zm-${node.kind}` : ""} ${lineClass(line)}`} data-sx={rect.x} data-fid={item.id}>
      <title>{node?.title || (node ? (node.detail ? `${node.label} (${node.detail})` : node.label) : item.id)}</title>
      <rect x={rect.x} y={rect.y} width={rect.w} height={rect.h} rx={16} className="zm-frame-body" />
      <g className="zm-hit" onClick={() => onOpen(item.id)}>
        <rect x={rect.x} y={rect.y} width={rect.w} height={head} rx={16} className="zm-frame-head" />
        {text.label !== null && (
          <text x={rect.x + 12} y={rect.y + head / 2} dominantBaseline="central" className="zm-label">
            <tspan className="zm-frame-dot">●</tspan>{" "}{text.label}
          </text>
        )}
        {text.detail !== null && (
          <text x={rect.x + rect.w - 12} y={rect.y + head / 2} dominantBaseline="central" textAnchor="end" className="zm-count">
            {text.detail}
          </text>
        )}
      </g>
    </g>
  );
}

/**
 * A box keeps its name in the middle. A function with a chart is marked, and `expanded` while its chart is open beside it.
 */
function BoxShape({
  item,
  node,
  line,
  k,
  onOpen,
  chartOpen,
  bare = false,
  small = false,
  card = false,
  rank = 0,
}: {
  item: PlacedItem;
  node: MapNode;
  line: RuntimeLine;
  k: number;
  onOpen: (id: string) => void;
  chartOpen: boolean;
  /** Drawn as a tile only, with no label (a tile under TILE_LABEL_PX in the mid tier). */
  bare?: boolean;
  /** A mid-tier tile: its name in a small font, sized to the tile's height on screen. */
  small?: boolean;
  /** A roots-only card: its name, and its file line under it when the box is tall enough (see roots-grid.ts). */
  card?: boolean;
  /** The card's place in reading order, which sets its pop-in delay (see zoom/pop.ts). */
  rank?: number;
}) {
  const { rect } = item;
  // The function's display name on the map (the full name stays in the tooltip).
  const shown = displayName(node.label, node.ref);
  // The mid tier's name is 10-13 px on screen (the zoom's inverse scales it): its characters are measured at that size.
  const fontPx = small ? Math.min(13, Math.max(10, Math.round(rect.h * k * 0.42))) : 0;
  const label = bare ? null : small ? fitLabel(shown, labelChars(rect.w * k, fontPx * 0.6, 10)) : fitLabel(shown, labelChars(rect.w * k));
  const holdsChart = node.chart !== undefined;
  if (card && !small && !bare) {
    // A card: its name alone, centred vertically, fitted to the card's width on screen.
    // Two characters of the budget go to the leading function glyph (ƒ), so the name stays inside the card.
    const name = fitLabel(shown, Math.max(1, labelChars(rect.w * k, 8, 20) - 2));
    return (
      <g className={`zm-box zm-${node.kind} zm-card ${lineClass(line)}${holdsChart ? " zm-has-chart" : ""}${chartOpen ? " expanded" : ""}`} data-sx={rect.x} data-fid={item.id} onClick={() => onOpen(item.id)}>
        <title>{node.detail !== undefined ? `${node.label} (${node.detail})` : node.title || node.label}</title>
        {/* The pop-in sits on this inner group: the outer one carries the slide transform (writeShift and the FLIP). */}
        <g className="zm-pop" style={{ ["--d" as string]: `${popDelay(rank)}ms` }}>
          <rect x={rect.x} y={rect.y} width={rect.w} height={rect.h} rx={12} className="zm-box-body" />
          {name !== null && (
            <text x={rect.x + 12} y={rect.y + rect.h / 2} dominantBaseline="central" className="zm-label">
              <tspan className="zm-card-glyph">ƒ</tspan>{" "}{name}
            </text>
          )}
        </g>
      </g>
    );
  }
  return (
    <g
      className={`zm-box zm-${node.kind} ${lineClass(line)}${holdsChart ? " zm-has-chart" : ""}${chartOpen ? " expanded" : ""}${bare ? " zm-tile" : ""}`}
      data-sx={rect.x}
      onClick={() => onOpen(item.id)}
    >
      <title>{node.title || node.label}</title>
      <rect x={rect.x} y={rect.y} width={rect.w} height={rect.h} rx={10} className="zm-box-body" />
      {label !== null && (
        <text
          x={rect.x + (small ? 8 : 12)}
          y={rect.y + rect.h / 2}
          dominantBaseline="central"
          className="zm-label"
          style={small ? { fontSize: `calc(${fontPx}px * var(--zinv, 1))` } : undefined}
        >
          {label}
        </text>
      )}
    </g>
  );
}

/**
 * The line type of every node a view places, by id. A node's line comes from its kind, and a function from the container
 * it sits in, so the walk goes up through the parents. Each node is looked up once.
 */
function lineMap(b: MapBuild): Map<string, RuntimeLine> {
  const memo = new Map<string, RuntimeLine>();
  const lineOf = (id: string, depth: number): RuntimeLine => {
    const hit = memo.get(id);
    if (hit !== undefined) return hit;
    const node = b.node(id);
    // A parent chain is short (a function, its thread, its program); the depth guard keeps a bad parent from looping.
    const parent = node?.parent !== undefined && depth < 32 ? lineOf(node.parent, depth + 1) : "none";
    const line = node ? runtimeLine(node.kind, parent) : "none";
    memo.set(id, line);
    return line;
  };
  for (const it of b.placed.items) lineOf(it.id, 0);
  return memo;
}

/** The sheet's zone grid: the hairlines of the 480-unit zones. The references are the rulers on the stage's edges. */
function ZoneGrid({ path }: { path: string }) {
  return (
    <g className="zm-zones" aria-hidden="true">
      <path d={path} className="zm-zone-line" />
    </g>
  );
}

function Badge({ count }: { count: number }) {
  const text = badgeText(count);
  const r = MARKER_BADGE_R;
  const w = Math.max(2 * r, 6.2 * text.length + 8);
  return (
    <>
      <rect x={-w / 2} y={-r} width={w} height={2 * r} rx={r} />
      <text>{text}</text>
    </>
  );
}

/**
 * A revision cloud around a function with findings, with a red triangle on its top-left corner and the count in a badge on
 * its top-right corner. The marker's shape is in screen pixels (the scale `k` undoes the world zoom), so it keeps its size.
 */
function FindingShape({ rect, count, k, onSelect }: { rect: Rect; count: number; k: number; onSelect: () => void }) {
  const at = markerAnchors(rect);
  const s = 1 / k;
  const tip = MARKER_TRIANGLE.map(([x, y]) => `${x},${y}`).join(" ");
  return (
    <g className="zm-finding" data-sx={rect.x}>
      <title>{`${count} finding${count === 1 ? "" : "s"}`}</title>
      <path d={cloudPath(rect)} className="zm-cloud" />
      <g transform={`translate(${at.triangle.x} ${at.triangle.y}) scale(${s})`} className="zm-marker" onClick={onSelect}>
        <polygon points={tip} className="zm-marker-tri" />
      </g>
      <g transform={`translate(${at.badge.x} ${at.badge.y}) scale(${s})`} className="zm-badge" onClick={onSelect}>
        <Badge count={count} />
      </g>
    </g>
  );
}
