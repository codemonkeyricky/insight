import { useEffect, useId, useMemo, useRef, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import type { FlowEdge, FlowNode, FunctionFlow } from "../api";
import { outsideScope, outsideText } from "../flowTargets";
import { LANE_W, NEST_HEAD, ROW_H, stationOf } from "@insight/flow";
import { hrefFile, hrefView } from "../router";
import { backEdgeFlags, prefersReducedMotion, useOnScreen, usePageVisible } from "../zoom/flowMotion";
import { runFlowToken, useTokenSlot } from "../zoom/flowToken";
import { popDelay } from "../zoom/pop";

/** A step's click, when a caller takes it over. Return true to handle it: the link (if any) is then not followed. */
export type FlowNodeClick = (node: FlowNode) => boolean;

/** Opens or folds a step (a double-click, Enter or Space on the row, or a click on its chevron). Return true when the step took it. */
export type FlowNodeOpen = (node: FlowNode) => boolean;

/** The chevron's hit target: at least 20 px square, around the glyph, at the right end of the row. */
const CHEV_HIT = 24;
const CHEV_INSET = 6;

/**
 * One function's control-flow chart as SVG, drawn as a line map: one row per step, a station on its lane's line, the label
 * to the right. The rows and edge paths come from the layout in @insight/flow; this only draws them. A call into a function
 * in scope links to that function's chart. A call outside the scope is drawn unresolved. Any other step with a source span
 * links to its line. `onNodeClick` takes over the clicks (the zoom map does, so a click selects in place); `onNodeOpen` takes
 * the gestures that open or fold a step (double-click, Enter or Space, a click on the ▸/▾ chevron); `selectedId` marks one step. `motion` (default on) makes a token walk the chart's control
 * flow along the edge paths (see zoom/flowToken.ts). Motion is off under reduced motion, while the page is hidden, and
 * while the chart is off screen (see zoom/flowMotion.ts). The token runs on the most recently opened charts only.
 */
export function FlowChart({ id, fn, scope, onNodeClick, onNodeOpen, selectedId, motion = true }: { id: string; fn: FunctionFlow; scope: string; onNodeClick?: FlowNodeClick; onNodeOpen?: FlowNodeOpen; selectedId?: string; motion?: boolean }) {
  const uid = useId();
  const key = uid.replace(/[^a-zA-Z0-9]/g, "");
  const glow = `glow-${key}`;
  const ref = useRef<SVGSVGElement>(null);
  const tokenRef = useRef<SVGGElement>(null);
  const onScreen = useOnScreen(ref);
  const visible = usePageVisible();
  const reduced = prefersReducedMotion();
  const on = motion && visible && onScreen && !reduced;
  const back = useMemo(() => backEdgeFlags(fn.nodes, fn.edges), [fn]);
  const tokenActive = useTokenSlot(uid, on && fn.edges.length > 0);
  // The cascade when a chart opens: rows rise in reading order (y, then x), each edge draws on after its source row.
  const nodeDelay = useMemo(() => {
    const order = fn.nodes.slice().sort((a, b) => a.y - b.y || a.x - b.x);
    return new Map(order.map((n, i) => [n.id, 140 + popDelay(i, 240, 10)] as const));
  }, [fn]);
  useEffect(() => {
    const svg = ref.current;
    const tok = tokenRef.current;
    if (!tokenActive || !svg || !tok) return;
    return runFlowToken(svg, tok, fn);
  }, [tokenActive, fn]);
  const arrowId = (lane: number) => `arrow-${key}-${lane}`;
  return (
    <svg ref={ref} className="flow" width={fn.width} height={fn.height} viewBox={`0 0 ${fn.width} ${fn.height}`} role="img" aria-label={`Control flow of ${fn.name}`}>
      <defs>
        {LANES.map((l) => (
          <marker key={l} id={arrowId(l)} viewBox="0 0 8 8" refX="6" refY="4" markerWidth="8" markerHeight="8" orient="auto" markerUnits="userSpaceOnUse">
            <path d="M0 0L8 4L0 8Z" className={`flow-arrow c${l}`} />
          </marker>
        ))}
      </defs>
      <g>
        {fn.nodes.filter((n) => n.line?.band !== undefined).map((n) => (
          <rect key={`band-${n.id}`} x={n.line!.band!.x} y={n.line!.band!.y} width={n.line!.band!.w} height={n.line!.band!.h} rx={10} className={`flow-band c${laneOf(n.lane)}`} data-band={n.id} style={delayStyle(nodeDelay.get(n.id) ?? 140)} />
        ))}
        {fn.nodes.filter(isNest).map((n) => (
          <NestFrame key={n.id} node={n} onNodeClick={onNodeClick} onNodeOpen={onNodeOpen} selected={n.id === selectedId} delay={nodeDelay.get(n.id) ?? 140} />
        ))}
      </g>
      <g>
        {fn.edges.map((e, i) => (
          <Edge key={`${e.from}>${e.to}>${i}`} edge={e} index={i} arrow={arrowId} back={back[i] === true} delay={(nodeDelay.get(e.from) ?? 140) + 80} />
        ))}
      </g>
      <g>
        {fn.nodes.filter((n) => !isNest(n)).map((n) => (
          <Node key={n.id} id={id} node={n} fnId={fn.id} scope={scope} width={fn.width} onNodeClick={onNodeClick} onNodeOpen={onNodeOpen} selected={n.id === selectedId} delay={nodeDelay.get(n.id) ?? 140} />
        ))}
      </g>
      {tokenActive && (
        <g ref={tokenRef} className="flow-token" aria-hidden="true">
          <radialGradient id={glow}>
            <stop className="flow-glow-in" offset="0" />
            <stop className="flow-glow-out" offset="1" />
          </radialGradient>
          <circle r={8} fill={`url(#${glow})`} />
          <circle r={4} className="flow-token-dot" />
        </g>
      )}
    </svg>
  );
}

const LANES = [0, 1, 2, 3, 4];
const laneOf = (n: number | undefined): number => (n ?? 0) % 5;
const delayStyle = (ms: number) => ({ ["--d" as string]: `${ms}ms` });

const isNest = (n: FlowNode): boolean => n.shape === "nest";

/** Double-click and Enter/Space on a row open or fold it. A step the handler declines is left to its link or click. */
function openHandlers(node: FlowNode, onNodeOpen: FlowNodeOpen | undefined) {
  if (!onNodeOpen) return {};
  return {
    onDoubleClick: (e: MouseEvent<Element>) => {
      if (onNodeOpen(node)) e.preventDefault();
    },
    onKeyDown: (e: KeyboardEvent<Element>) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      if (e.target !== e.currentTarget) return;
      if (onNodeOpen(node)) e.preventDefault();
    },
  };
}

