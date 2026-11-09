// The zoom map: one d3-zoom camera over a scene from a MapSource (the execution canvas of a scope). The camera only moves
// (wheel, drag, keys, minimap) and never opens or closes a box. A click, a key or a link opens a box, and the URL follows
// the focus. A function's control-flow chart is drawn only once the function is expanded: by a click on its box, by the
// URL's fn, or by a call to it from another chart. The camera transform is written straight onto a <g>; React re-renders
// only when the set of drawn items changes.
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as KeyEvent, type PointerEvent as PointerEv, type ReactNode } from "react";
import { select } from "d3-selection";
import "d3-transition";
import { zoom, zoomIdentity, type D3ZoomEvent, type ZoomBehavior, type ZoomTransform } from "d3-zoom";
import { CHART_HEAD, ZOOM_SIZE, fitCamera, fitChartCamera, visibleWorld, type Camera, type FlowNode, type FlowSpan, type PlacedItem, type Rect } from "@insight/flow";
import { nameOfId } from "../../flowTargets";
import { hrefView } from "../../router";
import { CHART_MIN_PX, chartShown } from "../../zoom/chart";
import { expandedAfter } from "../../zoom/expand";
import { pickBox } from "../../zoom/gesture";
import { edgeClass, edgeKey, edgeTitle, edgeWidth, type MapBuild, type MapEdge, type MapNode, type MapSelected, type MapSource } from "../../zoom/source";
import { bucketScale, fitLabel, headerLabels, labelChars, lodBucket } from "../../zoom/lod";
import type { ZoomStore } from "../../zoom/scene";
import { BoxChart } from "./BoxChart";

/** The camera's scale range: from the whole project down to a single line of a chart. */
const SCALE: [number, number] = [0.02, 16];
const ANIM_MS = 450;
/** Items this far (world units) outside the view are still drawn, so a pan does not show a blank edge. */
const CULL_MARGIN = 120;
const PAN_PX = 80;
/**
 * Room at the bottom of the stage that a fit leaves clear for the minimap: its height (110 px, see styles.css), its 10 px
 * inset and a 10 px margin. A selected function fits above it, so the minimap never covers the chart.
 */
const MINI_RESERVE = 130;

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

const toCamera = (t: ZoomTransform): Camera => ({ k: t.k, x: t.x, y: t.y });
const toTransform = (c: Camera): ZoomTransform => zoomIdentity.translate(c.x, c.y).scale(c.k);
const reduceMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** True when `id` is inside the box `box`: a node whose ancestor is `box`. */
const insideBox = (b: MapBuild, id: string, box: string): boolean => {
  for (let p = b.node(id)?.parent; p !== undefined; p = b.node(p)?.parent) if (p === box) return true;
  return false;
};

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
  /** Where a function box's control-flow chart is loaded from. Without it, function boxes show only their names. */
  charts?: ChartSource;
  /** Reports the function the map selects (undefined when the focus is not a function), with the construct picked in it. */
  onSelect?: (sel: MapSelection | undefined) => void;
}

/** What a box needs to draw its chart: the project, the scope its links resolve in, and the flow store. */
export interface ChartSource {
  id: string;
  scope: string;
  store: ZoomStore;
}

/**
 * The execution map: one camera over a scope's scene. Each node is a focus of the source; the map's items and edges
 * are named by node id, so a click or key that names a node is turned into a focus by the source first (`focusOf`).
 */
