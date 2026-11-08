// The entry view of the flow tab: the functions that nothing in a scope calls, as boxes in file frames, with the ladder
// of the scope's ancestors above them. The grid sits under one d3-zoom camera, as the hierarchy map does. An open
// function's chart opens in a card on the grid, and the URL names that function. The camera transform is written straight
// onto the world <g>, so React re-renders only when the flows, the layout or the open function change.
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as KeyEvent } from "react";
import { select } from "d3-selection";
import "d3-transition";
import { zoom, zoomIdentity, type D3ZoomEvent, type ZoomBehavior, type ZoomTransform } from "d3-zoom";
import {
  ZOOM_SIZE,
  entryBoxAt,
  entryCard,
  entryCount,
  entryDecision,
  entryFrameOf,
  entrySummary,
  fitCamera,
  ladderOf,
  layoutEntries,
  scopeChain,
  type Camera,
  type EntryCount,
  type EntryLayout,
  type EntrySummary,
  type FunctionFlow,
  type PlacedEntryBox,
  type PlacedEntryFrame,
  type Rect,
  type ScopeFlow,
} from "@insight/flow";
import { hrefView } from "../../router";
import type { ZoomStore } from "../../zoom/scene";
import { FlowChart } from "../FlowChart";
import { FunctionDetail } from "./FunctionDetail";

interface ChartState {
  fn: string;
  flow?: FunctionFlow;
  error?: string;
}

interface Props {
  id: string;
  /** The flow tab's store, shared with the hierarchy map. */
  store: ZoomStore;
  /** The URL's scope: a folder, or a file. Empty is the project. */
  scope: string;
  /** The URL's function, when one is picked. Its chart opens in a card on the grid. */
  fn?: string;
}

/** What the camera handlers read. They are bound once per stage, so they read the latest render's values from a ref. */
interface Latest {
  scope: string;
  fn?: string;
  layout?: EntryLayout;
  card?: Rect;
}

/** The camera's scale range: from the whole map down to a line of a chart. */
const SCALE: [number, number] = [0.1, 16];
/** A fly to a card or back to a box's frame. */
const FLY_MS = 450;
/** The Fit button's move back to the identity camera. */
const RESET_MS = 250;
/** A key or button step, a zoom or a pan. */
const STEP_MS = 180;
const ZOOM_STEP = 1.5;
const PAN_PX = 80;

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
const rungName = (name: string) => (name === "project" ? "Project" : name);
/** The file path, cut from the front when it would not fit in its frame's header. A 260 px frame holds about 34 wide characters. */
const shortPath = (file: string) => (file.length > 34 ? `…${file.slice(-33)}` : file);
const shortName = (name: string) => (name.length > 26 ? `${name.slice(0, 25)}…` : name);

const countsOf = (flow: ScopeFlow | undefined, includeNoise: boolean): EntryCount | undefined =>
  flow === undefined ? undefined : entryCount(flow, includeNoise);

/** A rung's count, `unreferenced/total`, with a tooltip that says it in words. */
const countText = (c: EntryCount) => `${c.unreferenced}/${c.total}`;
const countTitle = (c: EntryCount) =>
  `${c.unreferenced} unreferenced of ${c.total} ${plural(c.total, "function", "functions")} in scope`;

function summaryText(s: EntrySummary): string {
  const outside = s.outside > 0 ? `, ${s.outside} also called from outside this scope` : "";
  return `${s.shown} entry ${plural(s.shown, "point", "points")} in ${s.files} ${plural(s.files, "file", "files")}${outside}`;
}

/** Why the grid is empty. A scope whose only unreferenced functions are tests says so, and points at the toggle. */
function emptyText(flow: ScopeFlow): string {
  if (flow.stats.functionsTotal === 0) return "No function in this scope.";
  if (flow.stats.unreferenced === 0 && flow.stats.unreferencedNoise === 0) return "Every function in this scope is called from inside it.";
  return "The only unreferenced functions here are in test, fixture or sample files. Include tests and samples to see them.";
}