/** The ▸/▾ at the right end of a row, with its own hit target (the touch path). It opens or folds without selecting. */
function Chevron({ node, x, y, fold, onNodeOpen }: { node: FlowNode; x: number; y: number; fold: boolean; onNodeOpen?: FlowNodeOpen }) {
  const cy = y + ROW_H / 2;
  return (
    <g
      className="flow-chevron"
      role="button"
      aria-label={`${fold ? "Fold" : "Open"} ${node.label}`}
      onClick={(e) => {
        e.stopPropagation();
        e.preventDefault();
        onNodeOpen?.(node);
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        e.preventDefault();
      }}
    >
      <rect x={x - CHEV_HIT / 2} y={cy - CHEV_HIT / 2} width={CHEV_HIT} height={CHEV_HIT} rx={6} className="flow-chevron-hit" />
      <text x={x} y={cy} dominantBaseline="central" textAnchor="middle" className="flow-chev">
        {fold ? "▾" : "▸"}
      </text>
    </g>
  );
}

/** Where a row's station sits. A chart exported before the line map has no lanes: its steps sit on lane 0. */
const station = (n: FlowNode): [number, number] => stationOf(n);
const labelAt = (n: FlowNode): number => n.labelX ?? n.x + 28;

/** The faint word before a step's label, by role. A label that already starts with it is left alone. */
const KEYWORD: Partial<Record<FlowNode["role"], string>> = { branch: "if", switch: "switch", effect: "io", await: "await", spawn: "spawn", call: "call" };
const keywordOf = (n: FlowNode): string | undefined => {
  const kw = KEYWORD[n.role];
  return kw === undefined || n.label === kw || n.label.startsWith(`${kw} `) || n.label.startsWith(`${kw}(`) ? undefined : kw;
};

