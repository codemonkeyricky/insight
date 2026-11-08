// A function's control-flow chart drawn inside its box on the canvas. The box was sized to hold the chart (the scene's
// `sceneLeafSize`), so the chart sits in the box at its natural scale: it grows and shrinks with the camera like the
// box does. The chart is loaded through the flow store when the box is first drawn large enough to read it.
import { useEffect, useState } from "react";
import { CHART_HEAD, CHART_PAD, type FunctionFlow, type Rect } from "@insight/flow";
import type { ZoomStore } from "../../zoom/scene";
import { FlowChart } from "../FlowChart";

/** Charts are drawn once the box is at least this many pixels wide on screen. Below it the box shows only its name. */
export const CHART_MIN_PX = 160;

/** The chart's top-left corner in a box: centred across the box, under the name's header. */
export function chartOrigin(rect: Rect, chart: { w: number; h: number }): { x: number; y: number } {
  return { x: rect.x + Math.max(CHART_PAD, (rect.w - chart.w) / 2), y: rect.y + CHART_HEAD + CHART_PAD };
}

interface Props {
  id: string;
  /** The scope the map shows: the chart's links resolve in it. */
  scope: string;
  store: ZoomStore;
  /** The function's id. */
  fnId: string;
  rect: Rect;
}

interface State {
  fnId: string;
  fn?: FunctionFlow;
}

export function BoxChart({ id, scope, store, fnId, rect }: Props) {
  const [state, setState] = useState<State>();
  useEffect(() => {
    let cancelled = false;
    store.chartOf(fnId).then(
      (fn) => {
        if (!cancelled) setState({ fnId, ...(fn !== undefined ? { fn } : {}) });
      },
      () => {
        if (!cancelled) setState({ fnId });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [store, fnId]);
  const fn = state?.fnId === fnId ? state.fn : undefined;
  if (fn === undefined || fn.tooLarge || fn.nodes.length === 0) return null;
  const at = chartOrigin(rect, { w: fn.width, h: fn.height });
  // A click on a step follows its link or does nothing; it must not also move the camera to the box.
  return (
    <g className="zm-chart" transform={`translate(${at.x} ${at.y})`} onClick={(e) => e.stopPropagation()}>
      <FlowChart id={id} fn={fn} scope={scope} />
    </g>
  );
}
