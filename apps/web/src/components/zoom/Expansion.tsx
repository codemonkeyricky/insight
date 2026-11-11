// A function's control-flow chart drawn in an expansion box beside the zoom map (see zoom/expand.ts). The box has the
// function's name in a header with a close button, and the chart at its natural size under the header once the box is
// wide enough on screen. The box's position and size are the expansion's; the chart is drawn once, unscaled, so it grows
// and shrinks with the camera like the rest of the map. A filled callout beam runs from the step (or box) it hangs from
// to the box, behind it, and a 3px accent bar on the box's left edge says it opened from there.
import { CHART_HEAD, CHART_PAD, type FlowNode } from "@insight/flow";
import { chartShown } from "../../zoom/chart";
import { calloutD } from "../../zoom/connector";
import { connectorClass } from "../../zoom/flowMotion";
import { CALLOUT_INSET, detailLetter, type CalloutGeometry, type Expansion } from "../../zoom/expand";
import { displayName } from "../../zoom/names";
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

/** The ends of a callout: its geometry in world units before the side shift, and the x each edge moves with (see ZoomMap's writeShift). */
export interface CalloutEnds extends CalloutGeometry {
  /** The unshifted x whose shift the anchor edge moves with: the box's own x, or the detail's pivot for a step. */
  s1: number;
  /** The unshifted x whose shift the expansion edge moves with: the detail's pivot (its group moves by it). */
  s2: number;
}

/**
 * The callout from an expansion's anchor to its box: a filled beam drawn outside the expansion's group, so the side shift
 * writes its edges directly. Opening it fades it in; closing it fades it out (see styles.css).
 */
export function CalloutShape({ ends, closing = false, reduced = false }: { ends: CalloutEnds; closing?: boolean; reduced?: boolean }) {
  const { ax, ayT, ayB, ex, eyT, eyB, s1, s2 } = ends;
  return (
    <g className={connectorClass(closing, reduced)}>
      <path
        className="zm-callout"
        d={calloutD(ax, ayT, ayB, ex, eyT, eyB)}
        data-ax={ax}
        data-ayt={ayT}
        data-ayb={ayB}
        data-ex={ex}
        data-eyt={eyT}
        data-eyb={eyB}
        data-s1={s1}
        data-s2={s2}
      />
    </g>
  );
}

export function ExpansionShape({ id, scope, expansion, k, selectedId, onNodeClick, onSelect, onClose, motion = true }: Props) {
  const { chart, x, y, w, h } = expansion;
  // The title is the function's display name; the tooltip and the accessible name keep the full name. The detail's letter
  // stays in the accessible name only.
  const runtime = expansion.runtime;
  // A box on another thread or in another process names its runtime first: "Worker · print.worker", then the function.
  const own = displayName(chart.name, chart.id);
  const label = fitLabel(runtime === undefined ? own : runtime.label.endsWith(own) ? runtime.label : `${runtime.label} · ${own}`, labelChars(w * k));
  return (
    <g className={`zm-expansion${runtime !== undefined ? " is-runtime" : ""}`} role="group" aria-label={`Detail ${detailLetter(expansion.index)}: ${chart.name}`}>
      <title>{chart.name}</title>
      <rect x={x} y={y} width={w} height={h} rx={14} className="zm-expansion-body" />
      <rect x={x} y={y + CALLOUT_INSET} width={3} height={Math.max(0, h - 2 * CALLOUT_INSET)} rx={1.5} className="zm-expansion-accent" />
      <g className="zm-expansion-title" onClick={onSelect}>
        <rect x={x} y={y} width={w} height={CHART_HEAD} rx={14} className="zm-expansion-head" />
        <line x1={x + 12} x2={x + w - 12} y1={y + CHART_HEAD} y2={y + CHART_HEAD} className="zm-expansion-rule" />
        {label !== null && (
          <text x={x + 14} y={y + CHART_HEAD / 2} dominantBaseline="central" className="zm-label">
            <tspan className={runtime !== undefined ? "zm-expansion-runtime" : "zm-card-glyph"}>{runtime !== undefined ? (runtime.kind === "process" ? "▣" : "⑂") : "ƒ"}</tspan>{" "}{label}
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
        <circle cx={x + w - CHART_HEAD / 2} cy={y + CHART_HEAD / 2} r={9} className="zm-expansion-close-bg" />
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