/**
 * A callee nested in the call step that calls it: a faint band of its body's lane colour with the call's row as the header
 * (a call station, the label, a fold mark). Its rows and edges are drawn over the band by the chart. A click on the header
 * selects it; a double-click, Enter or Space on it, or a click on the fold mark, folds the callee back.
 */
function NestFrame({ node, onNodeClick, onNodeOpen, selected, delay }: { node: FlowNode; onNodeClick?: FlowNodeClick; onNodeOpen?: FlowNodeOpen; selected: boolean; delay: number }) {
  const { x, y, w, h } = node;
  const lane = laneOf((node.lane ?? 0) + 1);
  const lc = laneOf(node.lane);
  const [cx, cy] = station(node);
  return (
    <g className={`flow-nest c${lc}${selected ? " selected" : ""}`} data-node={node.id} data-nest="" style={delayStyle(delay)}>
      <title>{node.title ?? node.label}</title>
      <rect x={x} y={y} width={w} height={h} rx={10} className={`flow-nest-body c${lane}`} />
      <g
        className="flow-nest-head"
        role="group"
        aria-label={node.label}
        tabIndex={onNodeOpen ? 0 : undefined}
        onClick={onNodeClick ? () => onNodeClick(node) : undefined}
        {...openHandlers(node, onNodeOpen)}
      >
        <rect x={x} y={y} width={w} height={NEST_HEAD} rx={10} className="flow-nest-hit" />
        <CallStation cx={cx} cy={cy} />
        <text x={labelAt(node)} y={cy} dominantBaseline="central" className="flow-text flow-nest-label">
          {node.tag !== undefined && <tspan className="flow-kw">{node.tag} </tspan>}
          {node.label}
        </text>
        <Chevron node={node} x={x + w - CHEV_INSET - CHEV_HIT / 2} y={y} fold onNodeOpen={onNodeOpen} />
      </g>
    </g>
  );
}

/** One edge as a single path, drawn from the layout's `d` (or its points on a chart exported before the line map). */
function Edge({ edge, index, arrow, back, delay }: { edge: FlowEdge; index: number; arrow: (lane: number) => string; back: boolean; delay: number }) {
  const style = back || edge.style === "back" || edge.kind === "back" ? "back" : (edge.style ?? (edge.kind === "exception" ? "throws" : "solid"));
  const lane = laneOf(edge.lane);
  const d = edge.d ?? edge.points.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x} ${y}`).join(" ");
  const isBack = style === "back";
  return (
    <path
      d={d}
      className={`flow-edge ${style} c${lane}${isBack ? " back-edge" : ""}`}
      data-edge={index}
      style={delayStyle(delay)}
      pathLength={style === "solid" ? 1 : undefined}
      markerEnd={isBack ? `url(#${arrow(lane)})` : undefined}
    />
  );
}

/** The call station, the "interchange": a ring with a core dot. */
function CallStation({ cx, cy, open = true }: { cx: number; cy: number; open?: boolean }) {
  return (
    <g className="flow-station">
      <circle cx={cx} cy={cy} r={5.5} className={`st ring${open ? "" : " dashed"}`} />
      <circle cx={cx} cy={cy} r={1.9} className="core" />
    </g>
  );
}

