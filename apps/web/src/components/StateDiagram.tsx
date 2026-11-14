import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactElement } from "react";
import type { Span, StateMachineTransition, StateMachineView } from "../api";
import { layoutMachine, type LaidArc, type LaidMachine, type LaidState, type Solve } from "../states/layout";
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
export function MachineSvg({ view, laid, hot = null, selected = null, viewBox, onHot, onPick }: MachineSvgProps): ReactElement {
  const byTransition = new Map(view.transitions.map((t) => [t.id, t]));
  const byState = new Map(view.states.map((s) => [s.id, s]));
  const hotArc = (a: LaidArc) => hot !== null && (a.id === hot || a.from === hot || a.to === hot);
  const anyHot = hot !== null;
  return (
    <svg
      className={`sm-svg${anyHot ? " sm-svg--hot" : ""}`}
      viewBox={viewBox ?? `0 0 ${laid.width} ${laid.height}`}
      preserveAspectRatio="xMidYMid meet"
      role="group"
      aria-label={`State diagram of ${view.holder.name}`}
    >
      <g className="sm-arcs">
        {laid.arcs.map((a) => {
          const t = byTransition.get(a.id) as StateMachineTransition;
          const pick = () => onPick?.({ ...(t.sites[0]?.span ? { span: t.sites[0].span } : {}), label: arcName(view, t), transition: t });
          const cls = ["sm-arc", `sm-arc--${t.confidence}`, hotArc(a) ? "sm-arc--hot" : "", selected === a.id ? "sm-arc--selected" : ""].filter(Boolean).join(" ");
          return (
            <g
              key={a.id}
              className={cls}
              tabIndex={0}
              role="button"
              aria-label={arcName(view, t)}
              onClick={pick}
              onKeyDown={activate(pick)}
              onMouseEnter={() => onHot?.(a.id)}
              onMouseLeave={() => onHot?.(null)}
              onFocus={() => onHot?.(a.id)}
              onBlur={() => onHot?.(null)}
            >
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
      {kinds.has("inferred") && <li>{line("inferred")} inferred through a caller</li>}
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

/** One machine, laid out with elkjs and drawn as SVG. Zoom-to-fit by default; drag to pan, ctrl+wheel to zoom. */
export function StateDiagram({ view, onPick, selected = null, solve = solveInWorker }: StateDiagramProps): ReactElement {
  const [laid, setLaid] = useState<LaidMachine | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [hot, setHot] = useState<string | null>(null);
  const [box, setBox] = useState<Box | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; box: Box } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLaid(null);
    setFailed(null);
    setBox(null);
    layoutMachine(view, solve).then(
      (l) => {
        if (!cancelled) setLaid(l);
      },
      (e: Error) => {
        if (!cancelled) setFailed(e.message);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [view, solve]);

  const fit: Box | null = useMemo(() => (laid ? { x: 0, y: 0, w: laid.width, h: laid.height } : null), [laid]);
  const current = box ?? fit;

  useEffect(() => {
    const el = wrap.current;
    if (!el || !fit) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      setBox((b) => {
        const c = b ?? fit;
        const k = Math.min(4, Math.max(0.25, e.deltaY > 0 ? 1.12 : 1 / 1.12));
        const w = Math.min(fit.w * 4, Math.max(fit.w / 6, c.w * k));
        const h = (w / c.w) * c.h;
        const px = c.x + ((e.clientX - r.left) / r.width) * c.w;
        const py = c.y + ((e.clientY - r.top) / r.height) * c.h;
        return { x: px - ((px - c.x) / c.w) * w, y: py - ((py - c.y) / c.h) * h, w, h };
      });
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
    const r = el.getBoundingClientRect();
    const scale = d.box.w / r.width;
    setBox({ ...d.box, x: d.box.x - (e.clientX - d.x) * scale, y: d.box.y - (e.clientY - d.y) * scale });
  };

  return (
    <div className="state-diagram">
      <div className="sm-tools">
        <button type="button" className="sm-tool" onClick={() => setBox(null)} disabled={box === null} aria-label="Fit the diagram">Fit</button>
        <span className="muted small">Drag to pan, Ctrl+wheel to zoom</span>
      </div>
      <div
        ref={wrap}
        className="sm-wrap"
        style={{ maxWidth: Math.round(laid.width * 1.3) }}
        onPointerDown={(e) => {
          if ((e.target as Element).closest(".sm-arc, .sm-state")) return;
          drag.current = { x: e.clientX, y: e.clientY, box: current };
          (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
        }}
        onPointerMove={move}
        onPointerUp={() => (drag.current = null)}
        onPointerCancel={() => (drag.current = null)}
      >
        <MachineSvg view={view} laid={laid} hot={hot} selected={selected} viewBox={`${current.x} ${current.y} ${current.w} ${current.h}`} onHot={setHot} {...(onPick ? { onPick } : {})} />
      </div>
      <Legend view={view} />
    </div>
  );
}
