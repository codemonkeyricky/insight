import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import type { PipelineModel, Site, SystemEdge, SystemModel } from "@insight/model";
import { api } from "../../api";
import { fileTarget, useCodeTarget } from "../../codeTarget";
import { layoutSystem, pillText, routeText, type SysArrow, type SysBox, type SysLayout } from "../../arch/system-layout";
import { hrefView } from "../../router";
import { PipelineSummary } from "./PipelineSummary";

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** What is selected in the diagram: a card or one edge, by id. */
type Selection = { kind: "node" | "edge"; id: string } | null;

const MIN_K = 0.1;
const MAX_K = 2.5;
/** The smallest scale a fit settles on: a card title is 18 px, so it stays at 10 px or more. A wider graph is panned. */
export const FIT_MIN_K = 0.56;
/** Edges above this count show a verb pill only on the edges of the hovered or selected node. */
export const PILL_LIMIT = 30;
const FIT_MAX_K = 1.15;
/** Room kept along the bottom of the stage for the legend, in px. */
const LEGEND_H = 40;

interface Camera {
  k: number;
  x: number;
  y: number;
}

/** The camera that shows the whole layout in a view of `w` by `h`. Expanding the view gives a wide diagram room to be read. */
export function fitCamera(layout: Pick<SysLayout, "width" | "height"> & { focusY?: number }, w: number, h: number): Camera {
  if (layout.width === 0 || layout.height === 0 || w <= 0 || h <= 0) return { k: 1, x: 0, y: 0 };
  const k = Math.max(FIT_MIN_K, Math.min(FIT_MAX_K, (w - 16) / layout.width, (h - 16) / layout.height));
  const cx = layout.width * k <= w ? (w - layout.width * k) / 2 : 8;
  // A diagram taller than the view starts on its first column, not on the middle of the canvas.
  const cyy = layout.height * k <= h ? (h - layout.height * k) / 2 : Math.min(8, Math.max(h - layout.height * k - 8, h / 2 - (layout.focusY ?? layout.height / 2) * k));
  return { k, x: cx, y: cyy };
}

const dirname = (file: string): string => (file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "");
const fnName = (fn: string): string => fn.slice(fn.lastIndexOf("#") + 1);

/**
 * The System view of the explorer scope: the components inside it, the routes they serve, the outside systems they touch and
 * the verbs between them, computed in the page from the project model (so it works in the demo and hosted builds too).
 */
