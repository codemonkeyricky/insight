// The zoom map: one d3-zoom camera over the whole project. Folders, files and functions open as the camera
// reaches them, a function's chart sits in its own slot, and the URL follows the focus. The camera transform is
// written straight onto a <g>; React re-renders only when the set of drawn items changes.
import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as KeyEvent, type PointerEvent as PointerEv } from "react";
import { select } from "d3-selection";
import "d3-transition";
import { zoom, zoomIdentity, type D3ZoomEvent, type ZoomBehavior, type ZoomTransform } from "d3-zoom";
import {
  PROJECT_ID,
  ZOOM_SIZE,
  breadcrumb,
  fileBands,
  fitCamera,
  focusAt,
  nextOpen,
  urlFocus,
  visibleWorld,
  type Camera,
  type FunctionFlow,
  type PlacedEdge,
  type PlacedItem,
  type Rect,
  type ScopeFlowStats,
  type ScopeNode,
} from "@insight/flow";
import { nameOfId, resolutionPercent } from "../../flowTargets";
import { hrefView } from "../../router";
import { ZoomStore, type Build } from "../../zoom/scene";
import { FlowChart } from "../FlowChart";
import { FunctionDetail } from "./FunctionDetail";

/** The camera's scale range: from the whole project down to a single line of a chart. */
const SCALE: [number, number] = [0.02, 16];
const ANIM_MS = 450;
/** File colour bands, in the order files are listed. Matches --band-0 .. --band-5 in styles.css. */
const BANDS = 6;
/** Items this far (world units) outside the view are still drawn, so a pan does not show a blank edge. */
const CULL_MARGIN = 120;
const PAN_PX = 80;

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
  /** The URL's scope: a folder, or a file (a function's file). Empty is the project. */
  scope: string;
  /** The URL's function, when one is picked. */
  fn?: string;
}

