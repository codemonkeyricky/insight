// The Flow page's right panel: the source of the function the map selected. The lines highlighted are the construct
// picked in the function's chart, else the whole function, else its definition line.
import { useEffect, useState } from "react";
import type { FlowSpan } from "@insight/flow";
import { FileViewer } from "../FileViewer";
import type { ZoomStore } from "../../zoom/scene";
import { selectionRange } from "../../zoom/chart";
import type { MapSelection } from "./ZoomMap";

interface Props {
  id: string;
  store: ZoomStore;
  sel: MapSelection;
  onClose: () => void;
}

export function FunctionSource({ id, store, sel, onClose }: Props) {
  const { selected } = sel;
  const [span, setSpan] = useState<{ ref: string; span?: FlowSpan }>();
  useEffect(() => {
    let cancelled = false;
    store.chartOf(selected.ref).then(
      (fn) => {
        if (!cancelled) setSpan({ ref: selected.ref, ...(fn?.span !== undefined ? { span: fn.span } : {}) });
      },
      () => {
        if (!cancelled) setSpan({ ref: selected.ref });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [store, selected.ref]);
  const fnSpan = span?.ref === selected.ref ? span.span : undefined;
  const range = selectionRange(sel.construct, fnSpan, selected.line);
  return (
    <aside className="zm-source panel" aria-label="Source of the selected function">
      <header className="zm-source-head">
        <div>
          <strong className="mono">{selected.name}</strong>
          <div className="muted small mono">
            {selected.file ? `${selected.file}:${selected.line}` : "No source for this function"}
          </div>
        </div>
        <button type="button" onClick={onClose} aria-label="Close the source panel">
          Close
        </button>
      </header>
      {selected.file ? (
        <FileViewer key={`${selected.file}\0${selected.ref}`} id={id} path={selected.file} line={selected.line} range={range} />
      ) : (
        <p className="muted small">The IR has no source for this function.</p>
      )}
    </aside>
  );
}
