// The zoom map: one d3-zoom camera over a scene from a MapSource (the execution canvas of a scope). Containers open as
// the camera reaches them, and the URL follows the focus. The camera transform is written straight onto a <g>; React
// re-renders only when the set of drawn items changes.
import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as KeyEvent, type PointerEvent as PointerEv, type ReactNode } from "react";
import { select } from "d3-selection";
import "d3-transition";
import { zoom, zoomIdentity, type D3ZoomEvent, type ZoomBehavior, type ZoomTransform } from "d3-zoom";
import { ZOOM_SIZE, fitCamera, nextOpen, visibleWorld, type Camera, type PlacedItem, type Rect } from "@insight/flow";
import { nameOfId } from "../../flowTargets";
import { hrefView } from "../../router";
import { deepestAt, edgeClass, edgeKey, edgeTitle, edgeWidth, nearestBox, type MapBuild, type MapEdge, type MapNode, type MapSource } from "../../zoom/source";
import { bucketScale, fitLabel, headerLabels, labelChars, lodBucket } from "../../zoom/lod";

/** The camera's scale range: from the whole project down to a single line of a chart. */
const SCALE: [number, number] = [0.02, 16];
const ANIM_MS = 450;
/** Items this far (world units) outside the view are still drawn, so a pan does not show a blank edge. */
const CULL_MARGIN = 120;
const PAN_PX = 80;
/**
 * A gap between boxes this close on screen (px) still counts as the nearest box: a gesture or Enter that ends in a gap
 * opens the nearest box within it.
 */
const GAP_PX = 60;

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
}

/**
 * The execution map: one camera over a scope's scene. Each node is a focus of the source; the map's items and edges
 * are named by node id, so a click or key that names a node is turned into a focus by the source first (`focusOf`).
 */