export function ZoomMap({ id, scope, fn }: Props) {
  const store = useMemo(() => new ZoomStore(id), [id]);
  const [build, setBuild] = useState<Build>();
  const [shown, setShown] = useState<{ build?: Build; items: PlacedItem[]; edges: PlacedEdge[] }>({ items: [], edges: [] });
  const [error, setError] = useState<string>();
  const stageRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const worldRef = useRef<SVGGElement>(null);
  const miniRef = useRef<SVGSVGElement>(null);
  const miniViewRef = useRef<SVGRectElement>(null);
  const zoomRef = useRef<ZoomBehavior<SVGSVGElement, unknown> | undefined>(undefined);
  const cameraRef = useRef<Camera>({ k: 1, x: 0, y: 0 });
  const buildRef = useRef<Build | undefined>(undefined);
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
    setShown((prev) =>
      prev.build === b && sameList(prev.items, items, (i) => i.id) && sameList(prev.edges, edges, (e) => `${e.from}\u0000${e.to}`)
        ? prev
        : { build: b, items, edges },
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

  /** The deepest item under a world point. */
  const underAt = (b: Build, x: number, y: number): string | undefined => focusAt(b.tree, boxesRef.current, x, y);

  /** The deepest item under the middle of the view. */
  const underCentre = (b: Build, c: Camera): string | undefined => {
    const v = visibleWorld(c, sizeOf());
    return underAt(b, v.x + v.w / 2, v.y + v.h / 2);
  };

  /** The world point under a screen point (client pixels) for the camera `c`. */
  const worldAt = (clientX: number, clientY: number, c: Camera) => {
    const r = stageRef.current?.getBoundingClientRect();
    if (!r) return undefined;
    return { x: (clientX - r.left - c.x) / c.k, y: (clientY - r.top - c.y) / c.k };
  };

  /** Writes the focus into the URL without a history entry, then tells the router the hash changed. */
  const syncUrl = (b: Build, focus: string) => {
    const target = urlFocus(b.tree, focus);
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
    let b: Build;
    try {
      // A focus reached by a gesture has not been loaded yet: its scope flows, and for a function its file's charts.
      await store.ensureFocus(focus);
      b = await store.build(focus);
    } catch (e) {
      if (seq === seqRef.current) setError(messageOf(e));
      return;
    }
    if (seq !== seqRef.current) return;
    buildRef.current = b;
    focusRef.current = focus;
    boxesRef.current = b.placed.items.filter((i) => i.kind !== "stub").map((i) => ({ id: i.id, x: i.rect.x, y: i.rect.y, w: i.rect.w, h: i.rect.h }));
    setBuild(b);
    setError(undefined);
    const rect = b.placed.rects.get(focus);
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
   * gesture looks at the item under the pointer; other gestures look at the middle of the view.
   */
  const decide = () => {
    const b = buildRef.current;
    const focus = focusRef.current;
    const point = pointRef.current;
    pointRef.current = undefined;
    if (!b || focus === undefined) return;
    const c = cameraRef.current;
    const under = point ? underAt(b, point.x, point.y) : underCentre(b, c);
    const underRect = under === undefined ? undefined : b.placed.rects.get(under);
    const cur = focus === PROJECT_ID ? null : focus;
    const curRect = cur === null ? undefined : b.placed.rects.get(cur);
    // Only a gesture that zoomed in or panned may open a child. A zoom out would otherwise reopen the child it just left.
    const mayOpen = c.k >= gestureKRef.current;
    const next = nextOpen(
      cur,
      curRect ? curRect.w * c.k : null,
      mayOpen && under !== undefined && underRect ? { id: under, width: underRect.w * c.k } : null,
    );
    const target = next ?? b.tree.nodes.get(focus)?.parent ?? PROJECT_ID;
    if (target !== focus) void show(target, true, true);
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
    // The handlers read only refs and the store, so the ones from this render stay correct for the life of the effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, id]);

  // The URL drives the focus. A change this map made itself is already the focus, so it is skipped.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const next = await store.resolve(scope, fn);
      if (cancelled) return;
      if (next === focusRef.current && buildRef.current !== undefined) return;
      await show(next, buildRef.current !== undefined, false);
    })().catch((e: unknown) => {
      if (!cancelled) setError(messageOf(e));
    });
    return () => {
      cancelled = true;
    };
    // show reads only the store and refs, so it needs no dependency of its own.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, scope, fn]);

  // A new build may arrive while the camera stays put. Its minimap view box and world transform are set here.
  useEffect(() => {
    if (build) applyCamera(cameraRef.current);
    // applyCamera reads the refs only, so it runs once per build.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [build]);

  const onKey = (e: KeyEvent<HTMLDivElement>) => {
    const b = buildRef.current;
    const focus = focusRef.current;
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
        const parent = focus === undefined || !b ? undefined : b.tree.nodes.get(focus)?.parent;
        if (parent !== undefined) void show(parent, true, true);
        break;
      }
      case "Enter": {
        if (!b) break;
        const under = underCentre(b, cameraRef.current);
        if (under !== undefined && under !== focus) void show(under, true, true);
        break;
      }
      default:
        return;
    }
    e.preventDefault();
  };

  const tree = build?.tree;
  const bands = useMemo(() => (tree ? fileBands(tree, BANDS) : new Map<string, number>()), [tree]);
  const miniItems = useMemo(() => (build ? build.placed.items.filter((i) => i.kind !== "stub") : []), [build]);
  // The items and edges drawn are only those of the current build, so a stale set never shows.
  const live = build !== undefined && shown.build === build ? shown : undefined;
  const drawn = (kind: PlacedItem["kind"]) => (live ? live.items.filter((i) => i.kind === kind) : []);

  return (
    <div className="zm">
      {build?.stats && <ResolutionMeter stats={build.stats} />}
      {tree && build && (
        <nav className="zm-crumbs" aria-label="Breadcrumb">
          <ol>
            {breadcrumb(tree, build.focus).map((n, i, all) => {
              const label = n.kind === "project" ? "Project" : n.name;
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
                    href={hrefView(id, "flow", urlFocus(tree, n.id) ?? {})}
                    onClick={(e) => {
                      e.preventDefault();
                      void show(n.id, true, true);
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
        aria-label="Zoom map of the project"
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
              <FrameShape key={it.id} item={it} node={tree?.nodes.get(it.id)} onOpen={(next) => void show(next, true, true)} />
            ))}
            {live?.edges.map((e) => (
              <path
                key={`${e.from}\u0000${e.to}`}
                d={e.d}
                className={e.stub ? "zm-edge stub" : e.candidate ? "zm-edge candidate" : "zm-edge"}
                style={{ strokeWidth: Math.min(4, 1 + Math.log2(Math.max(1, e.count))) }}
                markerEnd={`url(#${arrowId})`}
              >
                <title>{e.stub ? `${e.count} calls, ${e.stubCount} leave the scope` : `${e.count} calls`}</title>
              </path>
            ))}
            {drawn("box").map((it) => {
              const node = tree?.nodes.get(it.id);
              return node ? (
                <BoxShape key={it.id} item={it} node={node} band={bands.get(node.path)} onOpen={(next) => void show(next, true, true)} />
              ) : null;
            })}
            {drawn("stub").map((it) => (
              <StubShape key={it.id} item={it} />
            ))}
            {drawn("cfg").map((it) =>
              build?.cfg && build.cfg.id === it.id ? <ChartSlot key={it.id} item={it} id={id} scope={build.path} fn={build.cfg.fn} /> : null,
            )}
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
                className={it.kind === "frame" ? "zm-mini-frame" : it.kind === "cfg" ? "zm-mini-cfg" : "zm-mini-box"}
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
      {build?.cfg && tree && (
        <FunctionDetail id={id} fn={build.cfg.fn} scope={build.path} calledFromOutside={Boolean(tree.nodes.get(build.focus)?.fn?.calledFromOutside)} />
      )}
    </div>
  );
}

function ResolutionMeter({ stats }: { stats: ScopeFlowStats }) {
  const pct = resolutionPercent(stats);
  if (pct === undefined) return <p className="muted small">No calls start in this scope.</p>;
  return (
    <div className="meter">
      <p className="small">
        Resolution: {stats.resolved} of {stats.calls} calls resolved in this scope · {stats.external} leave the scope
      </p>
      <div
        className="meter-bar"
        role="meter"
        aria-label="Calls resolved in this scope"
        aria-valuemin={0}
        aria-valuemax={stats.calls}
        aria-valuenow={stats.resolved}
        aria-valuetext={`${pct}% resolved`}
      >
        <span style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function FrameShape({ item, node, onOpen }: { item: PlacedItem; node: ScopeNode | undefined; onOpen: (id: string) => void }) {
  const { rect } = item;
  const head = ZOOM_SIZE.head;
  return (
    <g className="zm-frame">
      <title>{node?.path || node?.name || item.id}</title>
      <rect x={rect.x} y={rect.y} width={rect.w} height={rect.h} rx={10} className="zm-frame-body" />
      <g className="zm-hit" onClick={() => onOpen(item.id)}>
        <rect x={rect.x} y={rect.y} width={rect.w} height={head} rx={10} className="zm-frame-head" />
        <text x={rect.x + 12} y={rect.y + head / 2} dominantBaseline="central" className="zm-label">
          {node?.name ?? nameOfId(item.id)}
        </text>
        {node && (
          <text x={rect.x + rect.w - 12} y={rect.y + head / 2} dominantBaseline="central" textAnchor="end" className="zm-count">
            {node.functions} {node.functions === 1 ? "function" : "functions"}
          </text>
        )}
      </g>
    </g>
  );
}

function BoxShape({ item, node, band, onOpen }: { item: PlacedItem; node: ScopeNode; band: number | undefined; onOpen: (id: string) => void }) {
  const { rect } = item;
  const style = band !== undefined ? ({ "--band": `var(--band-${band})` } as CSSProperties) : undefined;
  return (
    <g className={`zm-box zm-${node.kind}`} style={style} onClick={() => onOpen(item.id)}>
      <title>{node.path || node.name}</title>
      <rect x={rect.x} y={rect.y} width={rect.w} height={rect.h} rx={8} className="zm-box-body" />
      <text x={rect.x + 12} y={rect.y + rect.h / 2} dominantBaseline="central" className="zm-label">
        {node.name}
      </text>
    </g>
  );
}

function StubShape({ item }: { item: PlacedItem }) {
  const { rect } = item;
  return (
    <g className="zm-stub">
      <title>{`${nameOfId(item.id)} in ${item.id.split("#")[0]}, outside this scope`}</title>
      <rect x={rect.x} y={rect.y} width={rect.w} height={rect.h} rx={8} className="zm-stub-body" />
      <text x={rect.x + 12} y={rect.y + rect.h / 2} dominantBaseline="central" className="zm-label zm-label-stub">
        {nameOfId(item.id)}
      </text>
    </g>
  );
}

/** The focused function's chart in its slot. A chart too large to draw, or with no steps, says so in the slot. */
function ChartSlot({ item, id, scope, fn }: { item: PlacedItem; id: string; scope: string; fn: FunctionFlow }) {
  const { rect, inner } = item;
  if (!inner) return null;
  const message = fn.tooLarge ? "Too many steps to chart" : fn.nodes.length === 0 ? "No steps to chart" : undefined;
  return (
    <g className="zm-cfg">
      <rect x={rect.x} y={rect.y} width={rect.w} height={rect.h} rx={10} className="zm-cfg-body" />
      <g transform={`translate(${inner.x} ${inner.y})`}>
        {message ? (
          <text x={inner.w / 2} y={inner.h / 2} textAnchor="middle" dominantBaseline="central" className="zm-label zm-label-stub">
            {message}
          </text>
        ) : (
          <FlowChart id={id} fn={fn} scope={scope} />
        )}
      </g>
    </g>
  );
}
