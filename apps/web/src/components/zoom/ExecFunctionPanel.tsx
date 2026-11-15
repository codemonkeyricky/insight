// The panel under the execution map when the focus is a function: the call path to it (its trail), its name and source
// line, where it runs, the other places it runs, the chart's stats and legend, and its Calls and Called by lists. The
// chart itself is drawn in the function's expansion beside the map (Expansion.tsx). The stats come from the flow store; the rest
// from the map's build and the scope's index.
import { useEffect, useMemo, useState } from "react";

import { resourcesOf, type ExecModel, type ExecResource, type FunctionFlow } from "@insight/flow";
import { hrefFile, hrefView } from "../../router";
import { execCallLists, execPlacementFor, execRunsOn, execTrail, PLAIN_FLOW_WORD, type ExecIndex } from "../../zoom/execMap";
import type { ZoomStore } from "../../zoom/scene";
import type { MapSelected } from "../../zoom/source";
import { CallLists, ExecTrail, FnLink, type ListBase } from "./ExecLists";
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
  /** The scope's execution model: the resources (locks, channels) each function uses. */
  model: ExecModel;
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

type CouplingInfo = NonNullable<FunctionFlow["coupling"]>;
type FootprintEntry = CouplingInfo["footprint"]["entries"][number];

const CLASS_ORDER: FootprintEntry["cls"][] = ["cross", "io", "state", "conc", "escape"];
const CLASS_HEAD: Record<FootprintEntry["cls"], string> = {
  cross: "Calls into other modules",
  io: "Does I/O",
  state: "Touches shared state",
  conc: "Spawns or awaits work",
  escape: "May throw out",
};

/** The function's coupling: its module, the one-line summary, and its footprint entries grouped by class. Cross entries link to their target. */
export function CouplingSection({ base, info }: { base: ListBase; info: CouplingInfo }) {
  const { footprint, module, summary } = info;
  const groups = CLASS_ORDER.map((cls) => [cls, footprint.entries.filter((e) => e.cls === cls)] as const).filter(([, es]) => es.length > 0);
  return (
    <section className="exec-coupling" aria-label="Coupling">
      <h3>Coupling</h3>
      <p className="small">Module {module}</p>
      <p className="muted small">{summary}</p>
      {groups.length === 0 && <p className="muted small">Nothing outside its own module.</p>}
      {groups.map(([cls, es]) => (
        <div key={cls}>
          <p className="small">{CLASS_HEAD[cls]}</p>
          <ul>
            {es.map((e, i) => (
              <li key={`${e.label}\0${e.target ?? ""}\0${i}`}>
                {cls === "cross" && e.target !== undefined ? (
                  <a href={hrefView(base.id, "flow", { scope: base.scope, fn: e.target, roots: base.roots })}>{e.label}</a>
                ) : (
                  e.label
                )}
                {e.module !== undefined && e.module !== "" && <span className="muted small"> {e.module}</span>}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

const KIND_WORD: Record<ExecResource["kind"], string> = { lock: "Lock", channel: "Channel", condvar: "Condvar", semaphore: "Semaphore", atomic: "Atomic" };

/**
 * The resources the function uses (resourcesOf): one line per resource, its kind and name, then the other functions that
 * touch it with their operations and threads. Each other function links to its placement, as the call lists do.
 */
export function SharedResources({ base, model, index, fnId }: { base: ListBase; model: ExecModel; index: ExecIndex; fnId: string }) {
  const rows = resourcesOf(model, fnId);
  if (rows.length === 0) return null;
  return (
    <section className="exec-resources" aria-label="Shared resources">
      <h3>Shared resources</h3>
      <ul>
        {rows.map((r) => {
          // Each other function once, with the operations it performs on the resource, in site order.
          const byFn = new Map<string, string[]>();
          for (const s of r.sites) if (s.fn !== fnId) byFn.set(s.fn, [...new Set([...(byFn.get(s.fn) ?? []), s.op])]);
          return (
            <li key={r.id}>
              <span className="small">{KIND_WORD[r.kind]}</span> <span className="mono">{r.name}</span>
              {byFn.size === 0 ? (
                <span className="muted small"> used only here</span>
              ) : (
                <span className="muted small">
                  {" "}
                  with{" "}
                  {[...byFn].map(([other, ops], i) => {
                    const name = index.fns.get(other)?.name ?? other;
                    const thread = execRunsOn(index, index.scene, other);
                    return (
                      <span key={other}>
                        {i > 0 && ", "}
                        <FnLink base={base} fn={other} nodeId={execPlacementFor(index, other)}>
                          {name}
                        </FnLink>{" "}
                        ({ops.join("/")}
                        {thread !== undefined ? ` on ${thread}` : ""})
                      </span>
                    );
                  })}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function ExecFunctionPanel({ id, scope, roots, store, index, model, nodeId, selected, onOpen }: Props) {
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
                  href={hrefView(id, "flow", { scope, fn: ref, roots })}
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
        <p className="muted small">The control-flow chart is drawn in an expansion to the right of the function's box on the map. Click a step in it to see its source.</p>
      )}
      {fn !== undefined && <FunctionDetail id={id} fn={fn} scope={scope} />}
      {fn?.coupling !== undefined && <CouplingSection base={base} info={fn.coupling} />}
      <SharedResources base={base} model={model} index={index} fnId={ref} />
      <CallLists base={base} lists={lists} />
    </section>
  );
}
