import picomatch from "picomatch";
import { findCycles, type GraphView, type Lens, type LensFinding, type LensResult, type TableView } from "@insight/sdk";
import type { NodeId } from "@insight/ir";
import { buildModuleGraph } from "@insight/model";

/** A layer rule the user writes in .insight/lenses/lens-dependencies.json. */
export interface DependencyRule {
  /** Glob over module paths: the importing side. */
  from: string;
  /** Globs over module paths the importing side must not depend on. */
  notDependOn: string[];
  reason?: string;
}

export interface DependencyConfig {
  rules?: DependencyRule[];
}

export const lensDependencies: Lens = {
  id: "lens-dependencies",
  title: "Dependencies",
  requires: ["structure", "packaging"],
  optional: ["calls"],

  async run(view, ctx): Promise<LensResult> {
    const config = (ctx.config ?? {}) as DependencyConfig;
    const rules = Array.isArray(config.rules) ? config.rules : [];
    const { pairs, from, unresolved, local } = buildModuleGraph(view);

    const modules = new Set<NodeId>();
    const importAdjacency = new Map<NodeId, NodeId[]>();
    for (const [key, info] of pairs) {
      const [a, b] = from.get(key) as [NodeId, NodeId];
      modules.add(a);
      modules.add(b);
      if (info.imports > 0) {
        const list = importAdjacency.get(a) ?? [];
        if (!list.includes(b)) list.push(b);
        importAdjacency.set(a, list);
      }
    }
    const sortedModules = [...modules].sort();

    const cycles = findCycles(sortedModules, importAdjacency);
    const findings: LensFinding[] = cycles.map((group) => ({
      lens: "lens-dependencies",
      id: `cycle:${group.join("|")}`,
      severity: "warning",
      message: `Import cycle between ${group.length} modules: ${[...group, group[0] ?? ""].join(" -> ")}`,
      nodes: group,
    }));

    rules.forEach((rule, index) => {
      const fromMatch = picomatch(rule.from);
      const toMatches = (rule.notDependOn ?? []).map((g) => picomatch(g));
      for (const [key, info] of pairs) {
        if (info.imports === 0) continue;
        const [a, b] = from.get(key) as [NodeId, NodeId];
        // A rule is checked on the importing side, so only an importer inside the scope can break it.
        if (!local.has(a)) continue;
        if (!fromMatch(a) || !toMatches.some((m) => m(b))) continue;
        findings.push({
          lens: "lens-dependencies",
          id: `rule:${index}:${a}>${b}`,
          severity: "error",
          message: `${a} imports ${b}, which rule ${index} forbids${rule.reason ? ` (${rule.reason})` : ""}`,
          nodes: [a, b],
          ...(info.span ? { span: info.span } : {}),
        });
      }
    });

    const graph: GraphView = {
      type: "graph",
      id: "modules",
      title: "Module graph",
      nodes: sortedModules.map((m) => {
        const node = view.node(m);
        const path = m;
        const slash = path.lastIndexOf("/");
        return {
          id: m,
          label: path,
          group: !local.has(m) ? "(outside scope)" : slash >= 0 ? path.slice(0, slash) : ".",
          ...(node?.span ? { span: node.span } : {}),
        };
      }),
      edges: [...pairs.entries()].flatMap(([key, info]) => {
        const [a, b] = from.get(key) as [NodeId, NodeId];
        const out: GraphView["edges"] = [];
        if (info.imports > 0) out.push({ from: a, to: b, kind: "import", label: String(info.imports), confidence: info.confidence, ...(info.span ? { span: info.span } : {}) });
        if (info.calls > 0) out.push({ from: a, to: b, kind: "call", label: String(info.calls), confidence: info.confidence });
        return out;
      }),
    };

    const cycleTable: TableView = {
      type: "table",
      id: "cycles",
      title: "Import cycles",
      columns: ["Modules", "Size"],
      rows: cycles.map((group) => [group.join(" -> "), group.length]),
    };

    const importCount = [...pairs.values()].filter((p) => p.imports > 0).length;
    const callCount = [...pairs.values()].filter((p) => p.calls > 0).length;
    return {
      findings: findings.map((f) => ({ ...f, lens: "lens-dependencies" })) as LensFinding[],
      views: [graph, cycleTable],
      metrics: {
        modules: sortedModules.filter((m) => local.has(m)).length,
        externalModules: sortedModules.filter((m) => !local.has(m)).length,
        importPairs: importCount,
        callPairs: callCount,
        cycles: cycles.length,
        unresolvedImports: unresolved,
        ruleViolations: findings.filter((f) => f.id.startsWith("rule:")).length,
      },
    };
  },
};

// The module graph and architecture model live in @insight/model. Re-exported so this lens's public API is unchanged.
export {
  archModel,
  buildModuleGraph,
  defaultLayerOf,
  topDirLayerOf,
  DEFAULT_LAYERS,
  type ArchModel,
  type ArchOptions,
  type ArchPackage,
  type ArchEdge,
  type ArchUnresolved,
  type ArchViolation,
  type ArchFile,
  type ArchFileImport,
  type UnresolvedImport,
} from "@insight/model";

export default lensDependencies;
