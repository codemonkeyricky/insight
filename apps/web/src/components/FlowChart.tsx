import { useId, type ReactNode } from "react";
import type { FlowEdge, FlowNode, FunctionFlow } from "../api";
import { hrefFile } from "../router";

/**
 * One function's control-flow chart as SVG. The boxes and edge points come from the layout in
 * @insight/flow; this only draws them. A step with a source span links to its line.
 */
export function FlowChart({ id, fn }: { id: string; fn: FunctionFlow }) {
  const arrow = `arrow-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  return (
    <svg className="flow" width={fn.width} height={fn.height} viewBox={`0 0 ${fn.width} ${fn.height}`} role="img" aria-label={`Control flow of ${fn.name}`}>
      <defs>
        <marker id={arrow} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
          <path d="M0,0 L10,5 L0,10 z" className="flow-arrow" />
        </marker>
      </defs>
      <g>
        {fn.edges.map((e, i) => (
          <Edge key={`${e.from}>${e.to}>${i}`} edge={e} marker={arrow} />
        ))}
      </g>
      <g>
        {fn.nodes.map((n) => (
          <Node key={n.id} id={id} node={n} />
        ))}
      </g>
    </svg>
  );
}

function Edge({ edge, marker }: { edge: FlowEdge; marker: string }) {
  const d = edge.points.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x} ${y}`).join(" ");
  return (
    <g className={`flow-edge ${edge.kind}`}>
      <path d={d} markerEnd={`url(#${marker})`} />
      {edge.label && edge.labelAt && (
        <text x={edge.labelAt[0]} y={edge.labelAt[1]} className="flow-label" textAnchor="middle">
          {edge.label}
        </text>
      )}
    </g>
  );
}

function Node({ id, node }: { id: string; node: FlowNode }) {
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
  const text =
    shape === "join" ? null : (
      <text x={cx} y={cy} textAnchor="middle" dominantBaseline="central" className="flow-text">
        {node.label}
      </text>
    );
  const body = (
    <>
      <title>{node.title ?? node.label}</title>
      {mark}
      {text}
    </>
  );
  const cls = `flow-node ${shape} role-${node.role}`;
  return node.span ? (
    <a href={hrefFile(id, node.span.file, node.span.start[0] + 1)} className={cls}>
      {body}
    </a>
  ) : (
    <g className={cls}>{body}</g>
  );
}
