// The Flow page's right panel: the source of the function the map selected. The lines highlighted are the construct
// picked in the function's chart, else the whole function, else its definition line.
import { useEffect, useState } from "react";
import type { FlowSpan } from "@insight/flow";
import type { Refs } from "@insight/model";
import { api } from "../../api";
import { FileViewer } from "../FileViewer";
import type { ZoomStore } from "../../zoom/scene";
import { selectionRange } from "../../zoom/chart";
import type { MapSelection } from "./ZoomMap";
import { RefLists } from "./RefLists";

interface Props {
  id: string;
  store: ZoomStore;
  sel: MapSelection;
  /** Whether the Flow tab is roots-only, which the lists' links keep. */
  roots: boolean;
  /** Without a close button and header: the side panel that holds this source has its own. */
  onClose?: () => void;
}

export function FunctionSource({ id, store, sel, roots, onClose }: Props) {
  const { selected } = sel;
  const scope = sel.build.path;
  const [refState, setRefState] = useState<{ key: string; refs?: Refs; error?: string }>();
  const refKey = `${id}\0${scope}\0${selected.ref}`;
  useEffect(() => {
    let cancelled = false;
    const key = `${id}\0${scope}\0${selected.ref}`;
    api.getRefs(id, scope, selected.ref).then(
      (refs) => {
        if (!cancelled) setRefState({ key, refs });
      },
      (e: unknown) => {
        if (!cancelled) setRefState({ key, error: e instanceof Error ? e.message : String(e) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [id, scope, selected.ref]);
  const shownRefs = refState?.key === refKey ? refState : undefined;
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
  const body = (
    <>
      {shownRefs?.refs && <RefLists id={id} scope={scope} roots={roots} refs={shownRefs.refs} />}
      {shownRefs?.error && <p className="muted small">The references of this function are not available: {shownRefs.error}</p>}
      {!shownRefs && <p className="muted small">Loading the references</p>}
      {selected.file ? (
        <FileViewer key={`${selected.file}\0${selected.ref}`} id={id} path={selected.file} line={selected.line} range={range} />
      ) : (
        <p className="muted small">The IR has no source for this function.</p>
      )}
    </>
  );
  if (onClose === undefined) return <section className="sh-source" aria-label="Source of the selected function">{body}</section>;
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
      {body}
    </aside>
  );
}
