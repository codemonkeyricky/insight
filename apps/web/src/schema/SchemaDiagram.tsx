import { memo, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactElement } from "react";
import { select } from "d3-selection";
import { zoom, zoomIdentity, type ZoomBehavior } from "d3-zoom";
import "d3-transition";
import type { SchemaDiagramView, SchemaEntity, Span } from "../api";
import { solveInWorker } from "../states/elkClient";
import { withTimeout, type Solve } from "../states/layout";
import { CARD_PAD, HEADER_H, NOTE_H, ROW_H, VALUES_H, cardMetrics, extendsPath, layoutKinds, layoutRecords, refPath, type CardBox, type SchemaLayout } from "./layout";

export interface SchemaPick {
  span?: Span;
  label: string;
}

const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, Math.max(1, n - 1))}…`);

/** The CSS colour of a group: the n-th facet colour, the grey of plugin facets, or the records colour. */
export function groupColor(view: SchemaDiagramView, group: string): string {
  const FACETS = ["structure", "packaging", "flow", "calls", "concurrency", "sync", "effects", "state"];
  if (group === "records") return "var(--sd-rec)";
  if (view.groups.length > 1 && view.entities.every((e) => e.role === "record")) return `var(--sd-${Math.max(0, view.groups.findIndex((g) => g.id === group)) % 8})`;
  const i = FACETS.indexOf(group);
  return i >= 0 ? `var(--sd-${i})` : "var(--sd-x)";
}

interface CardProps {
  e: SchemaEntity;
  box: CardBox;
  color: string;
  state: "normal" | "hot" | "linked" | "dim";
  refLabel: (id: string) => string;
  onHot: (id: string | null) => void;
  onPick: (e: SchemaEntity) => void;
}

const Card = memo(function Card({ e, box, color, state, refLabel, onHot, onPick }: CardProps): ReactElement {
  const edge = e.role === "edge-kind";
  const { rowMid } = cardMetrics(e);
  const badge = e.role === "node-kind" ? "node" : e.role === "edge-kind" ? "edge" : "";
  const labelMax = badge ? 24 : 30;
  const keyDown = (ev: KeyboardEvent) => {
    if (ev.key === "Enter" || ev.key === " ") {
      ev.preventDefault();
      onPick(e);
    }
  };
  return (
    <g
      className={`sd-card ${state}`}
      transform={`translate(${box.x} ${box.y})`}
      tabIndex={0}
      role="button"
      aria-label={`${e.label}, ${e.fields.length} fields`}
      onMouseEnter={() => onHot(e.id)}
      onMouseLeave={() => onHot(null)}
      onFocus={() => onHot(e.id)}
      onBlur={() => onHot(null)}
      onClick={() => onPick(e)}
      onKeyDown={keyDown}
      data-entity={e.label}
    >
      <title>{e.description ? `${e.label}\n${e.description}` : e.label}</title>
      <rect className={`sd-body${edge ? " edge" : ""}`} width={box.w} height={box.h} rx={9} />
      <path className="sd-head" d={`M0 ${HEADER_H} V9 A9 9 0 0 1 9 0 H${box.w - 9} A9 9 0 0 1 ${box.w} 9 V${HEADER_H} Z`} style={{ fill: `color-mix(in srgb, ${color} 16%, var(--sd-card))` }} />
      <path d={`M2.29 3 A9 9 0 0 1 9 0 H${box.w - 9} A9 9 0 0 1 ${box.w - 2.29} 3 Z`} style={{ fill: color }} />
      <line x1={0} x2={box.w} y1={HEADER_H} y2={HEADER_H} className="sd-rule" />
      <text className="sd-label" x={12} y={HEADER_H / 2 + 3} dominantBaseline="central">
        {clip(e.label, labelMax)}
      </text>
      {badge && (
        <g transform={`translate(${box.w - 12 - 32} ${HEADER_H / 2 - 8})`}>
          <rect className={`sd-badge${edge ? " edge" : ""}`} width={32} height={16} rx={8} />
          <text className="sd-badge-text" x={16} y={8.5} textAnchor="middle" dominantBaseline="central">
            {badge}
          </text>
        </g>
      )}
      {e.fields.length === 0 && (
        <text className="sd-empty" x={12} y={HEADER_H + ROW_H / 2 + 2} dominantBaseline="central">
          no attributes
        </text>
      )}
      {e.note && (
        <text className="sd-note" x={12} y={cardMetrics(e).h - CARD_PAD - NOTE_H / 2 + 1} dominantBaseline="central">
          {clip(e.note, 38)}
        </text>
      )}
      {e.fields.map((f, i) => {
        const y = rowMid[i] ?? 0;
        const arrays = f.type.endsWith("[]");
        const typeText = f.ref ? `→ ${refLabel(f.ref)}${arrays ? "[]" : ""}` : clip(f.type, 18);
        const nameMax = Math.max(6, Math.floor((box.w - 38 - typeText.length * 6.3) / 6.6));
        const hasValues = f.values && f.values.length > 0;
        return (
          <g key={`${f.name}:${i}`} className={f.required ? "sd-field req" : "sd-field"}>
            <title>{`${f.name}: ${f.type}${f.required ? " (required)" : ""}${f.values ? `\n${f.values.join(" | ")}` : ""}${f.description ? `\n${f.description}` : ""}`}</title>
            {f.required ? <circle className="sd-dot" cx={15} cy={y} r={3} /> : <circle className="sd-dot hollow" cx={15} cy={y} r={2.6} />}
            <text className="sd-fname" x={25} y={y} dominantBaseline="central">
              {clip(f.name, nameMax)}
            </text>
            <text className={f.ref ? "sd-ftype ref" : "sd-ftype"} x={box.w - 12} y={y} textAnchor="end" dominantBaseline="central">
              {typeText}
            </text>
            {hasValues && (
              <text className="sd-values" x={25} y={y + ROW_H / 2 + VALUES_H / 2 - 1} dominantBaseline="central">
                {clip((f.values ?? []).join(" | "), 36)}
              </text>
            )}
          </g>
        );
      })}
    </g>
  );
});

export interface SchemaDiagramProps {
  view: SchemaDiagramView;
  onPick?: (p: SchemaPick) => void;
  /** The ELK solver for the records layout; the page uses the worker. */
  solve?: Solve;
}

/** An entity-relationship style diagram: cards with fields, frames per group, ref and extends links; wheel zoom, drag pan. */
export function SchemaDiagram({ view, onPick, solve = solveInWorker }: SchemaDiagramProps): ReactElement {
  const [layout, setLayout] = useState<SchemaLayout | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hot, setHot] = useState<string | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const wrapRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const gRef = useRef<SVGGElement>(null);
  const zoomRef = useRef<ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const fitted = useRef<SchemaLayout | null>(null);
  const lastFrame = useRef<string | null>(null);

  const byId = useMemo(() => new Map(view.entities.map((e) => [e.id, e])), [view]);
  const isKinds = view.entities.some((e) => e.role !== "record");

  useEffect(() => {
    setError(null);
    if (isKinds) {
      setLayout(layoutKinds(view));
      return;
    }
    setLayout(null);
    const ctl = new AbortController();
    layoutRecords(view, solve === solveInWorker ? solve : withTimeout(solve), ctl.signal).then(
      (l) => !ctl.signal.aborted && setLayout(l),
      (e: Error) => !ctl.signal.aborted && e.name !== "AbortError" && setError(e.message),
    );
    return () => ctl.abort();
  }, [view, isKinds, solve]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const read = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    read();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const fitBox = useCallback(
    (box: { x: number; y: number; w: number; h: number }, animate: boolean) => {
      const svg = svgRef.current;
      const z = zoomRef.current;
      if (!svg || !z || size.w === 0 || size.h === 0) return;
      const pad = 24;
      const k = Math.min(4, Math.max(0.03, Math.min((size.w - pad * 2) / box.w, (size.h - pad * 2) / box.h)));
      const tx = size.w / 2 - (box.x + box.w / 2) * k;
      const ty = size.h / 2 - (box.y + box.h / 2) * k;
      const t = zoomIdentity.translate(tx, ty).scale(k);
      const sel = select(svg);
      if (animate) sel.transition().duration(280).call(z.transform, t);
      else sel.call(z.transform, t);
    },
    [size.w, size.h],
  );

  // One d3-zoom behaviour per svg; it moves the inner group directly, so panning never re-renders the cards.
  useEffect(() => {
    const svg = svgRef.current;
    const g = gRef.current;
    if (!svg || !g) return;
    const z = zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.03, 4])
      .on("zoom", (ev) => {
        const t = ev.transform;
        g.setAttribute("transform", `translate(${t.x} ${t.y}) scale(${t.k})`);
      });
    zoomRef.current = z;
    select(svg).call(z).on("dblclick.zoom", null);
    return () => {
      select(svg).on(".zoom", null);
      zoomRef.current = null;
      fitted.current = null;
    };
  }, []);

  useEffect(() => {
    if (!layout || size.w === 0 || fitted.current === layout) return;
    fitted.current = layout;
    fitBox({ x: 0, y: 0, w: layout.width, h: layout.height }, false);
  }, [layout, size.w, size.h, fitBox]);

  const rowMids = useMemo(() => new Map(view.entities.map((e) => [e.id, cardMetrics(e).rowMid])), [view]);
  const refLabel = useCallback((id: string) => byId.get(id)?.label ?? id, [byId]);
  const linked = useMemo(() => {
    const s = new Set<string>();
    if (hot === null) return s;
    s.add(hot);
    for (const l of view.links) {
      if (l.from === hot) s.add(l.to);
      if (l.to === hot) s.add(l.from);
    }
    return s;
  }, [hot, view]);

  const pick = useCallback(
    (e: SchemaEntity) => {
      onPick?.({ ...(e.span ? { span: e.span } : {}), label: e.label });
    },
    [onPick],
  );

  /** Link geometry depends only on the layout and view, not on hover. */
  const geometry = useMemo(() => {
    if (!layout) return [];
    return view.links.flatMap((l, i) => {
      const a = layout.cards.get(l.from);
      const b = layout.cards.get(l.to);
      if (!a || !b) return [];
      let p;
      if (l.kind === "extends") p = extendsPath(a, b);
      else {
        const from = byId.get(l.from);
        const idx = from ? from.fields.findIndex((f) => f.name === l.field && f.ref === l.to) : -1;
        const mid = idx >= 0 ? (rowMids.get(l.from)?.[idx] ?? HEADER_H / 2) : HEADER_H / 2;
        p = refPath(a, mid, b);
      }
      return [{ i, from: l.from, to: l.to, kind: l.kind, d: p.d, head: p.head }];
    });
    // byId and rowMids are derived from view.
  }, [layout, view]); // eslint-disable-line react-hooks/exhaustive-deps

  const links = geometry.map((g) => {
    const on = hot !== null && (g.from === hot || g.to === hot);
    const cls = `sd-link ${g.kind}${hot === null ? "" : on ? " on" : " off"}`;
    return (
      <g key={g.i} className={cls}>
        <path className="sd-curve" d={g.d} />
        <path className={g.kind === "extends" ? "sd-head-ext" : "sd-head-ref"} d={g.head} />
      </g>
    );
  });

  return (
    <div className="sd-wrap" ref={wrapRef}>
      <div className="sd-tools">
        <span className="muted small">scroll to zoom, drag to pan{isKinds ? ", click a frame title to zoom to it (shift-click adds the last one)" : view.groups.length > 1 ? ", click a frame title to zoom to it" : ""}</span>
        <button type="button" onClick={() => layout && fitBox({ x: 0, y: 0, w: layout.width, h: layout.height }, true)}>
          Fit
        </button>
      </div>
      {error && <p className="error sd-msg" role="alert">{error}</p>}
      {!layout && !error && <p className="muted sd-msg">Laying out</p>}
      <svg ref={svgRef} className="sd-svg" width={size.w || "100%"} height={size.h || "100%"} role="group" aria-label={view.title}>
        <g ref={gRef}>
          {layout?.frames.map((f) => (
            <g key={f.id} className="sd-frame" data-frame={f.id} style={{ ["--g" as string]: groupColor(view, f.id) }}>
              <rect x={f.x} y={f.y} width={f.w} height={f.h} rx={16} className="sd-frame-box" />
              <text
                x={f.x + 18}
                y={f.y + 24}
                className="sd-frame-title"
                onClick={(ev) => {
                  // Shift-click adds the previously chosen frame, so two neighbouring frames can fill the view.
                  const other = ev.shiftKey ? layout.frames.find((x) => x.id === lastFrame.current) : undefined;
                  lastFrame.current = f.id;
                  const x0 = Math.min(f.x, other?.x ?? f.x);
                  const y0 = Math.min(f.y, other?.y ?? f.y);
                  const x1 = Math.max(f.x + f.w, other ? other.x + other.w : 0);
                  const y1 = Math.max(f.y + f.h, other ? other.y + other.h : 0);
                  fitBox({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, true);
                }}
              >
                {f.label}
                <tspan className="sd-frame-count" dx={8}>
                  {view.entities.filter((e) => e.group === f.id).length}
                </tspan>
              </text>
            </g>
          ))}
          <g>{links}</g>
          {layout &&
            view.entities.map((e) => {
              const box = layout.cards.get(e.id);
              if (!box) return null;
              const state = hot === null ? "normal" : e.id === hot ? "hot" : linked.has(e.id) ? "linked" : "dim";
              return <Card key={e.id} e={e} box={box} color={groupColor(view, e.group)} state={state} refLabel={refLabel} onHot={setHot} onPick={pick} />;
            })}
        </g>
      </svg>
    </div>
  );
}

