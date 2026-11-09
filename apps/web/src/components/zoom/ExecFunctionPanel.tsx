// The panel under the execution map when the focus is a function: the call path to it (its trail), its name and source
// line, where it runs, the other places it runs, the chart's stats and legend, and its Calls and Called by lists. The
// chart itself is drawn in the function's expansion beside the map (Expansion.tsx). The stats come from the flow store; the rest
// from the map's build and the scope's index.
import { useEffect, useMemo, useState } from "react";
import type { FunctionFlow } from "@insight/flow";
import { hrefFile, hrefView } from "../../router";
import { execCallLists, execTrail, PLAIN_FLOW_WORD, type ExecIndex } from "../../zoom/execMap";
import type { ZoomStore } from "../../zoom/scene";
import type { MapSelected } from "../../zoom/source";
import { CallLists, ExecTrail, type ListBase } from "./ExecLists";
import { FunctionDetail } from "./FunctionDetail";

interface Props {
  /** The project. */
  id: string;
  /** The scope the map shows: the chart's links resolve in it. */
  scope: string;
  /** Whether the map is the roots-only view, which the links keep. */
  roots: boolean;
  /** The flow store. The function's chart is loaded through it. */
  store: ZoomStore;
  /** The scope's index: its scene, functions and calls. The trail and the call lists are read from it. */
  index: ExecIndex;
  /** The focused function's scene node. */
  nodeId: string;
  selected: MapSelected;
  /** Moves the map to one node of the function or of its neighbours, by node id. */
  onOpen: (nodeId: string) => void;
}

interface ChartState {
  ref: string;
  fn?: FunctionFlow;
  error?: string;
}

/** Where the function runs, in words. A function with no runtime context is plain code flow, and says so. */
export function runsLine(s: MapSelected): string {
  if (s.runtime === "none") return PLAIN_FLOW_WORD;
  const thread = `Runs on ${s.thread ?? "a thread"}`;
  return s.runtime === "coroutine" ? `${thread} in coroutine ${s.coroutine ?? ""}` : thread;
}

export function ExecFunctionPanel({ id, scope, roots, store, index, nodeId, selected, onOpen }: Props) {
  const ref = selected.ref;
  const [chart, setChart] = useState<ChartState>();
  useEffect(() => {
    let cancelled = false;
    store.chartOf(ref).then(
      (fn) => {
        if (!cancelled) setChart({ ref, fn });
      },
      (e: unknown) => {
        if (!cancelled) setChart({ ref, error: e instanceof Error ? e.message : String(e) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [store, ref]);
  const trail = useMemo(() => execTrail(index, nodeId), [index, nodeId]);
  const lists = useMemo(() => execCallLists(index, nodeId), [index, nodeId]);
  const base: ListBase = { id, scope, roots, onOpen };
  const loaded = chart?.ref === ref ? chart : undefined;
  const fn = loaded?.fn;
  return (
    <section className="flow-panel zm-detail exec-fn" aria-label="Function">
      {trail !== undefined && <ExecTrail base={base} steps={trail} />}
      <h2>{selected.name}</h2>
      {selected.file !== "" && (
        <p className="small">
          <a className="mono" href={hrefFile(id, selected.file, selected.line)}>
            {selected.file}:{selected.line}
          </a>
        </p>
      )}
      <p className="exec-runs">{runsLine(selected)}</p>
      {selected.runtime !== "none" && selected.note !== undefined && <p className="muted small">{selected.note}</p>}
      {selected.placements.length > 0 && (
        <div className="exec-also">
          <p className="small">Also runs on:</p>
          <ul>
            {selected.placements.map((p) => (
              <li key={p.nodeId}>
                <a
                  href={hrefView(id, "flow", { scope, fn: ref, ...(roots ? { roots } : {}) })}
                  onClick={(e) => {
                    e.preventDefault();
                    onOpen(p.nodeId);
                  }}
                >
                  {p.label}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
      {loaded?.error && (
        <p className="error" role="alert">
          {loaded.error}
        </p>
      )}
      {loaded === undefined && <p className="muted small">Loading the chart</p>}
      {loaded !== undefined && fn === undefined && loaded.error === undefined && <p className="muted small">No control-flow chart for this function.</p>}
      {fn !== undefined && !fn.tooLarge && fn.nodes.length > 0 && (
        <p className="muted small">The control-flow chart is drawn inside the function's box on the map. Click a step in it to see its source.</p>
      )}
      {fn !== undefined && <FunctionDetail id={id} fn={fn} scope={scope} />}
      <CallLists base={base} lists={lists} />
    </section>
  );
}