export function ZoomMap({ id, source, scope, fn, detail, charts, onSelect }: Props) {
  /** The selection: the focus the breadcrumb, the detail panel and the URL show. Only explicit actions change it. */
  const [build, setBuild] = useState<MapBuild>();
  /** The map as drawn: the selection's build. Only a click or a key changes it; gestures move the camera alone. */
  const [view, setView] = useState<MapBuild>();
  /** `lod` is the camera's quarter-octave bucket (lod.ts): labels are cut to it, and it changes only with the bucket. */
  const [shown, setShown] = useState<{ view?: MapBuild; items: PlacedItem[]; edges: MapEdge[]; lod: number }>({ items: [], edges: [], lod: 0 });
  const [error, setError] = useState<string>();
  /** The function boxes whose chart is drawn, by placement id. A click on a function box adds it; Escape removes it. */
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  /** The same set, for the handlers and the async `show`, which read it when they run. */
  const expandedRef = useRef<ReadonlySet<string>>(expanded);
  /** The construct picked in an expanded chart: the placement of that chart, the step, and its span. */
  const [construct, setConstruct] = useState<{ placement: string; nodeId: string; span?: FlowSpan }>();
  const stageRef = useRef<HTMLDivElement>(null);
  /** The stage's size at the last resize, so a resize that changes nothing does not refit the camera. */
  const lastSizeRef = useRef<{ width: number; height: number } | undefined>(undefined);
  const svgRef = useRef<SVGSVGElement>(null);
  const worldRef = useRef<SVGGElement>(null);
  const miniRef = useRef<SVGSVGElement>(null);
  const miniViewRef = useRef<SVGRectElement>(null);
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
  const arrowId = `zm-arrow-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const hintId = useId();

  const sizeOf = () => ({ width: stageRef.current?.clientWidth ?? 0, height: stageRef.current?.clientHeight ?? 0 });

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

  /**
   * Moves the camera to fit the build's node, in the stage's room above the minimap. `animate` is false for a refit that
   * follows a resize, which must not animate.
   */
  const fitFocus = (b: MapBuild, animate: boolean) => {
    const rect = b.placed.rects.get(b.nodeId);
    const svg = svgRef.current;
    const z = zoomRef.current;
    if (!rect || !svg || !z) return;
    const size = sizeOf();
    const room = { width: size.width, height: Math.max(1, size.height - MINI_RESERVE) };
    // A function with a chart, and a container that opens, is capped at about 1.5x its natural size, but never below
    // CHART_MIN_PX wide (fitChartCamera). Any other box fits as it is.
    const opens = b.placed.items.some((i) => i.id === b.nodeId && i.kind === "frame");
    const target = opens || b.node(b.nodeId)?.chart !== undefined ? fitChartCamera(rect, room, CHART_MIN_PX) : fitCamera(rect, room);
    if (animate && !reduceMotion()) select(svg).transition().duration(ANIM_MS).call(z.transform, toTransform(target));
    else select(svg).call(z.transform, toTransform(target));
  };

  /**
   * Makes `focus` the selection: loads what it needs, builds the map for it, and moves the camera to fit it. `animate`
   * is false only for the first view, which is set at once. `base` is the expanded set the focus starts from: a function
   * it selects is added to it, so nothing already open closes. A focus that is a function is drawn with its chart open.
   */
  const show = async (focus: string, animate: boolean, writeUrl: boolean, base: ReadonlySet<string> = expandedRef.current) => {
    const seq = ++seqRef.current;
    let b: MapBuild;
    try {
      // A focus reached by a click may not be loaded yet: the source loads what it needs first.
      await source.ensureFocus(focus);
      b = await source.build(focus, base);
    } catch (e) {
      if (seq === seqRef.current) setError(messageOf(e));
      return;
    }
    if (seq !== seqRef.current) return;
    buildRef.current = b;
    focusRef.current = focus;
    setBuild(b);
    setError(undefined);
    setConstruct(undefined);
    const exp = b.expanded ?? base;
    expandedRef.current = exp;
    setExpanded(exp);
    showView(b);
    fitFocus(b, animate);
    if (writeUrl) syncUrl(b, focus);
  };

  /** Opens the node a click, key or link names: the source turns the node into its focus, then the map shows it. */
  const openNode = (nodeId: string) => {
    const b = buildRef.current;
    // The keys go to the map after a click: the chart's link that had the focus is removed by the re-render, and the
    // focus would fall to the page, so the stage takes it here.
    stageRef.current?.focus({ preventScroll: true });
    if (b) void show(source.focusOf?.(b, nodeId) ?? nodeId, true, true);
  };

  /**
   * A click on a step of a function's chart. A call to a function in scope opens that function in place: it is expanded,
   * selected and fitted, and this one stays expanded. A step of a chart that is not the selection's selects its function.
   * Any other step becomes the construct the source panel highlights. A step never navigates.
   */
  const chartStep = (placement: string, node: FlowNode): boolean => {
    const b = buildRef.current;
    stageRef.current?.focus({ preventScroll: true });
    if (!b) return true;
    const own = b.node(placement)?.ref;
    const callee = node.target !== undefined && node.target !== own ? source.placeFunction?.(b, node.target) : undefined;
    if (callee !== undefined) openNode(callee);
    else if (placement !== b.nodeId) openNode(placement);
    else setConstruct({ placement, nodeId: node.id, ...(node.span ? { span: node.span } : {}) });
    return true;
  };

  const zoomStep = (factor: number) => {
    const svg = svgRef.current;
    const z = zoomRef.current;
    if (!svg || !z) return;
    select(svg).transition().duration(180).call(z.scaleBy, factor);
  };

  const panStep = (dx: number, dy: number) => {
    const svg = svgRef.current;
    const z = zoomRef.current;
    if (!svg || !z) return;
    select(svg).transition().duration(180).call(z.translateBy, dx, dy);
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
    select(svg).call(z.transform, zoomIdentity.translate(size.width / 2 - wx * c.k, size.height / 2 - wy * c.k).scale(c.k));
  };

  // The camera. Wheel and drag are d3-zoom's, and only move the camera.
  useEffect(() => {
    const svg = svgRef.current;
    const stage = stageRef.current;
    if (!svg || !stage) return;
    buildRef.current = undefined;
    viewRef.current = undefined;
    focusRef.current = undefined;
    expandedRef.current = new Set();
    setExpanded(expandedRef.current);
    setConstruct(undefined);
    const z = zoom<SVGSVGElement, unknown>()
      .scaleExtent(SCALE)
      .on("zoom", (ev: D3ZoomEvent<SVGSVGElement, unknown>) => applyCamera(toCamera(ev.transform)));
    zoomRef.current = z;
    const sel = select(svg).call(z);
    // A resize that changes the stage's size refits a selected focus, so the panel opening or a window change keeps it
    // in view above the minimap. Culling alone is not enough for that.
    lastSizeRef.current = sizeOf();
    const ro = new ResizeObserver(() => {
      const size = sizeOf();
      const last = lastSizeRef.current;
      lastSizeRef.current = size;
      cull(cameraRef.current);
      const b = buildRef.current;
      if (b?.selected !== undefined && last !== undefined && (last.width !== size.width || last.height !== size.height)) {
        fitFocus(b, false);
      }
    });
    ro.observe(stage);
    return () => {
      ro.disconnect();
      sel.on(".zoom", null);
      zoomRef.current = undefined;
      seqRef.current += 1;
    };
    // The handlers read only refs and the source, so the ones from this render stay correct for the life of the effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, id]);

  // The URL drives the focus. A change this map made itself is already the focus, so it is skipped.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // A URL this map wrote for its focus names that focus. Several nodes can share a URL (an exec helper drawn in two
      // threads, or a thread, which writes only its scope), so the URL is not resolved again.
      const b = buildRef.current;
      const here = b && focusRef.current !== undefined ? source.url(b, focusRef.current) : undefined;
      if (here !== undefined && here.scope === scope && here.fn === fn) return;
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
    // show reads only the source and refs, so it needs no dependency of its own.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, scope, fn]);

  // A new view may arrive while the camera stays put. Its minimap view box and world transform are set here.
  useEffect(() => {
    if (view) applyCamera(cameraRef.current);
    // applyCamera reads the refs only, so it runs once per view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  // The page's source panel follows the selected function, and the construct picked in its chart while it is selected.
  useEffect(() => {
    if (!onSelect) return;
    if (build?.selected === undefined) {
      onSelect(undefined);
      return;
    }
    const span = construct !== undefined && construct.placement === build.nodeId ? construct.span : undefined;
    onSelect({ build, selected: build.selected, ...(span !== undefined ? { construct: span } : {}) });
    // onSelect is the page's state setter: only the selection and the construct change what it receives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [build, construct]);

  const onKey = (e: KeyEvent<HTMLDivElement>) => {
    const b = buildRef.current;
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
        // Escape closes the selected function's chart and goes up one level. The parent is not a function, so its build
        // selects nothing and the source panel closes with it.
        if (!b) break;
        const parent = b.node(b.nodeId)?.parent;
        if (parent !== undefined) {
          const base = expandedAfter(expandedRef.current, "escape", b.nodeId, (id) => insideBox(b, id, b.nodeId));
          void show(source.focusOf?.(b, parent) ?? parent, true, true, base);
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
  // The items and edges drawn are only those of the current view, so a stale set never shows.
  const live = view !== undefined && shown.view === view ? shown : undefined;
  const drawn = (kind: PlacedItem["kind"]) => (live ? live.items.filter((i) => i.kind === kind) : []);
  /** The camera scale of the labels' bucket: labels are fitted to the boxes' width on screen at this scale. */
  const labelScale = bucketScale(shown.lod);

  return (
    <div className="zm zm-exec">
      {build && (
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
        aria-describedby={hintId}
        onKeyDown={onKey}
      >
        <svg ref={svgRef} className="zm-svg" width="100%" height="100%">
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
          </defs>
          <g ref={worldRef}>
            {drawn("frame").map((it) => (
              <FrameShape key={it.id} item={it} node={view?.node(it.id)} k={labelScale} onOpen={openNode} />
            ))}
            {live?.edges.map((e) => (
              <path
                key={edgeKey(e)}
                d={e.d}
                className={edgeClass(e)}
                style={{ strokeWidth: edgeWidth(e) }}
                markerEnd={`url(#${arrowId})`}
              >
                <title>{edgeTitle(e)}</title>
              </path>
            ))}
            {drawn("box").map((it) => {
              const node = view?.node(it.id);
              if (node === undefined) return null;
              return (
                <BoxShape
                  key={it.id}
                  item={it}
                  node={node}
                  k={labelScale}
                  onOpen={openNode}
                  charts={charts}
                  chartOpen={expanded.has(it.id)}
                  selectedId={construct !== undefined && construct.placement === it.id ? construct.nodeId : undefined}
                  onChartStep={(n) => chartStep(it.id, n)}
                />
              );
            })}
          </g>
        </svg>
        {!build && !error && <p className="zm-loading muted">Loading</p>}
        {build && (
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
        )}
      </div>
      <p id={hintId} className="muted small zm-hint">
        Scroll or press + and - to zoom; zooming never opens a box. Arrow keys pan. Click a box to open it, and a function to
        draw its chart. Click a step in the chart to see its source. Enter opens the item at the centre. Escape closes the
        selected function's chart and goes up one level.
      </p>
      {build && detail?.(build, openNode)}
    </div>
  );
}

