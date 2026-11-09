// The panel under the execution map when the focus is a container: its heading, and for a thread or coroutine, or the
// project when it holds plain code flow, its functions as pills and as a table. A process holds threads, so it shows its
// heading only. The table's flow counts come from the scope's flow, loaded once through the flow store.
import { useEffect, useMemo, useState } from "react";
import type { ScopeFlow } from "@insight/flow";
import type { ScopeKind } from "../ScopeNote";
import { execChips, execRows, type ExecFlowCounts, type ExecIndex } from "../../zoom/execMap";
import type { ZoomStore } from "../../zoom/scene";
import { ExecChips, ExecTable, type ListBase } from "./ExecLists";

/** A container's kind in words. A process is a `program` node: the kind stays in the data, only the word is "Process". */
const KIND_WORD: Record<string, string> = {
  project: "Project",
  program: "Process",
  thread: "Thread",
  coroutine: "Coroutine",
};

/** The root of a scoped map is always a `project` node. Its badge names the scope it stands for. */
const ROOT_WORD: Record<Exclude<ScopeKind, "missing">, string> = {
  project: "Project",
  folder: "Folder",
  file: "File",
};

/** The containers that hold functions directly. A project holds them only as plain code flow, so it lists them when it has any. */
const LISTS_FUNCTIONS = new Set(["thread", "coroutine"]);

interface Props {
  id: string;
  /** The scope the map shows. Its flow supplies the table's counts. */
  scope: string;
  roots: boolean;
  /** The flow store. The scope's flow is loaded through it. */
  store: ZoomStore;
  index: ExecIndex;
  /** The focused container's scene node. */
  nodeId: string;
  onOpen: (nodeId: string) => void;
  /** What the scope is, for the badge of a project node. Defaults to the whole project. */
  rootKind?: Exclude<ScopeKind, "missing">;
}

/** The scope's flow once it has loaded, or the error that stopped it. Nothing before the load settles. */
function useScopeFlow(store: ZoomStore, scope: string): { flow?: ScopeFlow; error?: string } {
  const [done, setDone] = useState<{ scope: string; flow?: ScopeFlow; error?: string }>();
  useEffect(() => {
    let cancelled = false;
    store.ensureScope(scope).then(
      () => {
        if (!cancelled) setDone({ scope, flow: store.flowOf(scope) });
      },
      (e: unknown) => {
        if (!cancelled) setDone({ scope, error: e instanceof Error ? e.message : String(e) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [store, scope]);
  return done?.scope === scope ? done : {};
}

/** The flow counts by function id, when the scope's flow has them (functions granularity). */
function countsOf(flow: ScopeFlow | undefined): Map<string, ExecFlowCounts> | undefined {
  if (flow === undefined || flow.granularity !== "functions") return undefined;
  return new Map(flow.functions.map((f): [string, ExecFlowCounts] => [f.id, { steps: f.steps, decisions: f.decisions, loops: f.loops }]));
}

export function ExecContainerPanel({ id, scope, roots, store, index, nodeId, onOpen, rootKind = "project" }: Props) {
  const node = index.scene.nodes.get(nodeId);
  const { flow, error } = useScopeFlow(store, scope);
  const counts = useMemo(() => countsOf(flow), [flow]);
  const chips = useMemo(() => execChips(index.scene, nodeId), [index, nodeId]);
  const rows = useMemo(() => execRows(index, nodeId, counts), [index, nodeId, counts]);
  if (node === undefined) return null;
  const base: ListBase = { id, scope, roots, onOpen };
  const word = node.kind === "project" ? ROOT_WORD[rootKind] : (KIND_WORD[node.kind] ?? node.kind);
  // The project lists its functions only when it holds plain code flow; its processes and threads are listed by their own boxes.
  const holdsFunctions = LISTS_FUNCTIONS.has(node.kind);
  const listsProjectFunctions = node.kind === "project" && rows.length > 0;
  return (
    <section className="flow-panel zm-detail exec-container" aria-label={word}>
      <h2>
        {node.label}
        {node.label !== word && <span className={`kind ${node.kind}`}> {word}</span>}
      </h2>
      {node.detail !== undefined && <p className="muted small">{node.detail}</p>}
      {node.note !== undefined && <p className="muted small">{node.note}</p>}
      {error !== undefined && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {holdsFunctions && rows.length === 0 && <p className="muted">No functions in this {word.toLowerCase()}.</p>}
      {(holdsFunctions || listsProjectFunctions) && rows.length > 0 && (
        <>
          <h3 className="exec-h">Functions</h3>
          <ExecChips base={base} label={`Functions in ${node.label}`} chips={chips.items} more={chips.more} />
          <h3 className="exec-h">Per function</h3>
          <ExecTable base={base} rows={rows} flow={counts !== undefined} />
        </>
      )}
    </section>
  );
}