export function ZoomMap({ id, source, scope, fn, detail }: Props) {
  const [build, setBuild] = useState<MapBuild>();
  /** `lod` is the camera's quarter-octave bucket (lod.ts): labels are cut to it, and it changes only with the bucket. */
  const [shown, setShown] = useState<{ build?: MapBuild; items: PlacedItem[]; edges: MapEdge[]; lod: number }>({ items: [], edges: [], lod: 0 });
  const [error, setError] = useState<string>();
  const stageRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const worldRef = useRef<SVGGElement>(null);
  const miniRef = useRef<SVGSVGElement>(null);
  const miniViewRef = useRef<SVGRectElement>(null);
  const zoomRef = useRef<ZoomBehavior<SVGSVGElement, unknown> | undefined>(undefined);
  const cameraRef = useRef<Camera>({ k: 1, x: 0, y: 0 });
  const buildRef = useRef<MapBuild | undefined>(undefined);
  /** The focus the map shows. Its build's `nodeId` is the node it stands for. */
  const focusRef = useRef<string | undefined>(undefined);
  const boxesRef = useRef<{ id: string; x: number; y: number; w: number; h: number }[]>([]);
  const seqRef = useRef(0);
  /** True while a camera move is ours (a focus change), so its end does not start a hysteresis decision. */
  const programmaticRef = useRef(false);
  const miniDragRef = useRef(false);
  /** The world point under the pointer at the last wheel event of this gesture. Wheel zoom works about the pointer. */
  const pointRef = useRef<{ x: number; y: number } | undefined>(undefined);
  /** The camera's scale when the current user gesture began. A gesture that ends above it may open a child. */
  const gestureKRef = useRef(1);
  const arrowId = `zm-arrow-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const hintId = useId();

  const sizeOf = () => ({ width: stageRef.current?.clientWidth ?? 0, height: stageRef.current?.clientHeight ?? 0 });

  /** Works out which items and edges are on screen, and stores them only when they differ from the last set. */
  const cull = (c: Camera) => {
    const b = buildRef.current;
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
      prev.build === b && prev.lod === lod && sameList(prev.items, items, (i) => i.id) && sameList(prev.edges, edges, edgeKey)
        ? prev
        : { build: b, items, edges, lod },
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

  /**
   * The box a world point stands in: the deepest item under it, or else the nearest box within GAP_PX on screen (a point
   * in a gap between boxes). Undefined when neither exists.
   */
  const pickAt = (b: MapBuild, x: number, y: number, c: Camera): string | undefined =>
    deepestAt(boxesRef.current, b.depth, x, y) ?? nearestBox(boxesRef.current, b.depth, x, y, GAP_PX / c.k);

  /** The middle of the view, in world units. */
  const centreOf = (c: Camera) => {
    const v = visibleWorld(c, sizeOf());
    return { x: v.x + v.w / 2, y: v.y + v.h / 2 };
  };

  /** The world point under a screen point (client pixels) for the camera `c`. */
  const worldAt = (clientX: number, clientY: number, c: Camera) => {
    const r = stageRef.current?.getBoundingClientRect();
    if (!r) return undefined;
    return { x: (clientX - r.left - c.x) / c.k, y: (clientY - r.top - c.y) / c.k };
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
   * Makes `focus` the focus: loads what it needs, builds the map for it, and moves the camera to fit it. `animate`
   * is false only for the first view, which is set at once.
   */
  const show = async (focus: string, animate: boolean, writeUrl: boolean) => {
    const seq = ++seqRef.current;
    let b: MapBuild;
    try {
      // A focus reached by a gesture may not be loaded yet: the source loads what it needs first.
      await source.ensureFocus(focus);
      b = await source.build(focus);
    } catch (e) {
      if (seq === seqRef.current) setError(messageOf(e));
      return;
    }
    if (seq !== seqRef.current) return;
    buildRef.current = b;
    focusRef.current = focus;
    boxesRef.current = b.placed.items.map((i) => ({ id: i.id, x: i.rect.x, y: i.rect.y, w: i.rect.w, h: i.rect.h }));
    setBuild(b);
    setError(undefined);
    const rect = b.placed.rects.get(b.nodeId);
    const svg = svgRef.current;
    const z = zoomRef.current;
    if (rect && svg && z) {
      const target = fitCamera(rect, sizeOf());
      programmaticRef.current = true;
      if (animate && !reduceMotion()) select(svg).transition().duration(ANIM_MS).call(z.transform, toTransform(target));
      else select(svg).call(z.transform, toTransform(target));
    }
    cull(cameraRef.current);
    if (writeUrl) syncUrl(b, focus);
  };

  /**
   * The hysteresis step after a user gesture: the open node stays open until it is narrower than 200 px on screen,
   * and a node opens once it is wider than 240 px. Runs at the end of a wheel or key gesture, not during it. A wheel
   * gesture looks at the item under the pointer; other gestures look at the middle of the view. Either point may lie in
   * a gap between boxes, and then the nearest box within GAP_PX is the one looked at (`pickAt`).
   */
  const decide = () => {
    const b = buildRef.current;
    const point = pointRef.current;
    pointRef.current = undefined;
    if (!b || focusRef.current === undefined) return;
    const c = cameraRef.current;
    const at = point ?? centreOf(c);
    const under = pickAt(b, at.x, at.y, c);
    const underRect = under === undefined ? undefined : b.placed.rects.get(under);
    // The root is always open, so it is never the node that stays open; going up from it stays at it.
    const parent = b.node(b.nodeId)?.parent;
    const cur = parent === undefined ? null : b.nodeId;
    const curRect = cur === null ? undefined : b.placed.rects.get(cur);
    // Only a gesture that zoomed in or panned may open a child. A zoom out would otherwise reopen the child it just left.
    const mayOpen = c.k >= gestureKRef.current;
    const next = nextOpen(
      cur,
      curRect ? curRect.w * c.k : null,
      mayOpen && under !== undefined && underRect ? { id: under, width: underRect.w * c.k } : null,
    );
    const target = next ?? parent ?? b.nodeId;
    if (target !== b.nodeId) openNode(target);
  };

  /** Opens the node a click, key or link names: the source turns the node into its focus, then the map shows it. */
  const openNode = (nodeId: string) => {
    const b = buildRef.current;
    if (b) void show(source.focusOf?.(b, nodeId) ?? nodeId, true, true);
  };

  const zoomStep = (factor: number) => {
    const svg = svgRef.current;
    const z = zoomRef.current;
    if (!svg || !z) return;
    programmaticRef.current = false;
    select(svg).transition().duration(180).call(z.scaleBy, factor);
  };

  const panStep = (dx: number, dy: number) => {
    const svg = svgRef.current;
    const z = zoomRef.current;
    if (!svg || !z) return;
    programmaticRef.current = false;
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
    programmaticRef.current = true;
    select(svg).call(z.transform, zoomIdentity.translate(size.width / 2 - wx * c.k, size.height / 2 - wy * c.k).scale(c.k));
  };

  // The camera. Wheel and drag are d3-zoom's; a user gesture that ends runs the hysteresis step.
  useEffect(() => {
    const svg = svgRef.current;
    const stage = stageRef.current;
    if (!svg || !stage) return;
    buildRef.current = undefined;
    focusRef.current = undefined;
    const z = zoom<SVGSVGElement, unknown>()
      .scaleExtent(SCALE)
      .on("start", (ev: D3ZoomEvent<SVGSVGElement, unknown>) => {
        if (ev.sourceEvent) {
          programmaticRef.current = false;
          pointRef.current = undefined;
          gestureKRef.current = cameraRef.current.k;
        }
      })
      .on("zoom", (ev: D3ZoomEvent<SVGSVGElement, unknown>) => {
        const c = toCamera(ev.transform);
        applyCamera(c);
        const src = ev.sourceEvent as Partial<WheelEvent> | null;
        if (src && src.type === "wheel" && typeof src.clientX === "number" && typeof src.clientY === "number") {
          pointRef.current = worldAt(src.clientX, src.clientY, c);
        }
      })
      .on("end", () => {
        if (!programmaticRef.current) decide();
      });
    zoomRef.current = z;
    const sel = select(svg).call(z);
    const ro = new ResizeObserver(() => cull(cameraRef.current));
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

  // A new build may arrive while the camera stays put. Its minimap view box and world transform are set here.
  useEffect(() => {
    if (build) applyCamera(cameraRef.current);
    // applyCamera reads the refs only, so it runs once per build.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [build]);

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
        const parent = b?.node(b.nodeId)?.parent;
        if (parent !== undefined) openNode(parent);
        break;
      }
      case "Enter": {
        if (!b) break;
        const c = cameraRef.current;
        const at = centreOf(c);
        const under = pickAt(b, at.x, at.y, c);
        if (under !== undefined && under !== b.nodeId) openNode(under);
        break;
      }
      default:
        return;
    }
    e.preventDefault();
  };

  const miniItems = useMemo(() => (build ? build.placed.items : []), [build]);
  // The items and edges drawn are only those of the current build, so a stale set never shows.
  const live = build !== undefined && shown.build === build ? shown : undefined;
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
              <FrameShape key={it.id} item={it} node={build?.node(it.id)} k={labelScale} onOpen={openNode} />
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
              const node = build?.node(it.id);
              return node ? <BoxShape key={it.id} item={it} node={node} k={labelScale} onOpen={openNode} /> : null;
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
        Scroll or press + and - to zoom. Arrow keys pan. Enter opens the item at the centre and Escape goes up one level. Click a
        box to open it.
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

function BoxShape({ item, node, k, onOpen }: { item: PlacedItem; node: MapNode; k: number; onOpen: (id: string) => void }) {
  const { rect } = item;
  const style = node.band !== undefined ? ({ "--band": `var(--band-${node.band})` } as CSSProperties) : undefined;
  const label = fitLabel(node.label, labelChars(rect.w * k));
  return (
    <g className={`zm-box zm-${node.kind}`} style={style} onClick={() => onOpen(item.id)}>
      <title>{node.title || node.label}</title>
      <rect x={rect.x} y={rect.y} width={rect.w} height={rect.h} rx={8} className="zm-box-body" />
      {label !== null && (
        <text x={rect.x + 12} y={rect.y + rect.h / 2} dominantBaseline="central" className="zm-label">
          {label}
        </text>
      )}
    </g>
  );
}
