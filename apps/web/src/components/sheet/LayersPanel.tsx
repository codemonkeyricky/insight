import type { ReactNode } from "react";

/** What the map shows: the frames, the call edges, and the findings layer (clouds and markers). */
export interface LayerState {
  frames: boolean;
  calls: boolean;
  findings: boolean;
  /** Anonymous functions as boxes of their own. Off, they are folded into the function they are written in. */
  lambdas: boolean;
  /** The charts' motion: edges march in their direction, and a loop's back-edge carries a pulse. On by default. */
  motion: boolean;
}

interface Props {
  shown: LayerState;
  /** How many findings the project has, once the findings layer has loaded them. */
  findingCount?: number;
  onChange: (key: keyof LayerState, on: boolean) => void;
  onClose: () => void;
  /** The roots-only switch. On a phone the switch lives here, since the map has no room for it. */
  roots?: ReactNode;
}

/** The small card over the flow map's left edge: what the map draws, and the keys. The pages and lenses are the tabs. */
export function LayersPanel({ shown, findingCount, onChange, onClose, roots }: Props) {
  return (
    <section className="sh-card sh-layers" aria-label="Show on the map">
      <header className="sh-card-head">
        <h2>Show on the map</h2>
        <button type="button" className="sh-close" aria-label="Hide the map options" onClick={onClose}>
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
            <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
      </header>
      <label className="sh-check">
        <input type="checkbox" checked={shown.frames} onChange={(e) => onChange("frames", e.target.checked)} /> Frames
      </label>
      <label className="sh-check">
        <input type="checkbox" checked={shown.calls} onChange={(e) => onChange("calls", e.target.checked)} /> Calls
      </label>
      <label className="sh-check">
        <input type="checkbox" checked={shown.findings} onChange={(e) => onChange("findings", e.target.checked)} /> Findings
        {findingCount !== undefined && <span className="sh-count-inline"> {findingCount}</span>}
      </label>
      <label className="sh-check">
        <input type="checkbox" checked={shown.lambdas} onChange={(e) => onChange("lambdas", e.target.checked)} /> Lambdas
      </label>
      <label className="sh-check">
        <input type="checkbox" checked={shown.motion} onChange={(e) => onChange("motion", e.target.checked)} /> Flow motion
      </label>
      {roots !== undefined && <div className="sh-layers-roots">{roots}</div>}
      <details className="sh-keys">
        <summary>? Keyboard and mouse</summary>
        <ul>
          <li>Scroll, or + and -, to zoom. Zooming never opens a box.</li>
          <li>Arrow keys pan.</li>
          <li>Click a function to see its source and its calls in the code pane. Click a call step in the chart to open the callee.</li>
          <li>Click a step that is not a call to see its source.</li>
          <li>Enter opens the item at the centre.</li>
          <li>Escape closes the last chart opened.</li>
        </ul>
      </details>
    </section>
  );
}
