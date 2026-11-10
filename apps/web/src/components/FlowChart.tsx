import { useId, useMemo, useRef, type MouseEvent, type ReactNode } from "react";
import type { FlowEdge, FlowNode, FunctionFlow } from "../api";
import { outsideScope, outsideText } from "../flowTargets";
import { hrefFile, hrefView } from "../router";
import { backEdgeFlags, edgeMotions, prefersReducedMotion, PULSE_S, useMarchBudget, useOnScreen, usePageVisible, type EdgeMotion } from "../zoom/flowMotion";

/** A step's click, when a caller takes it over. Return true to handle it: the link (if any) is then not followed. */
export type FlowNodeClick = (node: FlowNode) => boolean;

/**
 * One function's control-flow chart as SVG. The boxes and edge points come from the layout in
 * @insight/flow; this only draws them. A call into a function in scope links to that function's chart.
 * A call outside the scope is drawn unresolved. Any other step with a source span links to its line.
 * `onNodeClick` takes over the clicks (the zoom map does, so a click selects in place); `selectedId` marks one step.
 * `motion` (default on) makes each edge march in its direction, and a back-edge (a loop's return) also carries a pulse. It
 * is off under reduced motion, while the page is hidden, and while the chart is off screen (see zoom/flowMotion.ts).
 */
export function FlowChart({ id, fn, scope, onNodeClick, selectedId, motion = true }: { id: string; fn: FunctionFlow; scope: string; onNodeClick?: FlowNodeClick; selectedId?: string; motion?: boolean }) {
  const uid = useId();
  const arrow = `arrow-${uid.replace(/[^a-zA-Z0-9]/g, "")}`;
  const ref = useRef<SVGSVGElement>(null);
  const onScreen = useOnScreen(ref);
  const visible = usePageVisible();
  const reduced = prefersReducedMotion();
  const on = motion && visible && onScreen && !reduced;
  const back = useMemo(() => backEdgeFlags(fn.nodes, fn.edges), [fn]);
  const budget = useMarchBudget(uid, fn.edges.length, on);
  const motions = useMemo(() => edgeMotions(back, { on, reduced, budget }), [back, on, reduced, budget]);
  return (
    <svg ref={ref} className="flow" width={fn.width} height={fn.height} viewBox={`0 0 ${fn.width} ${fn.height}`} role="img" aria-label={`Control flow of ${fn.name}`}>
      <defs>
        <marker id={arrow} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
          <path d="M0,0 L10,5 L0,10 z" className="flow-arrow" />
        </marker>
      </defs>
      <g>
        {fn.edges.map((e, i) => (
          <Edge key={`${e.from}>${e.to}>${i}`} edge={e} marker={arrow} motion={motions[i] ?? NO_MOTION} back={back[i] === true} />
        ))}
      </g>
      <g>
        {fn.nodes.map((n) => (
          <Node key={n.id} id={id} node={n} fnId={fn.id} scope={scope} onNodeClick={onNodeClick} selected={n.id === selectedId} />
        ))}
      </g>
    </svg>
  );
}

const NO_MOTION: EdgeMotion = { march: false, pulse: false };

/**
 * One edge: its solid path with the arrow, then (when it moves) a dashed overlay that marches along the same path in its
 * direction, and on a back-edge a dot that travels the path every PULSE_S. The overlay sits on top of the solid line.
 */
function Edge({ edge, marker, motion, back }: { edge: FlowEdge; marker: string; motion: EdgeMotion; back: boolean }) {
  const d = edge.points.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x} ${y}`).join(" ");
  return (
    <g className={`flow-edge ${edge.kind}${back ? " back-edge" : ""}`}>
      <path d={d} markerEnd={`url(#${marker})`} />
      {motion.march && <path d={d} className={`flow-march${back ? " back" : ""}`} />}
      {motion.pulse && (
        <circle r={2.6} className="flow-pulse">
          <animateMotion dur={`${PULSE_S}s`} repeatCount="indefinite" path={d} />
        </circle>
      )}
      {edge.label && edge.labelAt && (
        <text x={edge.labelAt[0]} y={edge.labelAt[1]} className="flow-label" textAnchor="middle">
          {edge.label}
        </text>
      )}
    </g>
  );
}

function Node({ id, node, fnId, scope, onNodeClick, selected }: { id: string; node: FlowNode; fnId: string; scope: string; onNodeClick?: FlowNodeClick; selected: boolean }) {
  const { x, y, w, h, shape } = node;
  const cx = x + w / 2;
  const cy = y + h / 2;
  let mark: ReactNode;
  switch (shape) {
    case "terminator":
      mark = <rect x={x} y={y} width={w} height={h} rx={h / 2} />;
      break;
    case "decision":
      mark = <polygon points={`${cx},${y} ${x + w},${cy} ${cx},${y + h} ${x},${cy}`} />;
      break;
    case "loop": {
      const k = Math.min(14, w / 4);
      mark = <polygon points={`${x + k},${y} ${x + w - k},${y} ${x + w},${cy} ${x + w - k},${y + h} ${x + k},${y + h} ${x},${cy}`} />;
      break;
    }
    case "join":
      mark = <circle cx={cx} cy={cy} r={Math.min(w, h) / 2} />;
      break;
    case "label":
      mark = null;
      break;
    default:
      mark = <rect x={x} y={y} width={w} height={h} rx={6} />;
  }
  const target = node.target;
  const outside = target !== undefined && outsideScope(target, scope);
  const inside = target !== undefined && !outside && target !== fnId;
  const text =
    shape === "join" ? null : (
      <text x={cx} y={cy} textAnchor="middle" dominantBaseline="central" className="flow-text">
        {node.label}
      </text>
    );
  // A call step is drawn with a double bar down each side, the ISO 5807 mark for a predefined process.
  const bars = node.role === "call" && shape !== "label" ? (
    <>
      <line x1={x + 6} y1={y} x2={x + 6} y2={y + h} className="flow-call-bar" />
      <line x1={x + w - 6} y1={y} x2={x + w - 6} y2={y + h} className="flow-call-bar" />
    </>
  ) : null;
  const body = (
    <>
      <title>{outside && target !== undefined ? outsideText(target) : (node.title ?? node.label)}</title>
      {mark}
      {bars}
      {text}
      {outside && (
        <text x={x + w - 6} y={y + 12} textAnchor="end" className="flow-mark">
          ↗
        </text>
      )}
    </>
  );
  const cls = `flow-node ${shape} role-${node.role}${outside ? " unresolved" : ""}${inside ? " resolves" : ""}${selected ? " selected" : ""}`;
  // A call into this scope opens the callee's chart; every other step with a span opens its source line.
  const link = inside && target !== undefined ? hrefView(id, "flow", { scope, fn: target }) : node.span ? hrefFile(id, node.span.file, node.span.start[0] + 1) : undefined;
  const onClick = onNodeClick
    ? (e: MouseEvent<Element>) => {
        if (onNodeClick(node)) e.preventDefault();
      }
    : undefined;
  return link ? (
    <a href={link} className={cls} onClick={onClick}>
      {body}
    </a>
  ) : (
    <g className={cls} onClick={onClick}>
      {body}
    </g>
  );
}