/**
 * A frame's header and a box's label are cut to the room they have on screen at the label scale `k` (lod.ts). The full
 * text stays in the tooltip.
 */
function FrameShape({ item, node, k, onOpen }: { item: PlacedItem; node: MapNode | undefined; k: number; onOpen: (id: string) => void }) {
  const { rect } = item;
  const head = ZOOM_SIZE.head;
  const text = headerLabels(node?.label ?? nameOfId(item.id), node?.detail, rect.w * k);
  return (
    <g className={node ? `zm-frame zm-${node.kind}` : "zm-frame"}>
      <title>{node?.title || item.id}</title>
      <rect x={rect.x} y={rect.y} width={rect.w} height={rect.h} rx={10} className="zm-frame-body" />
      <g className="zm-hit" onClick={() => onOpen(item.id)}>
        <rect x={rect.x} y={rect.y} width={rect.w} height={head} rx={10} className="zm-frame-head" />
        {text.label !== null && (
          <text x={rect.x + 12} y={rect.y + head / 2} dominantBaseline="central" className="zm-label">
            {text.label}
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
 * A box with a chart (a function that has a control-flow chart) keeps its name in a header and draws the chart below it
 * once the box is expanded and CHART_MIN_PX wide on screen. Any other box has its name in the middle.
 */
function BoxShape({
  item,
  node,
  k,
  onOpen,
  charts,
  chartOpen,
  selectedId,
  onChartStep,
}: {
  item: PlacedItem;
  node: MapNode;
  k: number;
  onOpen: (id: string) => void;
  charts?: ChartSource;
  chartOpen: boolean;
  selectedId?: string;
  onChartStep: (node: FlowNode) => boolean;
}) {
  const { rect } = item;
  const label = fitLabel(node.label, labelChars(rect.w * k));
  const holdsChart = node.chart !== undefined;
  const showChart = chartShown({ holdsChart, hasCharts: charts !== undefined, hasRef: node.ref !== undefined, expanded: chartOpen, widthPx: rect.w * k });
  // A collapsed chart box is just its name, centred; an expanded one keeps the name in the header above its chart.
  const headed = holdsChart && chartOpen;
  return (
    <g className={`zm-box zm-${node.kind}${holdsChart ? " zm-has-chart" : ""}`} onClick={() => onOpen(item.id)}>
      <title>{node.title || node.label}</title>
      <rect x={rect.x} y={rect.y} width={rect.w} height={rect.h} rx={8} className="zm-box-body" />
      {label !== null && (
        <text x={rect.x + 12} y={headed ? rect.y + CHART_HEAD / 2 : rect.y + rect.h / 2} dominantBaseline="central" className="zm-label">
          {label}
        </text>
      )}
      {showChart && charts !== undefined && node.ref !== undefined && (
        <BoxChart id={charts.id} scope={charts.scope} store={charts.store} fnId={node.ref} rect={rect} onNodeClick={onChartStep} selectedId={selectedId} />
      )}
    </g>
  );
}
