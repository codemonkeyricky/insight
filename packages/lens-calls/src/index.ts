import { edgeTargets, type IRView, type Lens, type LensFinding, type LensResult, type TableView } from "@insight/sdk";
import type { NodeId } from "@insight/ir";

export interface CallsConfig {
  /** Function ids to start from. Default: every exported function. */
  entries?: string[];
}

/**
 * Reachability over calls.call edges, starting from entry points. Uncertain edges (candidate
 * sets) are followed, so a function is only reported unreachable when no possible call reaches it.
 */
export const lensCalls: Lens = {
  id: "lens-calls",
  title: "Call reachability",
  requires: ["structure", "calls"],

  async run(view, ctx): Promise<LensResult> {
    const config = (ctx.config ?? {}) as CallsConfig;
    const functions = view.nodes({ facet: "structure", kind: "structure.function" });
    const known = new Set(functions.map((f) => f.id));

    const findings: LensFinding[] = [];
    let entries: NodeId[];
    if (Array.isArray(config.entries)) {
      entries = [];
      for (const id of config.entries) {
        if (known.has(id)) entries.push(id);
        else findings.push({ lens: "lens-calls", id: `entry:${id}`, severity: "warning", message: `Configured entry ${id} is not a function in the index` });
      }
    } else {
      entries = functions.filter((f) => f.attrs.exported === true).map((f) => f.id);
    }

    const reach = view.trace(entries, { follow: ["calls.call"], direction: "out", uncertain: "may" });
    const entrySet = new Set(entries);

    for (const fn of functions) {
      if (reach.nodes.has(fn.id)) continue;
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
        const status = entrySet.has(fn.id) ? "entry" : depth === undefined ? "unreachable" : "reachable";
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

    return {
      findings,
      views: [reachability, unresolved, recursion],
      metrics: {
        functions: functions.length,
        entries: entries.length,
        reachable: reach.nodes.size,
        unreachable: functions.filter((f) => !reach.nodes.has(f.id)).length,
        unresolvedCalls: reach.deadEnds.length,
        recursiveGroups: reach.cycles.length,
      },
    };
  },
};

export default lensCalls;