/** The station mark of a step, by its shape and role. */
function Station({ node, cx, cy, resolved }: { node: FlowNode; cx: number; cy: number; resolved: boolean }): ReactNode {
  const { shape, role } = node;
  if (shape === "fork" && node.fork !== undefined) {
    // The fork bar: from the spawning row's station across to the new line's lane. A process is a double bar.
    const w = (node.fork.to - (node.lane ?? 0)) * LANE_W + 10;
    if (node.fork.kind === "process") return <path className="st dbar" d={`M${cx - 4} ${cy - 3}H${cx - 4 + w - 2}M${cx - 4} ${cy + 3}H${cx - 4 + w - 2}`} />;
    return <rect className="st bar" x={cx - 5} y={cy - 3.5} width={w} height={7} rx={3.5} />;
  }
  if (shape === "line") {
    // The header of a parallel line: a square for a process, a round dot for a thread.
    return node.line?.kind === "process" ? <rect className="st head" x={cx - 5.5} y={cy - 5.5} width={11} height={11} rx={2.5} /> : <circle className="st head" cx={cx} cy={cy} r={5} />;
  }
  if (shape === "exit") return <rect className="st exit" x={cx - 7} y={cy - 3} width={14} height={6} rx={3} />;
  if (shape === "loop") return <circle className="st loop" cx={cx} cy={cy} r={5} />;
  if (shape === "decision") return <path className="st diamond" d={`M${cx} ${cy - 6}L${cx + 6} ${cy}L${cx} ${cy + 6}L${cx - 6} ${cy}Z`} />;
  if (role === "start") return <circle className="st start" cx={cx} cy={cy} r={6} />;
  if (role === "end") {
    return (
      <g className="flow-station">
        <circle className="st endring" cx={cx} cy={cy} r={8} />
        <circle className="st end" cx={cx} cy={cy} r={4} />
      </g>
    );
  }
  if (role === "call") return <CallStation cx={cx} cy={cy} open={resolved || node.target === undefined} />;
  if (role === "effect") return <rect className="st effect" x={cx - 3.5} y={cy - 3.5} width={7} height={7} rx={1.5} />;
  if (shape === "label") return <path className="st tick" d={`M${cx - 4} ${cy}H${cx + 4}`} />;
  return <circle className="st step" cx={cx} cy={cy} r={3.5} />;
}

function Node({ id, node, fnId, scope, width, onNodeClick, onNodeOpen, selected, delay }: { id: string; node: FlowNode; fnId: string; scope: string; width: number; onNodeClick?: FlowNodeClick; onNodeOpen?: FlowNodeOpen; selected: boolean; delay: number }) {
  const { shape } = node;
  const [cx, cy] = station(node);
  const target = node.target;
  const outside = target !== undefined && outsideScope(target, scope);
  const inside = (target !== undefined && !outside && target !== fnId) || shape === "fork";
  const kw = keywordOf(node);
  const body = (
    <>
      <title>{outside && target !== undefined ? outsideText(target) : (node.title ?? node.label)}</title>
      <rect x={4} y={node.y} width={Math.max(0, width - 8)} height={ROW_H} rx={7} className="flow-hit" />
      <Station node={node} cx={cx} cy={cy} resolved={!outside} />
      <text x={labelAt(node)} y={cy} dominantBaseline="central" className="flow-text">
        {node.tag !== undefined && <tspan className="flow-kw">{node.tag} </tspan>}
        {kw !== undefined && <tspan className="flow-kw">{kw} </tspan>}
        {node.label}
        {outside && <tspan className="flow-mark">{" ↗"}</tspan>}
      </text>
      {inside && <Chevron node={node} x={width - 4 - CHEV_INSET - CHEV_HIT / 2} y={node.y} fold={shape === "fork"} onNodeOpen={onNodeOpen} />}
    </>
  );
  const cls = `flow-node ${shape} role-${node.role} c${laneOf(node.lane)}${outside ? " unresolved" : ""}${inside ? " resolves" : ""}${selected ? " selected" : ""}`;
  const style = delayStyle(delay);
  // A call into this scope opens the callee's chart; every other step with a span opens its source line.
  const link = inside && target !== undefined ? hrefView(id, "flow", { scope, fn: target }) : node.span ? hrefFile(id, node.span.file, node.span.start[0] + 1) : undefined;
  const onClick = onNodeClick
    ? (e: MouseEvent<Element>) => {
        if (onNodeClick(node)) e.preventDefault();
      }
    : undefined;
  const open = { ...openHandlers(node, onNodeOpen), tabIndex: onNodeOpen && inside ? 0 : undefined };
  return link ? (
    <a href={link} className={cls} style={style} onClick={onClick} data-node={node.id} {...open}>
      {body}
    </a>
  ) : (
    <g className={cls} style={style} onClick={onClick} data-node={node.id} {...open}>
      {body}
    </g>
  );
}
