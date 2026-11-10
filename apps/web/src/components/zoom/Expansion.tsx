// A function's control-flow chart drawn in an expansion box beside the zoom map (see zoom/expand.ts). The box has the
// function's name in a header with a close button, and the chart at its natural size under the header once the box is
// wide enough on screen. The box's position and size are the expansion's; the chart is drawn once, unscaled, so it grows
// and shrinks with the camera like the rest of the map. A solid connector runs from the step (or box) it hangs from.
import { CHART_HEAD, CHART_PAD, type FlowNode } from "@insight/flow";
import { chartShown } from "../../zoom/chart";
import { CONNECTOR_HEAD, CONNECTOR_WIDTH, connectorD, headD } from "../../zoom/connector";
import { connectorClass } from "../../zoom/flowMotion";
import { detailLetter, type Expansion } from "../../zoom/expand";
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
  /** Whether the chart's edges march and pulse (the Flow motion choice; see FlowChart). */
  motion?: boolean;
}

/** The ends of a connector, in world units before the side shift, and the x each end moves with (see ZoomMap's writeShift). */
export interface ConnectorEnds {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** The unshifted x whose shift the start moves with: the box's own x, or the detail's pivot for a step. */
  s1: number;
  /** The unshifted x whose shift the end moves with: the detail's pivot (its group moves by it). */
  s2: number;
}

/**
 * The solid connector from an expansion's anchor to its title, drawn outside the expansion's group so the side shift
 * writes its ends directly. Opening it draws the line in; closing it retracts the line (see styles.css).
 */
export function ConnectorShape({ ends, k, closing = false, reduced = false }: { ends: ConnectorEnds; k: number; closing?: boolean; reduced?: boolean }) {
  const { x1, y1, x2, y2, s1, s2 } = ends;
  // The line keeps its width on screen: it is drawn at the inverse of the camera's scale. Its head is the same.
  const width = CONNECTOR_WIDTH / k;
  const head = CONNECTOR_HEAD / k;
  return (
    <g className={connectorClass(closing, reduced)}>
      <path
        className="zm-connector"
        d={connectorD(x1, y1, x2, y2)}
        pathLength={1}
        style={{ strokeWidth: width }}
        data-x1={x1}
        data-y1={y1}
        data-x2={x2}
        data-y2={y2}
        data-s1={s1}
        data-s2={s2}
      />
      <path className="zm-connector-head" d={headD(x2, y2, head)} data-hx={x2} data-hy={y2} data-hs={head} data-s2={s2} />
    </g>
  );
}

export function ExpansionShape({ id, scope, expansion, k, selectedId, onNodeClick, onSelect, onClose, motion = true }: Props) {
  const { chart, x, y, w, h } = expansion;
  // The title is the function's name. The detail's letter stays in the accessible name only.
  const label = fitLabel(chart.name, labelChars(w * k));
  return (
    <g className="zm-expansion" role="group" aria-label={`Detail ${detailLetter(expansion.index)}: ${chart.name}`}>
      <title>{chart.name}</title>
      <rect x={x} y={y} width={w} height={h} rx={12} className="zm-expansion-body" />
      <g className="zm-expansion-title" onClick={onSelect}>
        <rect x={x} y={y} width={w} height={CHART_HEAD} rx={12} className="zm-expansion-head" />
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
          <FlowChart id={id} fn={chart} scope={scope} onNodeClick={onNodeClick} selectedId={selectedId} motion={motion} />
        </g>
      )}
    </g>
  );
}
