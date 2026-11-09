import { useState } from "react";

/** One row of the layers list: a page of the project, or a lens of the scope. */
export interface LayerLink {
  id: string;
  title: string;
  href: string;
  current: boolean;
  group: "page" | "lens";
  dim?: boolean;
  reason?: string;
}

interface Props {
  links: LayerLink[];
  onClose: () => void;
}

/** The layers card at the top left of the sheet: every page of the project and the lenses of the scope, one list. */
export function LayersPanel({ links, onClose }: Props) {
  const [frames, setFrames] = useState(true);
  const [calls, setCalls] = useState(true);
  const pages = links.filter((l) => l.group === "page");
  const lenses = links.filter((l) => l.group === "lens");
  return (
    <section className="sh-card sh-layers" aria-label="Layers">
      <header className="sh-card-head">
        <h2>Layers</h2>
        <button type="button" className="sh-close" aria-label="Hide the layers" onClick={onClose}>
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
            <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
      </header>
      <ul className="sh-layer-list" aria-label="Pages">
        {pages.map((l) => (
          <li key={l.id}>
            <a href={l.href} aria-current={l.current ? "page" : undefined}>
              {l.title}
            </a>
          </li>
        ))}
      </ul>
      {lenses.length > 0 && (
        <>
          <h3 className="sh-layer-head">Lenses</h3>
          <ul className="sh-layer-list" aria-label="Lenses">
            {lenses.map((l) => (
              <li key={l.id}>
                <a href={l.href} aria-current={l.current ? "page" : undefined} className={l.dim ? "dim" : undefined} title={l.reason}>
                  {l.title}
                </a>
              </li>
            ))}
          </ul>
        </>
      )}
      <h3 className="sh-layer-head">Show on the map</h3>
      <label className="sh-check">
        <input type="checkbox" checked={frames} onChange={(e) => setFrames(e.target.checked)} /> Frames
      </label>
      <label className="sh-check">
        <input type="checkbox" checked={calls} onChange={(e) => setCalls(e.target.checked)} /> Calls
      </label>
      <details className="sh-keys">
        <summary>? Keyboard and mouse</summary>
        <ul>
          <li>Scroll, or + and -, to zoom. Zooming never opens a box.</li>
          <li>Arrow keys pan.</li>
          <li>Click a function to open its chart beside it. Click a call step in the chart to open the callee beside it.</li>
          <li>Click a step that is not a call to see its source.</li>
          <li>Enter opens the item at the centre.</li>
          <li>Escape closes the last chart opened.</li>
        </ul>
      </details>
    </section>
  );
}
