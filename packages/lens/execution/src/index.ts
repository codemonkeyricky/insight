import { ownerOf, type IRView, type Lens, type LensFinding, type LensResult, type TableView, type TreeNode, type TreeView } from "@insight/sdk";
import type { IRNode, NodeId, Span } from "@insight/ir";

const DYNAMIC = "<dynamic>";

export interface Spawn {
  node: IRNode;
  kind: "process" | "thread";
  target: string;
  api: string;
  owner: NodeId | undefined;
}

export interface Func {
  id: NodeId;
  name: string;
  file: string;
  async: boolean;
  generator: boolean;
  awaits: number;
  span?: Span;
}

/** processes: the scope starts work, so the tree shows the process model. functions: it starts none, so the tree shows its functions. */
export type ExecutionMode = "processes" | "functions";

export interface ExecutionModel {
  tree: TreeView;
  spawns: Spawn[];
  funcs: Func[];
  mode: ExecutionMode;
}

const text = (v: unknown, fallback: string): string => (typeof v === "string" && v !== "" ? v : fallback);

/**
 * True for a node that belongs to the scope. A stub that scopeDoc adds for an edge's far end is
 * not local: the lens never counts or lists it.
 */
const local = (n: IRNode): boolean => n.attrs.external !== true;

/** Every local function, with its counts, and every local spawn site. */
function collect(view: IRView): { funcs: Map<NodeId, Func>; spawns: Spawn[] } {
  const funcs = new Map<NodeId, Func>();
  const fileOf = (n: IRNode): string => n.span?.file ?? String(n.id).split("#")[0] ?? "";
  for (const fn of view.nodes({ facet: "structure", kind: "structure.function" })) {
    if (!local(fn)) continue;
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
    if (!local(n)) continue;
    const owner = ownerOf(view, n.id);
    const f = owner ? funcs.get(owner.id) : undefined;
    if (f) f.generator = true;
  }
  for (const n of view.nodes({ facet: "concurrency", kind: "concurrency.await" })) {
    if (!local(n)) continue;
    const owner = ownerOf(view, n.id);
    const f = owner ? funcs.get(owner.id) : undefined;
    if (f) f.awaits++;
  }
  const spawns: Spawn[] = [];
  for (const [kind, nodeKind] of [["process", "concurrency.spawn-process"], ["thread", "concurrency.spawn-thread"]] as const) {
    for (const n of view.nodes({ facet: "concurrency", kind: nodeKind })) {
      if (!local(n)) continue;
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

const byFileThenLine = (a: Func, b: Func): number =>
  a.file.localeCompare(b.file) || (a.span?.start[0] ?? 0) - (b.span?.start[0] ?? 0) || a.id.localeCompare(b.id);

interface FlowCounts {
  branches: number;
  loops: number;
  tries: number;
  effects: number;
}

/** Branches, loops, tries and effects, counted for the function that owns each node. */
function flowCounts(view: IRView): Map<NodeId, FlowCounts> {
  const counts = new Map<NodeId, FlowCounts>();
  const bump = (n: IRNode, key: keyof FlowCounts): void => {
    const owner = ownerOf(view, n.id);
    if (!owner) return;
    const c = counts.get(owner.id) ?? { branches: 0, loops: 0, tries: 0, effects: 0 };
    c[key]++;
    counts.set(owner.id, c);
  };
  for (const n of view.nodes({ facet: "flow", kind: "flow.branch" })) if (local(n)) bump(n, "branches");
  for (const n of view.nodes({ facet: "flow", kind: "flow.loop" })) if (local(n)) bump(n, "loops");
  for (const n of view.nodes({ facet: "flow", kind: "flow.try" })) if (local(n)) bump(n, "tries");
  for (const n of view.nodes({ facet: "effects" })) if (local(n)) bump(n, "effects");
  return counts;
}

/** One line per function: its flavour, then the counts that are not zero. */
function functionDetail(f: Func, c: FlowCounts | undefined): string {
  const flavor = f.async && f.generator ? "async generator" : f.async ? "async" : f.generator ? "generator" : "";
  const parts = [
    flavor,
    c && c.branches > 0 ? plural(c.branches, "branch", "branches") : "",
    c && c.loops > 0 ? plural(c.loops, "loop") : "",
    c && c.tries > 0 ? plural(c.tries, "try", "tries") : "",
    f.awaits > 0 ? plural(f.awaits, "await") : "",
    c && c.effects > 0 ? plural(c.effects, "effect") : "",
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : "no branches, loops or effects";
}

/**
 * The execution model of a program: the process, its threads, and the coroutines and spawns inside them.
 * When the scope starts no process or thread, the tree is the scope's functions instead, under `label`.
 */
export function executionTree(view: IRView, label = "project"): ExecutionModel {
  const { funcs, spawns } = collect(view);
  if (spawns.length === 0) return functionTree(view, funcs, label);

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
  return {
    tree: { type: "tree", id: "execution", title: "Process, thread and coroutine tree", root },
    spawns,
    funcs: [...funcs.values()],
    mode: "processes",
  };
}

/**
 * Function granularity, for a scope that starts no process or thread: its functions, grouped by
 * file when the scope has more than one. A scope with no functions gets an explicit empty state.
 */
function functionTree(view: IRView, funcs: Map<NodeId, Func>, label: string): ExecutionModel {
  const counts = flowCounts(view);
  const list = [...funcs.values()].sort(byFileThenLine);
  const row = (f: Func): TreeNode => ({
    label: f.name,
    kind: f.async || f.generator ? "coroutine" : "function",
    detail: functionDetail(f, counts.get(f.id)),
    ...(f.span ? { span: f.span } : {}),
  });

  const files = new Map<string, Func[]>();
  for (const f of list) files.set(f.file, [...(files.get(f.file) ?? []), f]);

  let root: TreeNode;
  if (list.length === 0) {
    root = {
      label,
      kind: "module",
      detail: "no functions",
      children: [{ label: "Nothing to show", kind: "empty", detail: "This scope has no functions, processes or threads" }],
    };
  } else if (files.size === 1) {
    root = { label, kind: "module", detail: plural(list.length, "function"), children: list.map(row) };
  } else {
    root = {
      label,
      kind: "module",
      detail: `${plural(list.length, "function")} in ${plural(files.size, "file")}`,
      children: [...files.entries()].map(([file, fs]) => ({
        label: file,
        kind: "module",
        detail: plural(fs.length, "function"),
        children: fs.map(row),
      })),
    };
  }
  return {
    tree: { type: "tree", id: "execution", title: "Function tree", root },
    spawns: [],
    funcs: list,
    mode: "functions",
  };
}

export const lensExecution: Lens = {
  id: "lens-execution",
  title: "Processes & threads",
  requires: ["structure", "concurrency"],

  async run(view, ctx): Promise<LensResult> {
    const label = ctx.scope || ctx.root.name || "project";
    const { tree, spawns, funcs, mode } = executionTree(view, label);

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
    const awaits = coroutines.reduce((n, f) => n + f.awaits, 0);
    const metrics: Record<string, number> =
      mode === "processes"
        ? {
            processes: 1 + spawns.filter((s) => s.kind === "process").length,
            threads: 1 + spawns.filter((s) => s.kind === "thread").length,
            coroutines: coroutines.length,
            awaits,
            spawnSites: spawns.length,
          }
        : { functions: funcs.length, coroutines: coroutines.length, awaits };
    return { findings, views: [tree, table], metrics };
  },
};

export default lensExecution;
