// A function's control-flow chart drawn in an expansion box beside the zoom map (see zoom/expand.ts). The box has the
// function's name in a header with a close button, and the chart at its natural size under the header once the box is
// wide enough on screen. The box's position and size are the expansion's; the chart is drawn once, unscaled, so it grows
// and shrinks with the camera like the rest of the map.
import { CHART_HEAD, CHART_PAD, type FlowNode } from "@insight/flow";
import { chartShown } from "../../zoom/chart";
import { detailLetter, type Callout, type Expansion } from "../../zoom/expand";
import { fitLabel, labelChars } from "../../zoom/lod";
import { FlowChart } from "../FlowChart";

interface Props {
  /** The project, for the chart's links. */
  id: string;
  /** The scope the map shows: the chart's links resolve in it. */
  scope: string;
  expansion: Expansion;
  /** The label scale: the camera's scale in its quarter-octave bucket (lod.ts). */
  k: number;
  /** The step to mark as selected, when the selection is in this chart. */
  selectedId?: string;
  /** Takes over the clicks on the chart's steps (see FlowChart). */
  onNodeClick: (node: FlowNode) => boolean;
  /** Selects the expansion's function: a click on its header. */
  onSelect: () => void;
  onClose: () => void;
}

/** The letter-named callout of a detail: a dashed ring around the tile it hangs from, a leader to the detail, and a bubble. */
export function CalloutShape({ callout, letter, k }: { callout: Callout; letter: string; k: number }) {
  const { cx, cy, rx, ry, leader, bubble } = callout;
  // The bubble keeps its size on screen: it is drawn at the inverse of the camera's scale about its own centre.
  const inv = 1 / k;
  return (
    <g className="zm-callout">
      <ellipse cx={cx} cy={cy} rx={rx} ry={ry} className="zm-callout-ring" />
      <line x1={leader.x1} y1={leader.y1} x2={leader.x2} y2={leader.y2} className="zm-leader" />
      <g transform={`translate(${bubble.x} ${bubble.y}) scale(${inv}) translate(${-bubble.x} ${-bubble.y})`}>
        <circle cx={bubble.x} cy={bubble.y} r={14} className="zm-bubble" />
        <text x={bubble.x} y={bubble.y} dominantBaseline="central" textAnchor="middle" className="zm-bubble-text">
          {letter}
        </text>
      </g>
    </g>
  );
}

export function ExpansionShape({ id, scope, expansion, k, selectedId, onNodeClick, onSelect, onClose }: Props) {
  const { chart, x, y, w, h } = expansion;
  const title = `Detail ${detailLetter(expansion.index)}: ${chart.name}`;
  const label = fitLabel(title, labelChars(w * k));
  return (
    <g className="zm-expansion">
      <title>{title}</title>
      <rect x={x} y={y} width={w} height={h} rx={18} className="zm-expansion-body" />
      <g className="zm-expansion-title" onClick={onSelect}>
        <rect x={x} y={y} width={w} height={CHART_HEAD} rx={18} className="zm-expansion-head" />
        {label !== null && (
          <text x={x + 14} y={y + CHART_HEAD / 2} dominantBaseline="central" className="zm-label">
            {label}
          </text>
        )}
      </g>
      <g
        className="zm-expansion-close"
        role="button"
        aria-label={`Close the chart of ${chart.name}`}
        onClick={(ev) => {
          ev.stopPropagation();
          onClose();
        }}
      >
        <rect x={x + w - CHART_HEAD} y={y} width={CHART_HEAD} height={CHART_HEAD} className="zm-expansion-close-hit" />
        <text x={x + w - CHART_HEAD / 2} y={y + CHART_HEAD / 2} dominantBaseline="central" textAnchor="middle">
          ×
        </text>
      </g>
      {chartShown(chart.width * k) && (
        <g transform={`translate(${x + CHART_PAD} ${y + CHART_HEAD + CHART_PAD})`} onClick={(ev) => ev.stopPropagation()}>
          <FlowChart id={id} fn={chart} scope={scope} onNodeClick={onNodeClick} selectedId={selectedId} />
        </g>
      )}
    </g>
  );
}
