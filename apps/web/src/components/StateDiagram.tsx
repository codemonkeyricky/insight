import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactElement } from "react";
import type { Span, StateMachineTransition, StateMachineView } from "../api";
import { isAbort, layoutMachine, nearestArc, withTimeout, zoomBox, type LaidArc, type LaidMachine, type LaidState, type Solve } from "../states/layout";
import { solveInWorker } from "../states/elkClient";

/** What a click on the diagram reports: the first source line of an arc, or the line of a state. */
export interface MachinePick {
  span?: Span;
  label: string;
  transition?: StateMachineTransition;
}

export interface MachineSvgProps {
  view: StateMachineView;
  laid: LaidMachine;
  /** The state or transition id under the pointer or focus. */
  hot?: string | null;
  /** The transition last picked. */
  selected?: string | null;
  viewBox?: string;
  /** Rendered size in px. Without it the drawing fills its container. */
  size?: { width: number; height: number };
  onHot?: (id: string | null) => void;
  onPick?: (pick: MachinePick) => void;
}

const activate = (fn: () => void) => (e: KeyboardEvent) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    fn();
  }
};

/** The words an arc is announced with, for example "Disconnected to Connecting, start, inferred". */
export function arcName(view: StateMachineView, t: StateMachineTransition): string {
  const name = (id: string) => {
    const s = view.states.find((x) => x.id === id);
    return s ? (s.kind === "initial" ? "start" : s.kind === "any" ? "any state" : s.label) : id;
  };
  return `${name(t.from)} to ${name(t.to)}${t.label ? `, ${t.label}` : ""}, ${t.confidence}`;
}

/** The tooltip of an arc: its name, then every site as `function file:line` (the full location of a lambda). */
export function arcTitle(view: StateMachineView, t: StateMachineTransition): string {
  const sites = t.sites.map((x) => `${x.fn ?? ""}${x.fn && x.span ? " " : ""}${x.span ? `${x.span.file}:${x.span.start[0] + 1}` : ""}`.trim()).filter(Boolean);
  return sites.length > 0 ? `${arcName(view, t)}\n${sites.join("\n")}` : arcName(view, t);
}

/** The smallest scale the diagram is fitted to. Below it the canvas scrolls instead of shrinking. */
export const MIN_SCALE = 0.6;

/** Fit scale for a diagram of `w` by `h` in a pane `pane` px wide: never above 1, never below MIN_SCALE, and no taller than `maxH`. */
export function fitScale(w: number, h: number, pane: number, maxH: number): number {
  if (w <= 0 || h <= 0 || pane <= 0) return 1;
  return Math.max(MIN_SCALE, Math.min(1, pane / w, maxH / h));
}

function StateShape({ s }: { s: LaidState }): ReactElement {
  if (s.kind === "initial") return <circle className="sm-start" cx={s.x + s.w / 2} cy={s.y + s.h / 2} r={s.w / 2} />;
  const cx = s.x + s.w / 2;
  const cy = s.y + s.h / 2;
  return (
    <>
      <rect className="sm-box" x={s.x} y={s.y} width={s.w} height={s.h} rx={s.kind === "any" ? s.h / 2 : 10} />
      {s.terminal && <rect className="sm-box sm-box--inner" x={s.x + 4} y={s.y + 4} width={s.w - 8} height={s.h - 8} rx={7} />}
      <text className="sm-name" x={cx} y={cy} textAnchor="middle" dominantBaseline="central">
        {s.kind === "any" ? "any state" : s.label}
      </text>
    </>
  );
}