const toCamera = (t: ZoomTransform): Camera => ({ k: t.k, x: t.x, y: t.y });
const toTransform = (c: Camera): ZoomTransform => zoomIdentity.translate(c.x, c.y).scale(c.k);
const reduceMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Whether a world rectangle, seen through the camera, covers the whole stage. Then the view is already on it. */
const coversView = (r: Rect, c: Camera, size: { width: number; height: number }) =>
  r.x * c.k + c.x <= 0 && r.y * c.k + c.y <= 0 && (r.x + r.w) * c.k + c.x >= size.width && (r.y + r.h) * c.k + c.y >= size.height;

/** The entry view of one scope. Its ladder, summary and grid come from the flows the store has loaded. */
export function EntryMap({ id, store, scope, fn }: Props) {
  const [includeNoise, setIncludeNoise] = useState(false);
  const [chain, setChain] = useState<{ scope: string; error?: string }>();
  const [chart, setChart] = useState<ChartState>();
  // The width the grid wraps at: the width of this view, so the frames fit it instead of running off the right edge.
  // The stage is the same width, since it is a full-width block in this view.
  const rootRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState<number>();
  const stageRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const worldRef = useRef<SVGGElement>(null);
  const zoomRef = useRef<ZoomBehavior<SVGSVGElement, unknown> | undefined>(undefined);
  const cameraRef = useRef<Camera>({ k: 1, x: 0, y: 0 });
  /** The camera's scale when the current user gesture began. A gesture that ends below it may not open a box. */
  const gestureKRef = useRef(1);
  /** True while a camera move is ours (a reset or a fly), so its end does not start a decision. */
  const programmaticRef = useRef(false);
  /** Whether the camera moved in this gesture. A click that only presses and releases decides nothing. */
  const movedRef = useRef(false);
  /** The world point under the wheel pointer at the last wheel event of this gesture. Wheel zoom works about the pointer. */
  const pointRef = useRef<{ x: number; y: number } | undefined>(undefined);
  const latestRef = useRef<Latest>({ scope });
  /** The function and layout the camera last flew to a card for. A card is flown to once per such pair. */
  const flownRef = useRef<{ fn: string; layout: EntryLayout } | undefined>(undefined);
  /** The open function and its layout as last seen, so a close can tell itself apart from a scope change. */
  const openRef = useRef<{ fn: string; layout: EntryLayout } | undefined>(undefined);
  const prevFnRef = useRef<string | undefined>(undefined);
  /** Set when the open function closed because the camera zoomed out. That close leaves the camera where it is. */
  const closedByZoomRef = useRef(false);
  const hintId = useId();

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // The scope's flow and each ancestor's, for the grid and the ladder counts.
  useEffect(() => {
    let cancelled = false;
    store.ensureChain(scope).then(
      () => {
        if (!cancelled) setChain({ scope });
      },
      (e: unknown) => {
        if (!cancelled) setChain({ scope, error: messageOf(e) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [store, scope]);

  // The open function's chart, which loads its file's charts.
  useEffect(() => {
    if (fn === undefined) return;
    let cancelled = false;
    store.chartOf(fn).then(
      (flow) => {
        if (!cancelled) setChart({ fn, flow });
      },
      (e: unknown) => {
        if (!cancelled) setChart({ fn, error: messageOf(e) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [store, fn]);

  const ready = chain?.scope === scope ? chain : undefined;
  const flow = ready !== undefined && ready.error === undefined ? store.flowOf(scope) : undefined;
  // A frame wider than the wrap takes a row to itself, so the narrowest wrap is only a floor against a near-zero width.
  const wrap = width === undefined ? undefined : Math.max(260, Math.floor(width) - 4);
  const layout = useMemo(() => (flow ? layoutEntries(flow, { includeNoise, wrap }) : undefined), [flow, includeNoise, wrap]);
  const summary = flow ? entrySummary(flow, includeNoise) : undefined;
  const rungs = ladderOf(scope, (s) => countsOf(store.flowOf(s), includeNoise));
  const fromOutside = flow?.unreferenced.some((f) => f.id === fn && f.calledFromOutside) ?? false;
  const parent = scopeChain(scope)[1];

  // The open function's box, and its card once the box is shown and the chart has loaded.
  const frame = fn !== undefined && layout ? entryFrameOf(layout, fn) : undefined;
  const box = frame?.boxes.find((b) => b.id === fn);
  const chartFlow = fn !== undefined && chart?.fn === fn ? chart.flow : undefined;
  const card =
    box && chartFlow
      ? entryCard(box, { width: chartFlow.width, height: chartFlow.height, tooLarge: chartFlow.tooLarge, empty: chartFlow.nodes.length === 0 })
      : undefined;
  const cardShown = card !== undefined;
  const hasStage = layout !== undefined && layout.frames.length > 0;

  const sizeOf = () => ({ width: stageRef.current?.clientWidth ?? 0, height: stageRef.current?.clientHeight ?? 0 });

  /** The world point under a screen point (client pixels) for the camera `c`. */
  const worldAt = (clientX: number, clientY: number, c: Camera) => {
    // The camera's origin is the svg's top-left corner, which sits inside the stage's border.
    const r = svgRef.current?.getBoundingClientRect();
    if (!r) return undefined;
    return { x: (clientX - r.left - c.x) / c.k, y: (clientY - r.top - c.y) / c.k };
  };

  /** The world point at the middle of the stage, for the camera as it stands. */
  const centreWorld = () => {
    const c = cameraRef.current;
    const size = sizeOf();
    return { x: (size.width / 2 - c.x) / c.k, y: (size.height / 2 - c.y) / c.k };
  };

  /** Puts the camera on the world. The transform goes straight onto the <g>, which React does not manage. */
  const applyCamera = (c: Camera) => {
    cameraRef.current = c;
    const world = worldRef.current;
    if (world) {
      world.setAttribute("transform", `translate(${c.x} ${c.y}) scale(${c.k})`);
      // The labels keep the same size on screen, as the hierarchy map's do.
      world.style.setProperty("--zinv", String(1 / c.k));
    }
  };

  /** Writes the open function into the URL without a history entry, then tells the router the hash changed, as ZoomMap does. */
  const writeUrl = (at: string, open: string | undefined) => {
    const href = hrefView(id, "flow", open === undefined ? { scope: at } : { scope: at, fn: open });
    if (window.location.hash === href) return;
    window.history.replaceState(window.history.state, "", href);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  };

  /** Moves the camera to `t`: at once when `ms` is 0 or the reader asked for less motion, else over `ms`. The move is ours. */
  const glide = (t: ZoomTransform, ms: number) => {
    const svg = svgRef.current;
    const z = zoomRef.current;
    if (!svg || !z) return;
    programmaticRef.current = true;
    if (ms > 0 && !reduceMotion()) select(svg).transition().duration(ms).call(z.transform, t);
    else select(svg).call(z.transform, t);
  };

  /** A key or button step is a gesture of its own, so it starts from the scale it finds. */
  const zoomStep = (factor: number) => {
    const svg = svgRef.current;
    const z = zoomRef.current;
    if (!svg || !z) return;
    gestureKRef.current = cameraRef.current.k;
    programmaticRef.current = false;
    select(svg).transition().duration(STEP_MS).call(z.scaleBy, factor);
  };

  const panStep = (dx: number, dy: number) => {
    const svg = svgRef.current;
    const z = zoomRef.current;
    if (!svg || !z) return;
    gestureKRef.current = cameraRef.current.k;
    programmaticRef.current = false;
    select(svg).transition().duration(STEP_MS).call(z.translateBy, dx, dy);
  };

  /**
   * The decision at the end of a user gesture, as ZoomMap's hysteresis step: a box under the wheel pointer, or under the
   * middle of the view, opens once it is wider than ENTRY_OPEN_PX, and the open function closes once its card is narrower
   * than ENTRY_CLOSE_PX.
   */
  const decide = () => {
    const cur = latestRef.current;
    const point = pointRef.current;
    pointRef.current = undefined;
    if (cur.layout === undefined) return;
    const c = cameraRef.current;
    const at = point ?? centreWorld();
    const under = entryBoxAt(cur.layout, at.x, at.y);
    const d = entryDecision({
      open: cur.fn,
      cardPx: cur.card === undefined ? undefined : cur.card.w * c.k,
      under: under === undefined ? undefined : { id: under.id, px: under.w * c.k },
      // Only a gesture that zoomed in or panned may open a box. A zoom out would otherwise reopen the box it just left.
      mayOpen: c.k >= gestureKRef.current,
    });
    if (d === undefined) return;
    if (d.kind === "open") {
      writeUrl(cur.scope, d.id);
    } else {
      closedByZoomRef.current = true;
      writeUrl(cur.scope, undefined);
    }
  };

  // The camera. Wheel and drag are d3-zoom's. A user gesture that ends and moved the camera runs the decision. A click
  // that does not move the camera does not, so a click on a box only follows its link.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg || !hasStage) return;
    const z = zoom<SVGSVGElement, unknown>()
      .scaleExtent(SCALE)
      .on("start", (ev: D3ZoomEvent<SVGSVGElement, unknown>) => {
        movedRef.current = false;
        if (ev.sourceEvent) {
          programmaticRef.current = false;
          pointRef.current = undefined;
          gestureKRef.current = cameraRef.current.k;
        }
      })
      .on("zoom", (ev: D3ZoomEvent<SVGSVGElement, unknown>) => {
        const c = toCamera(ev.transform);
        applyCamera(c);
        if (!programmaticRef.current) movedRef.current = true;
        const src = ev.sourceEvent as Partial<WheelEvent> | null;
        if (src && src.type === "wheel" && typeof src.clientX === "number" && typeof src.clientY === "number") {
          pointRef.current = worldAt(src.clientX, src.clientY, c);
        }
      })
      .on("end", () => {
        if (!programmaticRef.current && movedRef.current) decide();
      });
    zoomRef.current = z;
    const sel = select(svg).call(z);
    return () => {
      sel.on(".zoom", null);
      zoomRef.current = undefined;
    };
    // The handlers read only refs and the latest values, so the ones from this render stay correct for the life of the effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasStage, id]);

  // The latest values, for the handlers above and the keys below.
  useEffect(() => {
    latestRef.current = { scope, fn, layout, card };
  });

  // A new layout (the scope, the toggle or the width) starts from the identity camera, at once.
  useEffect(() => {
    if (layout !== undefined) glide(zoomIdentity, 0);
    // glide reads refs only, so it needs no dependency of its own.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout]);

  // Closing the open function. A close by Escape flies the camera back to the box's frame. A close by zooming out leaves
  // the camera where the user put it. So does a scope change, which has reset the camera already.
  useEffect(() => {
    const prev = prevFnRef.current;
    prevFnRef.current = fn;
    if (fn !== undefined) return;
    flownRef.current = undefined;
    const byZoom = closedByZoomRef.current;
    closedByZoomRef.current = false;
    if (prev === undefined || byZoom || layout === undefined || openRef.current?.layout !== layout) return;
    const target = entryFrameOf(layout, prev);
    if (target !== undefined) glide(toTransform(fitCamera(target, sizeOf(), { maxK: 1 })), FLY_MS);
    // glide and sizeOf read refs only, and the close is a change of fn alone.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fn]);

  // An open function's card is flown to once for each (function, layout) pair, unless the card already covers the view. The
  // card waits for its chart, so a click on a box and a page load with the function in the URL both arrive here.
  useEffect(() => {
    if (fn === undefined || layout === undefined) return;
    openRef.current = { fn, layout };
    if (card === undefined) return;
    const done = flownRef.current;
    if (done?.fn === fn && done.layout === layout) return;
    flownRef.current = { fn, layout };
    const size = sizeOf();
    if (coversView(card, cameraRef.current, size)) return;
    glide(toTransform(fitCamera(card, size)), FLY_MS);
    // The card is read from this render, and the effect runs again when the card first exists.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fn, layout, cardShown]);

  /** Escape closes the open function first, then goes up one scope. */
  const onKey = (e: KeyEvent<HTMLDivElement>) => {
    if (e.key !== "Escape") return;
    const next = fn !== undefined ? hrefView(id, "flow", { scope }) : parent !== undefined ? hrefView(id, "flow", { scope: parent }) : undefined;
    if (next === undefined) return;
    e.preventDefault();
    window.location.hash = next;
  };

  /**
   * The stage's own keys. A box or button focused inside the stage keeps its own Enter and arrows, so only keys that land
   * on the stage itself act here.
   */
  const onStageKey = (e: KeyEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    switch (e.key) {
      case "+":
      case "=":
        zoomStep(ZOOM_STEP);
        break;
      case "-":
      case "_":
        zoomStep(1 / ZOOM_STEP);
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
      case "Enter": {
        // Enter opens the box under the middle of the view, as a wheel or drag would. An open card covers the grid, so
        // nothing opens while one is open.
        const cur = latestRef.current;
        if (cur.layout === undefined || cur.fn !== undefined) break;
        const at = centreWorld();
        const under = entryBoxAt(cur.layout, at.x, at.y);
        if (under !== undefined) writeUrl(cur.scope, under.id);
        break;
      }
      default:
        return;
    }
    e.preventDefault();
  };

  return (
    <div className="em" ref={rootRef} onKeyDown={onKey}>
      <nav className="em-ladder" aria-label="Scopes from the project down to this one">
        <ol>
          {rungs.map((r) => (
            <li key={r.scope || "project"}>
              {r.current ? (
                <strong aria-current="page">{rungName(r.name)}</strong>
              ) : (
                <a href={hrefView(id, "flow", { scope: r.scope })}>{rungName(r.name)}</a>
              )}
              {r.counts && (
                <span className="muted small em-count" title={countTitle(r.counts)}>
                  {" "}
                  {countText(r.counts)}
                </span>
              )}
            </li>
          ))}
        </ol>
        <p className="muted small em-legend">unreferenced / functions in scope — widening the scope resolves references</p>
      </nav>
      {ready?.error && (
        <p className="error" role="alert">
          {ready.error}
        </p>
      )}
      {!flow && !ready?.error && <p className="muted">Loading</p>}
      {flow && layout && summary && (
        <>
          <div className="em-bar">
            <p className="small em-summary">{summaryText(summary)}</p>
            <label className="em-toggle">
              <input type="checkbox" checked={includeNoise} onChange={(e) => setIncludeNoise(e.target.checked)} />
              Include tests and samples ({summary.noise})
            </label>
          </div>
          {layout.frames.length === 0 ? (
            <p className="muted">{emptyText(flow)}</p>
          ) : (
            <>
              <div
                className="em-stage"
                ref={stageRef}
                tabIndex={0}
                role="application"
                aria-label="Zoom map of entry points"
                aria-describedby={hintId}
                onKeyDown={onStageKey}
              >
                <svg ref={svgRef} className="em-svg" width="100%" height="100%">
                  <g ref={worldRef}>
                    {layout.frames.map((frame) => (
                      <FrameShape key={frame.file} frame={frame} id={id} scope={scope} selected={fn} />
                    ))}
                    {card !== undefined && chartFlow !== undefined && <EntryCardShape rect={card} flow={chartFlow} id={id} scope={scope} />}
                  </g>
                </svg>
                <div className="em-controls">
                  <button type="button" aria-label="Zoom in" onClick={() => zoomStep(ZOOM_STEP)}>
                    +
                  </button>
                  <button type="button" aria-label="Zoom out" onClick={() => zoomStep(1 / ZOOM_STEP)}>
                    −
                  </button>
                  <button type="button" aria-label="Reset view" onClick={() => glide(zoomIdentity, RESET_MS)}>
                    Fit
                  </button>
                </div>
              </div>
              <p id={hintId} className="muted small">
                Scroll or press + and - to zoom, drag to pan. Zoom into a function to open its control flow. Escape closes it.
              </p>
            </>
          )}
          {fn !== undefined && <ChartPanel id={id} scope={scope} state={chart?.fn === fn ? chart : undefined} fromOutside={fromOutside} />}
        </>
      )}
    </div>
  );
}

function FrameShape({ frame, id, scope, selected }: { frame: PlacedEntryFrame; id: string; scope: string; selected?: string }) {
  return (
    <g className={frame.noise ? "em-frame em-noise" : "em-frame"}>
      <title>{frame.file}</title>
      <rect x={frame.x} y={frame.y} width={frame.w} height={frame.h} rx={10} className="em-frame-body" />
      <text x={frame.x + 12} y={frame.y + ZOOM_SIZE.head / 2} dominantBaseline="central" className="em-frame-label">
        {shortPath(frame.file)}
      </text>
      {frame.boxes.map((b) => (
        <BoxLink key={b.id} box={b} id={id} scope={scope} selected={b.id === selected} />
      ))}
    </g>
  );
}

function BoxLink({ box, id, scope, selected }: { box: PlacedEntryBox; id: string; scope: string; selected: boolean }) {
  const reach = box.reach > 0 ? `reaches ${box.reach} ${plural(box.reach, "function", "functions")} in this scope` : "reaches no other function in this scope";
  const note = [`${box.name}, line ${box.line}`, reach, box.calledFromOutside ? "also called from outside this scope" : undefined]
    .filter((s) => s !== undefined)
    .join(". ");
  return (
    <a
      href={hrefView(id, "flow", { scope, fn: box.id })}
      className={`em-box${box.noise ? " em-noise" : ""}${selected ? " on" : ""}`}
      aria-current={selected ? "true" : undefined}
    >
      <title>{note}</title>
      <rect x={box.x} y={box.y} width={box.w} height={box.h} rx={8} className="em-box-body" />
      <text x={box.x + 12} y={box.y + 16} dominantBaseline="central" className="em-label">
        {shortName(box.name)}
      </text>
      <text x={box.x + 12} y={box.y + 32} dominantBaseline="central" className="em-reach">
        reaches {box.reach}
      </text>
      {box.calledFromOutside && (
        <circle cx={box.x + box.w - 12} cy={box.y + 12} r={4} className="em-outside">
          <title>Called from outside this scope</title>
        </circle>
      )}
    </a>
  );
}

/**
 * An open function's card: its name in a header, and its chart below. It sits over the grid at the box's top-left, in
 * world units, so it scales with the grid. It is drawn last, so it covers the boxes under it.
 */
function EntryCardShape({ rect, flow, id, scope }: { rect: Rect; flow: FunctionFlow; id: string; scope: string }) {
  const { pad, head } = ZOOM_SIZE;
  const message = flow.tooLarge ? "Too many steps to chart" : flow.nodes.length === 0 ? "No steps to chart" : undefined;
  // The title is cut to the card's width, so a long name stays inside it. A monospace character is about 7.5 px at 12 px.
  const fits = Math.max(8, Math.floor((rect.w - 2 * pad) / 7.5));
  const title = flow.name.length > fits ? `${flow.name.slice(0, fits - 1)}…` : flow.name;
  return (
    <g className="em-card" transform={`translate(${rect.x} ${rect.y})`}>
      <title>{flow.name}</title>
      <rect width={rect.w} height={rect.h} rx={10} className="em-card-body" />
      <text x={pad} y={head / 2} dominantBaseline="central" className="em-card-title">
        {title}
      </text>
      <g transform={`translate(${pad} ${head + pad})`}>
        {message ? (
          <text
            x={(rect.w - 2 * pad) / 2}
            y={(rect.h - head - 2 * pad) / 2}
            textAnchor="middle"
            dominantBaseline="central"
            className="em-card-message"
          >
            {message}
          </text>
        ) : (
          <FlowChart id={id} fn={flow} scope={scope} />
        )}
      </g>
    </g>
  );
}

/** The open function's detail below the grid, or what is wrong with it. Its chart is drawn in the card on the grid. */
function ChartPanel({ id, scope, state, fromOutside }: { id: string; scope: string; state?: ChartState; fromOutside: boolean }) {
  if (state?.error) return <p className="error" role="alert">{state.error}</p>;
  if (!state) return <p className="muted">Loading</p>;
  const f = state.flow;
  if (!f) return <p className="muted">That function is not in the snapshot.</p>;
  return <FunctionDetail id={id} fn={f} scope={scope} calledFromOutside={fromOutside} />;
}
