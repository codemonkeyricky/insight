import { edgeTargets, isExternal, type IRView, type Lens, type LensFinding, type LensResult, type TableView } from "@insight/sdk";
import type { NodeId } from "@insight/ir";

export interface CallsConfig {
  /** Function ids to start from. Default: every exported function. */
  entries?: string[];
}

/**
 * Local functions that a call from outside the scope can reach: the edge's caller is an external
 * stub, or is not in the view at all. Such a function may be reached from there, so it is not
 * reported as unreachable.
 */
function calledFromOutside(view: IRView, local: Set<NodeId>): Set<NodeId> {
  const out = new Set<NodeId>();
  for (const edge of view.edges({ facet: "calls", kind: "calls.call" })) {
    const caller = view.node(edge.from);
    if (caller !== undefined && !isExternal(caller)) continue;
    const targets = edgeTargets(edge);
    for (const t of [...targets.nodes, ...targets.candidates]) if (local.has(t)) out.add(t);
  }
  return out;
}

/** True when a function id's file is the scope or lies under it. Ids have the form "<file>#<name>". */
function idInScope(id: NodeId, scope: string): boolean {
  const file = id.split("#")[0] ?? "";
  return file === scope || file.startsWith(`${scope}/`);
}

/**
 * Reachability over calls.call edges, starting from entry points. Uncertain edges (candidate
 * sets) are followed, so a function is only reported unreachable when no possible call reaches it.
 *
 * In a scope (not the whole project) an entry or a caller may lie outside it. A function that such
 * a caller can reach is marked "called from outside" and is not reported. Outside entries are not
 * used, and external stubs are not listed or counted.
 */
export const lensCalls: Lens = {
  id: "lens-calls",
  title: "Call reachability",
  requires: ["structure", "calls"],

  async run(view, ctx): Promise<LensResult> {
    const config = (ctx.config ?? {}) as CallsConfig;
    const scope = ctx.scope ?? "";
    const partial = scope !== "";
    const functions = view.nodes({ facet: "structure", kind: "structure.function" }).filter((f) => !isExternal(f));
    const known = new Set(functions.map((f) => f.id));

    const findings: LensFinding[] = [];
    let entries: NodeId[];
    if (Array.isArray(config.entries)) {
      entries = [];
      for (const id of config.entries) {
        if (known.has(id)) entries.push(id);
        else if (!partial || idInScope(id, scope)) findings.push({ lens: "lens-calls", id: `entry:${id}`, severity: "warning", message: `Configured entry ${id} is not a function in the index` });
      }
    } else {
      // A program starts at its page or Node script entry, a module's exports are callable by anyone, and a
      // spawned thread (a worker module) starts at its own top level. These run without any project caller.
      const roots = new Set<NodeId>(functions.filter((f) => f.attrs.exported === true || f.attrs.htmlEntry === true || f.attrs.nodeEntry === true).map((f) => f.id));
      for (const e of view.edges({ kind: "concurrency.spawns" })) {
        for (const id of edgeTargets(e).nodes) if (known.has(id)) roots.add(id);
      }
      // A file no project file imports runs on its own (a script), so its top level is a root.
      const imported = new Set<string>();
      for (const e of view.edges({ kind: "packaging.import" })) for (const id of edgeTargets(e).nodes) imported.add(id);
      for (const e of view.edges({ kind: "packaging.re-export" })) for (const id of edgeTargets(e).nodes) imported.add(id);
      for (const f of functions) {
        if (f.attrs.module === true && !imported.has(f.span?.file ?? "")) roots.add(f.id);
      }
      entries = [...roots];
    }

    let reach = view.trace(entries, { follow: ["calls.call"], direction: "out", uncertain: "may" });
    // A closure exists once its creator runs, so what it calls is reachable too. The creator is a function, or
    // the file for module-level code, which runs when the file loads. Reaching a new closure can reach more
    // closures, so repeat until none is added.
    const closures = view
      .edges({ facet: "calls", kind: "calls.reference" })
      .filter((e) => e.attrs?.how === "closure" || e.attrs?.how === "handler")
      .map((e) => ({ from: e.from, to: edgeTargets(e).nodes[0] }))
      .filter((c): c is { from: NodeId; to: NodeId } => c.to !== undefined && known.has(c.to));
    const starts = new Set<NodeId>(entries);
    for (;;) {
      const added = closures.filter((c) => !starts.has(c.to) && (known.has(c.from) ? reach.nodes.has(c.from) : view.node(c.from)?.kind === "structure.file"));
      if (added.length === 0) break;
      for (const c of added) starts.add(c.to);
      reach = view.trace([...starts], { follow: ["calls.call"], direction: "out", uncertain: "may" });
    }
    const entrySet = new Set(entries);
    const outside = partial ? calledFromOutside(view, known) : new Set<NodeId>();

    for (const fn of functions) {
      if (reach.nodes.has(fn.id) || outside.has(fn.id)) continue;
      findings.push({
        lens: "lens-calls",
        id: `unreachable:${fn.id}`,
        severity: "info",
        message: `${String(fn.attrs.name ?? fn.id)} is not reachable from any entry point`,
        nodes: [fn.id],
        ...(fn.span ? { span: fn.span } : {}),
      });
    }

    const reachability: TableView = {
      type: "table",
      id: "reachability",
      title: "Reachability from entry points",
      columns: ["Function", "Status", "Depth", "Path from entry"],
      rows: functions.map((fn) => {
        const depth = reach.nodes.get(fn.id);
        const status = entrySet.has(fn.id)
          ? "entry"
          : depth !== undefined
            ? "reachable"
            : outside.has(fn.id)
              ? "called from outside"
              : "unreachable";
        const path = reach.pathsTo(fn.id);
        return [fn.id, status, depth ?? null, path ? path.join(" -> ") : null];
      }),
    };

    const unresolved: TableView = {
      type: "table",
      id: "unresolved-calls",
      title: "Calls that stop at an unresolved target",
      columns: ["From", "Scheme", "Target text"],
      rows: reach.deadEnds.map((d) => [d.from, d.unresolved.scheme, d.unresolved.text]),
    };

    const recursion: TableView = {
      type: "table",
      id: "recursion",
      title: "Recursive groups",
      columns: ["Functions", "Size"],
      rows: reach.cycles.map((group) => [group.join(" -> "), group.length]),
    };

    // Stubs are reached like any node, so they are left out of the reached count.
    const reached = [...reach.nodes.keys()].filter((id) => {
      const node = view.node(id);
      return node === undefined || !isExternal(node);
    }).length;

    return {
      findings,
      views: [reachability, unresolved, recursion],
      metrics: {
        functions: functions.length,
        entries: entries.length,
        reachable: reached,
        unreachable: functions.filter((f) => !reach.nodes.has(f.id) && !outside.has(f.id)).length,
        unresolvedCalls: reach.deadEnds.length,
        recursiveGroups: reach.cycles.length,
      },
    };
  },
};

export default lensCalls;
