// The peers of a function's sync rows: for each lock or channel row of a function's chart, the other functions that use
// the same resource and the thread each one runs on. A row's title gets the peers; the labels, the rows and the layout
// are unchanged. The model is the scope's execution model (ExecModel); a resource matches a row by its kind and name.
import type { ExecModel, ExecThread } from "./exec-model.js";
import type { FlowNode, FunctionFlow } from "./types.js";

/** The thread label the scene draws for a thread, in words: "Main thread", or the kind and the name of what starts it. */
function threadLabel(t: ExecThread, names: ReadonlyMap<string, string>): string {
  if (t.kind === "main" || t.kind === "process") return "Main thread";
  const first = t.roots.map((r) => names.get(r)).find((n) => n !== undefined);
  const spawnName = t.spawn?.script ?? t.spawn?.api?.split(".").pop() ?? "";
  const name = first ?? (spawnName === "" ? "unresolved" : spawnName);
  return `${t.kind === "thread" ? "Thread" : t.kind === "async" ? "Async" : t.kind} · ${name}`;
}

/** The thread labels each function runs on, in thread order, by function id. */
function threadsByFn(model: ExecModel): Map<string, string[]> {
  const names = new Map(model.functions.map((f): [string, string] => [f.id, f.name]));
  const out = new Map<string, string[]>();
  for (const t of model.threads) {
    const label = threadLabel(t, names);
    for (const fn of new Set([...t.roots, ...t.reached])) {
      const list = out.get(fn) ?? [];
      if (!list.includes(label)) list.push(label);
      out.set(fn, list);
    }
  }
  return out;
}

/** The name of a row's resource and its kind, read from the row's label. Undefined for a row that names no resource. */
function resourceOf(label: string): { kind: "lock" | "channel"; name: string; op?: "send" | "recv" } | undefined {
  const lock = /^🔒 (.+?)(?: \(shared\))?$/.exec(label);
  if (lock?.[1] !== undefined) return { kind: "lock", name: lock[1] };
  const send = /^▶ send (.+)$/.exec(label);
  if (send?.[1] !== undefined) return { kind: "channel", name: send[1], op: "send" };
  const recv = /^◀ recv (.+)$/.exec(label);
  if (recv?.[1] !== undefined) return { kind: "channel", name: recv[1], op: "recv" };
  return undefined;
}

/** The peer text of one sync row, or undefined when the row has no peer. */
function peerText(node: FlowNode, fnId: string, model: ExecModel, threads: ReadonlyMap<string, string[]>): string | undefined {
  const r = resourceOf(node.label);
  if (r === undefined) return undefined;
  const res = model.resources?.find((x) => x.kind === r.kind && x.name === r.name);
  if (res === undefined) return undefined;
  const others = res.sites.filter((s) => s.fn !== fnId);
  const names = new Map(model.functions.map((f): [string, string] => [f.id, f.name]));
  const where = (fn: string): string => {
    const at = threads.get(fn)?.[0];
    const name = names.get(fn) ?? fn;
    return at === undefined ? name : `${name} @ ${at}`;
  };
  if (r.kind === "lock") {
    const ts = [...new Set(others.filter((s) => s.op === "acquire").flatMap((s) => threads.get(s.fn) ?? []))];
    return ts.length === 0 ? undefined : `also taken on: ${ts.join(", ")}`;
  }
  if (r.op === "send") {
    const peers = [...new Set(others.filter((s) => s.op === "recv").map((s) => where(s.fn)))];
    return peers.length === 0 ? undefined : `→ ${peers.join(", ")}`;
  }
  const peers = [...new Set(others.filter((s) => s.op === "send").map((s) => where(s.fn)))];
  return peers.length === 0 ? undefined : `← ${peers.join(", ")}`;
}

/**
 * The chart with each sync row's title annotated from the model's resources: a send names its receivers ("→ fn @ thread"),
 * a receive its senders ("← fn @ thread"), and a lock the other threads that take it ("also taken on: threads"). Only titles
 * change. A chart with no sync row, or a function that shares nothing, comes back as it is.
 */
export function withResourcePeers(chart: FunctionFlow, fnId: string, model: ExecModel): FunctionFlow {
  if (model.resources === undefined || model.resources.length === 0) return chart;
  if (!chart.nodes.some((n) => n.role === "sync")) return chart;
  const threads = threadsByFn(model);
  let changed = false;
  const nodes = chart.nodes.map((node): FlowNode => {
    if (node.role !== "sync") return node;
    const text = peerText(node, fnId, model, threads);
    if (text === undefined) return node;
    changed = true;
    return { ...node, title: `${node.title ?? node.label} · ${text}` };
  });
  return changed ? { ...chart, nodes } : chart;
}
