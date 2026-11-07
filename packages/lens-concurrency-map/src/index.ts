import { ownerOf, type IRView, type Lens, type LensFinding, type LensResult, type TableView } from "@insight/sdk";
import type { NodeId, Span } from "@insight/ir";

interface Row {
  id: NodeId;
  name: string;
  async: boolean;
  tasks: number;
  awaits: number;
  spawns: number;
  channelOps: number;
  span?: Span;
}

const SPAWN_KINDS = ["concurrency.spawn-thread", "concurrency.spawn-process", "concurrency.coroutine"];
const CHANNEL_KINDS = ["concurrency.channel-send", "concurrency.channel-recv"];

/** Per-function counts of async tasks, awaits, spawns and channel operations. */
export function concurrencyRows(view: IRView): Row[] {
  const rows = new Map<NodeId, Row>();
  for (const fn of view.nodes({ facet: "structure", kind: "structure.function" })) {
    rows.set(fn.id, {
      id: fn.id,
      name: String(fn.attrs.name ?? fn.id),
      async: fn.attrs.async === true,
      tasks: 0,
      awaits: 0,
      spawns: 0,
      channelOps: 0,
      ...(fn.span ? { span: fn.span } : {}),
    });
  }
  const bump = (node: { id: NodeId; kind: string }, field: "tasks" | "awaits" | "spawns" | "channelOps") => {
    const owner = ownerOf(view, node.id);
    const row = owner ? rows.get(owner.id) : undefined;
    if (row) row[field]++;
  };
  for (const n of view.nodes({ facet: "concurrency", kind: "concurrency.async-task" })) bump(n, "tasks");
  for (const n of view.nodes({ facet: "concurrency", kind: "concurrency.await" })) bump(n, "awaits");
  for (const kind of SPAWN_KINDS) for (const n of view.nodes({ facet: "concurrency", kind })) bump(n, "spawns");
  for (const kind of CHANNEL_KINDS) for (const n of view.nodes({ facet: "concurrency", kind })) bump(n, "channelOps");
  return [...rows.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export const lensConcurrencyMap: Lens = {
  id: "lens-concurrency-map",
  title: "Concurrency",
  requires: ["structure", "concurrency"],

  async run(view): Promise<LensResult> {
    const rows = concurrencyRows(view);
    const active = rows.filter((r) => r.async || r.tasks + r.awaits + r.spawns + r.channelOps > 0);

    const findings: LensFinding[] = active
      .filter((r) => r.async && r.awaits === 0)
      .map((r) => ({
        lens: "lens-concurrency-map",
        id: `async-no-await:${r.id}`,
        severity: "info" as const,
        message: `${r.name} is async but never awaits`,
        nodes: [r.id],
        ...(r.span ? { span: r.span } : {}),
      }));

    const table: TableView = {
      type: "table",
      id: "concurrency",
      title: "Concurrency by function",
      columns: ["Function", "Async", "Tasks", "Awaits", "Spawns", "Channel ops", "Location"],
      rows: active.map((r) => [
        r.name,
        r.async ? "yes" : "no",
        r.tasks,
        r.awaits,
        r.spawns,
        r.channelOps,
        r.span ? `${r.span.file}:${r.span.start[0] + 1}` : "",
      ]),
    };

    return {
      findings,
      views: [table],
      metrics: {
        asyncFunctions: rows.filter((r) => r.async).length,
        awaits: rows.reduce((n, r) => n + r.awaits, 0),
        spawns: rows.reduce((n, r) => n + r.spawns, 0),
        channelOps: rows.reduce((n, r) => n + r.channelOps, 0),
        asyncWithoutAwait: findings.length,
      },
    };
  },
};

export default lensConcurrencyMap;
