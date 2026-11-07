import { ownerOf, type IRView, type Lens, type LensFinding, type LensResult, type TableView, type TreeNode, type TreeView } from "@insight/sdk";
import type { IRNode, NodeId, Span } from "@insight/ir";

const DYNAMIC = "<dynamic>";

interface Spawn {
  node: IRNode;
  kind: "process" | "thread";
  target: string;
  api: string;
  owner: NodeId | undefined;
}

interface Func {
  id: NodeId;
  name: string;
  file: string;
  async: boolean;
  generator: boolean;
  awaits: number;
  span?: Span;
}

const text = (v: unknown, fallback: string): string => (typeof v === "string" && v !== "" ? v : fallback);

/** Every function that is a coroutine (async or a generator) or starts something, with its counts. */
function collect(view: IRView): { funcs: Map<NodeId, Func>; spawns: Spawn[] } {
  const funcs = new Map<NodeId, Func>();
  const fileOf = (n: IRNode): string => n.span?.file ?? String(n.id).split("#")[0] ?? "";
  for (const fn of view.nodes({ facet: "structure", kind: "structure.function" })) {
    funcs.set(fn.id, {
      id: fn.id,
      name: text(fn.attrs.qualifiedName, text(fn.attrs.name, fn.id)),
      file: fileOf(fn),
      async: fn.attrs.async === true,
      generator: false,
      awaits: 0,
      ...(fn.span ? { span: fn.span } : {}),
    });
  }
  for (const n of view.nodes({ facet: "concurrency", kind: "concurrency.coroutine" })) {
    const owner = ownerOf(view, n.id);
    const f = owner ? funcs.get(owner.id) : undefined;
    if (f) f.generator = true;
  }
  for (const n of view.nodes({ facet: "concurrency", kind: "concurrency.await" })) {
    const owner = ownerOf(view, n.id);
    const f = owner ? funcs.get(owner.id) : undefined;
    if (f) f.awaits++;
  }
  const spawns: Spawn[] = [];
  for (const [kind, nodeKind] of [["process", "concurrency.spawn-process"], ["thread", "concurrency.spawn-thread"]] as const) {
    for (const n of view.nodes({ facet: "concurrency", kind: nodeKind })) {
      spawns.push({
        node: n,
        kind,
        target: text(n.attrs.target, DYNAMIC),
        api: text(n.attrs.api, ""),
        owner: ownerOf(view, n.id)?.id,
      });
    }
  }
  spawns.sort(
    (a, b) =>
      (a.node.span?.file ?? "").localeCompare(b.node.span?.file ?? "") ||
      (a.node.span?.start[0] ?? 0) - (b.node.span?.start[0] ?? 0) ||
      a.node.id.localeCompare(b.node.id),
  );
  return { funcs, spawns };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const lineOf = (span: Span | undefined) => (span ? `${span.file}:${span.start[0] + 1}` : "");

const spawnNode = (s: Spawn): TreeNode => ({
  label: s.target,
  kind: s.kind,
  ...(s.api ? { detail: s.api } : {}),
  ...(s.node.span ? { span: s.node.span } : {}),
});

/** The execution model of a program: the process, its threads, and the coroutines and spawns inside them. */
export function executionTree(view: IRView): { tree: TreeView; spawns: Spawn[]; funcs: Func[] } {
  const { funcs, spawns } = collect(view);
  const spawnsByOwner = new Map<NodeId, Spawn[]>();
  const loose: Spawn[] = [];
  for (const s of spawns) {
    if (s.owner === undefined || !funcs.has(s.owner)) loose.push(s);
    else spawnsByOwner.set(s.owner, [...(spawnsByOwner.get(s.owner) ?? []), s]);
  }

  const interesting = [...funcs.values()]
    .filter((f) => f.async || f.generator || spawnsByOwner.has(f.id))
    .sort((a, b) => a.file.localeCompare(b.file) || (a.span?.start[0] ?? 0) - (b.span?.start[0] ?? 0));

  const modules = new Map<string, Func[]>();
  for (const f of interesting) modules.set(f.file, [...(modules.get(f.file) ?? []), f]);

  const moduleNodes: TreeNode[] = [...modules.entries()].map(([file, list]) => {
    const coros = list.filter((f) => f.async || f.generator).length;
    const starts = list.reduce((n, f) => n + (spawnsByOwner.get(f.id)?.length ?? 0), 0);
    const detail = [coros > 0 ? plural(coros, "coroutine") : "", starts > 0 ? plural(starts, "spawn") : ""].filter(Boolean).join(", ");
    return {
      label: file,
      kind: "module",
      detail,
      children: list.map((f): TreeNode => {
        const isCoroutine = f.async || f.generator;
        const flavor = f.async && f.generator ? "async generator" : f.async ? "async" : f.generator ? "generator" : "sync";
        const detail = isCoroutine ? `${flavor}, ${plural(f.awaits, "await")}` : "sync, starts work";
        const children = (spawnsByOwner.get(f.id) ?? []).map(spawnNode);
        return {
          label: f.name,
          kind: isCoroutine ? "coroutine" : "function",
          detail,
          ...(f.span ? { span: f.span } : {}),
          ...(children.length > 0 ? { children } : {}),
        };
      }),
    };
  });

  const coroutines = interesting.filter((f) => f.async || f.generator).length;
  const root: TreeNode = {
    label: "Program",
    kind: "process",
    detail: `${plural(spawns.filter((s) => s.kind === "process").length, "child process", "child processes")}, ${plural(spawns.filter((s) => s.kind === "thread").length, "worker thread")}`,
    children: [
      {
        label: "Main thread",
        kind: "thread",
        detail: `event loop, ${plural(coroutines, "coroutine")}`,
        children: [...moduleNodes, ...loose.map(spawnNode)],
      },
    ],
  };
  return { tree: { type: "tree", id: "execution", title: "Process, thread and coroutine tree", root }, spawns, funcs: [...funcs.values()] };
}

export const lensExecution: Lens = {
  id: "lens-execution",
  title: "Processes & threads",
  requires: ["structure", "concurrency"],

  async run(view): Promise<LensResult> {
    const { tree, spawns, funcs } = executionTree(view);

    const table: TableView = {
      type: "table",
      id: "spawn-sites",
      title: "Where work is started",
      columns: ["Starts", "Target", "API", "In function", "Location"],
      rows: spawns.map((s) => [
        s.kind === "process" ? "child process" : "worker thread",
        s.target,
        s.api,
        (s.owner !== undefined ? funcs.find((f) => f.id === s.owner)?.name : undefined) ?? "(top level)",
        lineOf(s.node.span),
      ]),
    };

    const findings: LensFinding[] = spawns
      .filter((s) => s.target === DYNAMIC)
      .map((s) => ({
        lens: "lens-execution",
        id: `dynamic-spawn:${s.node.id}`,
        severity: "info" as const,
        message: `A ${s.kind === "process" ? "child process" : "worker thread"} is started with a target that is not a literal`,
        nodes: [s.node.id],
        ...(s.node.span ? { span: s.node.span } : {}),
      }));

    const coroutines = funcs.filter((f) => f.async || f.generator);
    return {
      findings,
      views: [tree, table],
      metrics: {
        processes: 1 + spawns.filter((s) => s.kind === "process").length,
        threads: 1 + spawns.filter((s) => s.kind === "thread").length,
        coroutines: coroutines.length,
        awaits: coroutines.reduce((n, f) => n + f.awaits, 0),
        spawnSites: spawns.length,
      },
    };
  },
};

export default lensExecution;