/** The drawing alone: no hooks, so tests can walk the element tree. */
export function MachineSvg({ view, laid, hot = null, selected = null, viewBox, size, onHot, onPick }: MachineSvgProps): ReactElement {
  const byTransition = new Map(view.transitions.map((t) => [t.id, t]));
  const byState = new Map(view.states.map((s) => [s.id, s]));
  const hotArc = (a: LaidArc) => hot !== null && (a.id === hot || a.from === hot || a.to === hot);
  const anyHot = hot !== null;
  return (
    <svg
      className={`sm-svg${anyHot ? " sm-svg--hot" : ""}`}
      viewBox={viewBox ?? `0 0 ${laid.width} ${laid.height}`}
      {...(size ? { width: size.width, height: size.height, style: { width: size.width, height: size.height, maxHeight: "none" } } : {})}
      preserveAspectRatio="xMidYMid meet"
      role="group"
      aria-label={`State diagram of ${view.holder.name}`}
    >
      <g className="sm-arcs">
        {laid.arcs.map((a) => {
          // A layout of another view (the view changed and the new layout is not ready) has arcs this view lacks: skip them.
          const t = byTransition.get(a.id);
          if (!t) return null;
          const pickOf = (x: StateMachineTransition) => onPick?.({ ...(x.sites[0]?.span ? { span: x.sites[0].span } : {}), label: arcName(view, x), transition: x });
          const pick = () => pickOf(t);
          // Two lines can sit under one pointer (a crossing, parallel runs): the line nearest the pointer is the one meant.
          const nearOf = (e?: MouseEvent<SVGGElement>): LaidArc | undefined => {
            const svg = e?.currentTarget.ownerSVGElement;
            const ctm = svg?.getScreenCTM();
            if (!e || !svg || !ctm || (e.target as Element).closest?.(".sm-label")) return undefined;
            const pt = svg.createSVGPoint();
            pt.x = e.clientX;
            pt.y = e.clientY;
            const p = pt.matrixTransform(ctm.inverse());
            return nearestArc(laid.arcs, p.x, p.y);
          };
          const click = (e?: MouseEvent<SVGGElement>) => {
            const near = nearOf(e);
            const other = near && near.id !== a.id ? byTransition.get(near.id) : undefined;
            if (other) return pickOf(other);
            pick();
          };
          // Hover follows the same nearest line, not the DOM order of the lines under the pointer.
          const hover = (e: MouseEvent<SVGGElement>) => onHot?.(nearOf(e)?.id ?? a.id);
          const cls = ["sm-arc", `sm-arc--${t.confidence}`, hotArc(a) ? "sm-arc--hot" : "", selected === a.id ? "sm-arc--selected" : ""].filter(Boolean).join(" ");
          return (
            <g
              key={a.id}
              className={cls}
              tabIndex={0}
              role="button"
              aria-label={arcName(view, t)}
              onClick={click}
              onKeyDown={activate(pick)}
              onMouseEnter={hover}
              onMouseMove={hover}
              onMouseLeave={() => onHot?.(null)}
              onFocus={() => onHot?.(a.id)}
              onBlur={() => onHot?.(null)}
            >
              <title>{arcTitle(view, t)}</title>
              <path className="sm-hit" d={a.d} />
              <path className="sm-line" d={a.d} />
              <path className="sm-head" d={a.arrow} />
              {a.label && (
                <g className="sm-label">
                  <rect x={a.label.x} y={a.label.y} width={a.label.w} height={a.label.h} rx={a.label.h / 2} />
                  <text x={a.label.x + a.label.w / 2} y={a.label.y + a.label.h / 2} textAnchor="middle" dominantBaseline="central">
                    {a.label.text}
                  </text>
                </g>
              )}
            </g>
          );
        })}
      </g>
      <g className="sm-states">
        {laid.states.map((s) => {
          const st = byState.get(s.id);
          const pick = () => onPick?.({ ...(st?.span ? { span: st.span } : {}), label: s.label });
          const cls = ["sm-state", `sm-state--${s.kind}`, s.terminal ? "sm-state--terminal" : "", hot === s.id ? "sm-state--hot" : ""].filter(Boolean).join(" ");
          return (
            <g
              key={s.id}
              className={cls}
              tabIndex={0}
              role="button"
              aria-label={s.kind === "initial" ? "Start" : s.kind === "any" ? "Any state" : `${s.label}${s.kind === "unentered" ? ", never entered" : s.terminal ? ", final" : ""}`}
              onClick={pick}
              onKeyDown={activate(pick)}
              onMouseEnter={() => onHot?.(s.id)}
              onMouseLeave={() => onHot?.(null)}
              onFocus={() => onHot?.(s.id)}
              onBlur={() => onHot?.(null)}
            >
              <StateShape s={s} />
            </g>
          );
        })}
      </g>
    </svg>
  );
}

export function Legend({ view }: { view: StateMachineView }): ReactElement {
  const kinds = new Set(view.transitions.map((t) => t.confidence));
  const line = (cls: string) => (
    <svg width="34" height="10" aria-hidden="true">
      <line className={`sm-key sm-key--${cls}`} x1="1" y1="5" x2="33" y2="5" />
    </svg>
  );
  return (
    <ul className="sm-legend" aria-label="Legend">
      <li>{line("exact")} exact write</li>
      {kinds.has("inferred") && <li>{line("inferred")} dashed = inferred: written after an await, or start state taken from the callers</li>}
      {kinds.has("heuristic") && <li>{line("heuristic")} heuristic</li>}
      {view.states.some((s) => s.kind === "unentered") && <li><span className="sm-swatch sm-swatch--unentered" aria-hidden="true" /> never entered</li>}
      <li><span className="sm-swatch sm-swatch--terminal" aria-hidden="true" /> no way out</li>
    </ul>
  );
}