export function SystemView({ id, scope }: { id: string; scope: string }) {
  const [tests, setTests] = useState(false);
  const [done, setDone] = useState<{ key: string; sys?: SystemModel; error?: string } | null>(null);
  const key = `${id}\0${scope}\0${tests}`;
  useEffect(() => {
    let cancelled = false;
    api.getSystem(id, scope, tests).then(
      (sys) => {
        if (!cancelled) setDone({ key, sys });
      },
      (e: unknown) => {
        if (!cancelled) setDone({ key, error: e instanceof Error ? e.message : String(e) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [id, scope, tests, key]);
  if (done === null) return <p className="muted">Loading</p>;
  if (done.sys === undefined) return <p className="error" role="alert">{done.error}</p>;
  return <SystemDiagram id={id} sys={done.sys} tests={tests} onTests={setTests} stale={done.key !== key} />;
}

export interface SystemDiagramProps {
  id: string;
  sys: SystemModel;
  tests: boolean;
  onTests: (on: boolean) => void;
  stale?: boolean;
  /** Column titles, left to right (the Pipeline view's columns). Without them the System view's own titles are drawn. */
  titles?: readonly string[];
  /** The Pipeline model `sys` was converted from: its side panel shows when nothing is selected, and its reason fills the empty state. */
  pipeline?: PipelineModel;
}

/** The diagram, its toolbar and its side panel for one System model. Pure of data loading, so it renders from a model alone. */
export function SystemDiagram({ id, sys, tests, onTests, stale = false, titles, pipeline }: SystemDiagramProps) {
  const layout = useMemo(() => layoutSystem(sys, titles), [sys, titles]);
  const [sel, setSel] = useState<Selection>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [cam, setCam] = useState<Camera>({ k: 1, x: 0, y: 0 });
  const [expanded, setExpanded] = useState(false);
  /** The stage's height in px: the room the window leaves, at least 60vh. Null while expanded (the view fills the window). */
  const [stageH, setStageH] = useState<number | null>(null);
  const stage = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; cx: number; cy: number; moved: boolean } | null>(null);

  const fit = useCallback(() => {
    const el = stage.current;
    const w = el?.clientWidth ?? 900;
    const vh = typeof window === "undefined" ? 900 : window.innerHeight;
    // As tall as the window leaves room for below the stage's top edge, and at least 60% of the window.
    const room = el ? vh - el.getBoundingClientRect().top - 12 : 0;
    const h = expanded ? (el?.clientHeight ?? 700) : Math.max(420, vh * 0.6, room);
    setStageH(expanded ? null : h);
    // The legend sits along the bottom edge, so the diagram is fitted above it.
    setCam(fitCamera(layout, w, h - LEGEND_H));
  }, [layout, expanded]);
  // Fits when a layout arrives (a new scope, the tests flag) or the view expands, and clears the selection of the old layout.
  useLayoutEffect(() => {
    fit();
  }, [fit]);
  useLayoutEffect(() => {
    setSel(null);
    setHover(null);
  }, [layout]);
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") setExpanded(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded]);

  // The wheel zooms around the pointer. React's onWheel is passive, so the listener is added by hand.
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      // The side panel scrolls itself.
      if ((e.target as Element).closest(".sysv-panel")) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const px = e.clientX - r.left;
      const py = e.clientY - r.top;
      setCam((c) => {
        const k = Math.min(MAX_K, Math.max(MIN_K, c.k * Math.exp(-e.deltaY * 0.0015)));
        const s = k / c.k;
        return { k, x: px - (px - c.x) * s, y: py - (py - c.y) * s };
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const zoomBy = (f: number) => {
    const el = stage.current;
    const px = (el?.clientWidth ?? 800) / 2;
    const py = (el?.clientHeight ?? 500) / 2;
    setCam((c) => {
      const k = Math.min(MAX_K, Math.max(MIN_K, c.k * f));
      const s = k / c.k;
      return { k, x: px - (px - c.x) * s, y: py - (py - c.y) * s };
    });
  };

  const onDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || (e.target as Element).closest("[data-node],[data-edge],button,a,label,aside")) return;
    drag.current = { x: e.clientX, y: e.clientY, cx: cam.x, cy: cam.y, moved: false };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
    setCam((c) => ({ ...c, x: d.cx + dx, y: d.cy + dy }));
  };
  const onUp = () => {
    const d = drag.current;
    drag.current = null;
    if (d && !d.moved) setSel(null);
  };

  const byBox = useMemo(() => new Map(layout.boxes.map((b) => [b.id, b])), [layout]);
  const focus = hover ?? (sel === null ? null : sel.id);
  const focusKind: "node" | "edge" | null = hover !== null ? (byBox.has(hover) ? "node" : "edge") : sel === null ? null : sel.kind;
  const lit = useMemo(() => {
    if (focus === null || focusKind === null) return null;
    const edges = new Set<string>();
    const nodes = new Set<string>();
    if (focusKind === "node") {
      nodes.add(focus);
      for (const a of layout.arrows) {
        if (a.from === focus || a.to === focus) {
          edges.add(a.id);
          nodes.add(a.from);
          nodes.add(a.to);
        }
      }
    } else {
      const a = layout.arrows.find((x) => x.id === focus);
      if (a) {
        edges.add(a.id);
        nodes.add(a.from);
        nodes.add(a.to);
      }
    }
    return { edges, nodes };
  }, [focus, focusKind, layout]);

  const openScope = (path: string) => {
    window.location.hash = hrefView(id, "arch", { scope: path });
  };
  const pickNode = (b: SysBox) => setSel({ kind: "node", id: b.id });
  const pickEdge = (a: SysArrow) => setSel({ kind: "edge", id: a.id });
  const nodeKey = (b: SysBox, e: KeyboardEvent<SVGGElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      pickNode(b);
    }
  };
  const edgeKey = (a: SysArrow, e: KeyboardEvent<SVGGElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      pickEdge(a);
    }
  };

  // The edges keep their order: moving the DOM nodes of a hovered edge would swallow the click that follows the hover.
  const arrows = layout.arrows;

  const empty = layout.boxes.length === 0;
  // Content past the stage's edge: a fade along the right edge and a hint to pan.
  const stageW = stage.current?.clientWidth ?? 0;
  const stageHt = stage.current?.clientHeight ?? 0;
  const cut = !empty && stageW > 0 && (cam.x + layout.width * cam.k > stageW + 4 || cam.x < -4 || cam.y < -4 || cam.y + layout.height * cam.k > stageHt + 4);
  const cutRight = cut && cam.x + layout.width * cam.k > stageW + 4;
  return (
    <div className={`sysv${expanded ? " expanded" : ""}`}>
      <div className="sysv-bar">
        <span className="muted small sysv-counts">
          {pipeline !== undefined
            ? `${plural(pipeline.points.length, "extension point")} · ${plural(sys.components.length, "component")} · ${plural(sys.edges.length, "edge")}`
            : `${plural(sys.components.length, "component")} · ${plural(sys.externals.length, "outside system")} · ${plural(sys.edges.length, "edge")}`}
        </span>
        <span className="muted small sysv-scope">
          Scope <span className="mono">{sys.scope === "" ? "(project)" : sys.scope}</span>
          {sys.via !== undefined && (
            <span className="sysv-via" title={`The scope holds one folder of code, so its parts are shown.`}>
              {" "}
              via <span className="mono">{sys.via}</span>
            </span>
          )}
        </span>
        <label className="sysv-tests small">
          <input type="checkbox" checked={tests} onChange={(e) => onTests(e.target.checked)} /> Show tests
        </label>
        <span className="sysv-zoom" role="group" aria-label="Zoom">
          <button type="button" onClick={() => zoomBy(1 / 1.25)} aria-label="Zoom out">
            −
          </button>
          <button type="button" onClick={() => zoomBy(1.25)} aria-label="Zoom in">
            +
          </button>
          <button type="button" onClick={fit}>
            Fit
          </button>
          <button type="button" onClick={() => setExpanded(!expanded)} aria-pressed={expanded} title="Fill the window (Esc leaves)">
            {expanded ? "Close" : "Expand"}
          </button>
        </span>
      </div>
      <div className="sysv-body">
        <div
          className={`sysv-stage${stale ? " stale" : ""}`}
          ref={stage}
          style={stageH === null ? undefined : { height: stageH }}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
        >
          {empty && pipeline?.reason !== undefined ? (
            <div className="sysv-empty">
              <p>No extension points in this scope. Pick a parent scope.</p>
            </div>
          ) : empty ? (
            <div className="sysv-empty">
              <p>No system facts in this scope.</p>
              <p className="muted small">
                A scope shows its parts that hold code, what they call, the routes they serve and the outside systems they reach. Pick a folder
                or package with code{tests ? "" : ", or turn on Show tests if the code here is tests"}.
              </p>
            </div>
          ) : (
            <svg className="sysv-svg" width="100%" height="100%" role="img" aria-label="System architecture">
              <defs>
                <marker id="sysv-head" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                  <path className="sysv-head" d="M0 0 L10 5 L0 10 z" />
                </marker>
                <marker id="sysv-head-w" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                  <path className="sysv-head w" d="M0 0 L10 5 L0 10 z" />
                </marker>
              </defs>
              <g transform={`translate(${cam.x} ${cam.y}) scale(${cam.k})`}>
                {layout.columns.map((c) =>
                  c.title === "" ? null : (
                    <text key={c.index} className="sysv-col" x={c.x} y={44}>
                      {c.title}
                    </text>
                  ),
                )}
                {layout.groups.map((g) => (
                  <text key={g.category} className="sysv-group" x={g.x} y={g.y}>
                    {g.title}
                  </text>
                ))}
                {arrows.map((a) => {
                  const on = lit?.edges.has(a.id) === true;
                  const dim = lit !== null && !on;
                  const picked = sel?.kind === "edge" && sel.id === a.id;
                  const cls = ["sysv-edge", `v-${a.edge.verb}`, a.dashed && "dashed", a.inferred && "inferred", on && "lit", dim && "dim", picked && "picked"]
                    .filter(Boolean)
                    .join(" ");
                  const pill = a.pill;
                  const showPill = arrows.length <= PILL_LIMIT || on;
                  return (
                    <g
                      key={a.id}
                      className={cls}
                      data-edge={a.id}
                      role="button"
                      tabIndex={0}
                      aria-label={`${a.from} ${a.edge.verb} ${a.to}: ${a.edge.label}`}
                      onKeyDown={(e) => edgeKey(a, e)}
                      onMouseEnter={() => setHover(a.id)}
                      onMouseLeave={() => setHover(null)}
                      onFocus={() => setHover(a.id)}
                      onBlur={() => setHover(null)}
                    >
                      <path className="sysv-line" d={a.d} markerEnd={a.edge.verb === "writes" || a.edge.verb === "produces" ? "url(#sysv-head-w)" : "url(#sysv-head)"} />
                      <path className="sysv-hit" d={a.d} onClick={() => pickEdge(a)} />
                      {showPill && (
                        <g className="sysv-pill" onClick={() => pickEdge(a)}>
                          <rect x={pill.x - pill.w / 2} y={pill.y - pill.h / 2} width={pill.w} height={pill.h} rx={pill.h / 2} />
                          <text x={pill.x} y={pill.y} textAnchor="middle" dy="0.35em">
                            {pill.text}
                          </text>
                        </g>
                      )}
                    </g>
                  );
                })}
                {layout.boxes.map((b) => {
                  const dim = lit !== null && !lit.nodes.has(b.id);
                  const picked = sel?.kind === "node" && sel.id === b.id;
                  const cls = ["sysv-node", b.kind, b.category && `c-${b.category}`, dim && "dim", picked && "picked", lit?.nodes.has(b.id) && "lit"].filter(Boolean).join(" ");
                  return (
                    <g
                      key={b.id}
                      className={cls}
                      data-node={b.id}
                      role="button"
                      tabIndex={0}
                      aria-label={b.kind === "component" ? `${b.component?.label}, ${b.sub}` : `${b.external?.label}, outside system`}
                      onClick={() => pickNode(b)}
                      onDoubleClick={() => b.kind === "component" && b.component && openScope(b.component.path)}
                      onKeyDown={(e) => nodeKey(b, e)}
                      onMouseEnter={() => setHover(b.id)}
                      onMouseLeave={() => setHover(null)}
                      onFocus={() => setHover(b.id)}
                      onBlur={() => setHover(null)}
                    >
                      <title>{b.kind === "component" ? b.component?.label : b.external?.label}</title>
                      <rect className="sysv-card" x={b.x} y={b.y} width={b.w} height={b.h} rx={12} />
                      <rect className="sysv-tab" x={b.x} y={b.y + 10} width={4} height={b.h - 20} rx={2} />
                      <text className="sysv-name" x={b.x + 16} y={b.y + 26}>
                        {b.title}
                      </text>
                      <text className="sysv-sub" x={b.x + 16} y={b.y + 46}>
                        {b.sub}
                      </text>
                      {b.chips.map((chip, i) => (
                        <g key={chip + i} className="sysv-chip">
                          <rect x={b.x + 14} y={b.y + 56 + i * 20} width={Math.min(b.w - 28, chip.length * 8 + 14)} height={16} rx={8} />
                          <text x={b.x + 21} y={b.y + 64 + i * 20} dy="0.35em">
                            {chip}
                          </text>
                        </g>
                      ))}
                    </g>
                  );
                })}
              </g>
            </svg>
          )}
          {cutRight && <div className="sysv-fade" aria-hidden="true" />}
          {cut && sel === null && <span className="sysv-hint small muted">drag to pan · Fit</span>}
          {!empty && sel === null && <Legend pipeline={pipeline !== undefined} />}
          {sel !== null && <Panel id={id} sys={sys} layout={layout} sel={sel} onSelect={setSel} onOpen={openScope} onClose={() => setSel(null)} />}
        </div>
        {!empty && sel === null && pipeline !== undefined && <PipelineSummary pipeline={pipeline} />}
      </div>
    </div>
  );
}

function Legend({ pipeline }: { pipeline: boolean }) {
  if (pipeline) {
    return (
      <ul className="sysv-legend small muted" aria-label="Legend">
        <li>
          <span className="sw w" /> produces
        </li>
        <li>
          <span className="sw" /> feeds, calls
        </li>
      </ul>
    );
  }
  return (
    <ul className="sysv-legend small muted" aria-label="Legend">
      <li>
        <span className="sw w" /> writes
      </li>
      <li>
        <span className="sw" /> reads, calls, requests
      </li>
      <li>
        <span className="sw dashed" /> runs, spawns
      </li>
      <li>
        <span className="sw inferred" /> inferred
      </li>
    </ul>
  );
}

function Panel({ id, sys, layout, sel, onSelect, onOpen, onClose }: { id: string; sys: SystemModel; layout: SysLayout; sel: NonNullable<Selection>; onSelect: (s: Selection) => void; onOpen: (path: string) => void; onClose: () => void }) {
  const nameOf = (nodeId: string): string => {
    const b = layout.boxes.find((x) => x.id === nodeId);
    return b ? (b.kind === "component" ? (b.component?.label ?? nodeId) : (b.external?.label ?? nodeId)) : nodeId;
  };
  const close = (
    <button type="button" className="sysv-close" aria-label="Close the panel" onClick={onClose}>
      ×
    </button>
  );
  if (sel.kind === "edge") {
    const a = layout.arrows.find((x) => x.id === sel.id);
    if (!a) return <aside className="sysv-panel" />;
    return (
      <aside className="sysv-panel" aria-label="Selection">{close}
        <EdgeDetail id={id} edge={a.edge} fromName={nameOf(a.from)} toName={nameOf(a.to)} />
      </aside>
    );
  }
  const box = layout.boxes.find((x) => x.id === sel.id);
  if (!box) return <aside className="sysv-panel" />;
  const out = layout.arrows.filter((a) => a.from === box.id);
  const inn = layout.arrows.filter((a) => a.to === box.id);
  const routes = sys.routes.filter((r) => r.component === box.id);
  return (
    <aside className="sysv-panel" aria-label="Selection">{close}
      <h2 className="mono">{box.kind === "component" ? box.component?.label : box.external?.label}</h2>
      {box.kind === "component" && box.component ? (
        <>
          <p className="small muted">
            {box.component.kind} <span className="mono">{box.component.path}</span> · {box.sub}
          </p>
          <p>
            <button type="button" className="sysv-open" onClick={() => onOpen(box.component?.path ?? "")}>
              Open
            </button>
          </p>
        </>
      ) : (
        <p className="small muted">
          {box.external?.category} {box.external?.host ?? box.external?.command ?? ""}
          {box.external?.names !== undefined && <span className="mono"> {box.external.names.join(", ")}</span>}
        </p>
      )}
      {routes.length > 0 && (
        <>
          <h3>Serves</h3>
          <ul className="arch-list">
            {routes.map((r) => (
              <li key={r.id}>
                <span className="mono small">{routeText(r)}</span>
                {r.handler !== undefined && <span className="muted small"> → {r.handler}</span>}
                <SiteLinks id={id} sites={[r.site]} />
              </li>
            ))}
          </ul>
        </>
      )}
      <EdgeList title="Goes to" id={id} rows={out} nameOf={(a) => nameOf(a.to)} onSelect={onSelect} />
      <EdgeList title="Reached from" id={id} rows={inn} nameOf={(a) => nameOf(a.from)} onSelect={onSelect} />
    </aside>
  );
}

function EdgeList({ title, id, rows, nameOf, onSelect }: { title: string; id: string; rows: SysArrow[]; nameOf: (a: SysArrow) => string; onSelect: (s: Selection) => void }) {
  if (rows.length === 0) return null;
  return (
    <>
      <h3>{title}</h3>
      <ul className="arch-list">
        {rows.map((a) => (
          <li key={a.id}>
            <button type="button" className="arch-link" onClick={() => onSelect({ kind: "edge", id: a.id })}>
              <span className={`sysv-verb v-${a.edge.verb}`}>{a.pill.text}</span> <span className="mono small">{nameOf(a)}</span>
            </button>
            <SiteLinks id={id} sites={a.edge.sites.slice(0, 3)} />
            {a.edge.sites.length > 3 && <span className="muted small"> +{a.edge.sites.length - 3} more in the edge</span>}
          </li>
        ))}
      </ul>
    </>
  );
}

function EdgeDetail({ id, edge, fromName, toName }: { id: string; edge: SystemEdge; fromName: string; toName: string }) {
  return (
    <>
      <h2 className="mono">
        {fromName} -&gt; {toName}
      </h2>
      <p className="small">
        <span className={`sysv-verb v-${edge.verb}`}>{pillText(edge)}</span>
      </p>
      <p className="small muted">
        {plural(edge.count, "fact")}, confidence {edge.confidence}
        {edge.count > edge.sites.length ? `, first ${edge.sites.length} sites shown` : ""}
      </p>
      <h3>Sites</h3>
      <SiteLinks id={id} sites={edge.sites} />
    </>
  );
}


/** file:line opens the right Code pane, in place (the scope stays); a function also links to its Flow chart. */
export function SiteLinks({ id, sites }: { id: string; sites: Site[] }) {
  const { showCode } = useCodeTarget();
  if (sites.length === 0) return <p className="muted small">No site recorded.</p>;
  return (
    <ul className="arch-list sysv-sites">
      {sites.map((s, i) => (
        <li key={`${s.file}\0${s.line}\0${s.fn ?? ""}\0${i}`}>
          <button type="button" className="arch-link mono small" onClick={() => showCode(fileTarget(s.file, s.line))}>
            {s.file}:{s.line}
          </button>
          {s.fn !== undefined && (
            <>
              {" "}
              <a className="small" href={hrefView(id, "flow", { scope: dirname(s.file), fn: s.fn, roots: true })} title={`Open ${fnName(s.fn)} in Flow`}>
                {fnName(s.fn)} in Flow
              </a>
            </>
          )}
        </li>
      ))}
    </ul>
  );
}