export interface StateDiagramProps {
  view: StateMachineView;
  onPick?: (pick: MachinePick) => void;
  selected?: string | null;
  /** The solver; the page uses the elkjs worker. */
  solve?: Solve;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Starts laying `view` out. The returned function cancels it: the solver's job is aborted and neither callback fires.
 * An AbortError (a job given up on) is never reported as a failure.
 */
export function startLayout(view: StateMachineView, solve: Solve, cb: { done: (l: LaidMachine) => void; fail: (message: string) => void }): () => void {
  let cancelled = false;
  const ctl = new AbortController();
  layoutMachine(view, solve === solveInWorker ? solve : withTimeout(solve), ctl.signal).then(
    (l) => {
      if (!cancelled) cb.done(l);
    },
    (e: Error) => {
      if (!cancelled && !isAbort(e)) cb.fail(e.message);
    },
  );
  return () => {
    cancelled = true;
    ctl.abort();
  };
}

/** One machine, laid out with elkjs and drawn as SVG. Zoom-to-fit by default; drag to pan, ctrl+wheel to zoom. */
export function StateDiagram({ view, onPick, selected = null, solve = solveInWorker }: StateDiagramProps): ReactElement {
  // The layout is kept with the view it was made for: for one render after `view` changes it still belongs to the old view.
  const [laidFor, setLaid] = useState<{ view: StateMachineView; laid: LaidMachine } | null>(null);
  const laid = laidFor && laidFor.view === view ? laidFor.laid : null;
  const [failed, setFailed] = useState<string | null>(null);
  const [hot, setHot] = useState<string | null>(null);
  const [box, setBox] = useState<Box | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const [pane, setPane] = useState<number | null>(null);
  const drag = useRef<{ x: number; y: number; box: Box | null; left: number; top: number } | null>(null);

  useEffect(() => {
    setLaid(null);
    setFailed(null);
    setBox(null);
    return startLayout(view, solve, {
      done: (l) => setLaid({ view, laid: l }),
      fail: (m) => setFailed(m),
    });
  }, [view, solve]);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const read = () => setPane(el.clientWidth);
    read();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [laid]);

  const fit: Box | null = useMemo(() => (laid ? { x: 0, y: 0, w: laid.width, h: laid.height } : null), [laid]);
  const current = box ?? fit;

  useEffect(() => {
    const el = wrap.current;
    if (!el || !fit) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const r = (el.querySelector("svg") ?? el).getBoundingClientRect();
      setBox((b) => zoomBox(b ?? fit, fit, r, e.clientX, e.clientY, e.deltaY));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [fit]);

  if (failed) return <p className="error" role="alert">The diagram could not be laid out: {failed}</p>;
  if (!laid || !current) return <p className="muted small" role="status">Laying out the diagram</p>;

  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    const el = wrap.current;
    if (!d || !el) return;
    if (d.box === null) {
      // Fitted but wider than the pane: the canvas scrolls.
      el.scrollLeft = d.left - (e.clientX - d.x);
      el.scrollTop = d.top - (e.clientY - d.y);
      return;
    }
    const svgW = el.querySelector("svg")?.getBoundingClientRect().width ?? el.getBoundingClientRect().width;
    const scale = d.box.w / svgW;
    setBox({ ...d.box, x: d.box.x - (e.clientX - d.x) * scale, y: d.box.y - (e.clientY - d.y) * scale });
  };

  const scale = pane !== null ? fitScale(laid.width, laid.height, pane, Math.max(300, (typeof window === "undefined" ? 900 : window.innerHeight) * 0.82)) : null;
  const size = scale !== null ? { width: Math.round(laid.width * scale), height: Math.round(laid.height * scale) } : null;

  return (
    <div className="state-diagram">
      <div className="sm-tools">
        <button type="button" className="sm-tool" onClick={() => setBox(null)} disabled={box === null} aria-label="Fit the diagram">Fit</button>
        <span className="muted small">Drag to pan, Ctrl+wheel to zoom</span>
      </div>
      <div
        ref={wrap}
        className="sm-wrap"
        onPointerDown={(e) => {
          if ((e.target as Element).closest(".sm-arc, .sm-state")) return;
          drag.current = { x: e.clientX, y: e.clientY, box, left: e.currentTarget.scrollLeft, top: e.currentTarget.scrollTop };
          (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
        }}
        onPointerMove={move}
        onPointerUp={() => (drag.current = null)}
        onPointerCancel={() => (drag.current = null)}
      >
        <MachineSvg view={view} laid={laid} hot={hot} selected={selected} {...(size ? { size } : {})} viewBox={`${current.x} ${current.y} ${current.w} ${current.h}`} onHot={setHot} {...(onPick ? { onPick } : {})} />
      </div>
      <Legend view={view} />
    </div>
  );
}
