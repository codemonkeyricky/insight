import picomatch from "picomatch";
import { edgeTargets, findCycles, isExternal, type GraphView, type IRView, type Lens, type LensFinding, type LensResult, type TableView } from "@insight/sdk";
import type { IREdge, NodeId } from "@insight/ir";

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

interface PairInfo {
  imports: number;
  calls: number;
  confidence: "exact" | "inferred" | "heuristic";
  span?: IREdge["span"];
}

/** A module, and whether the node it was found from is an external stub. */
interface ModuleRef {
  id: NodeId;
  external: boolean;
}

/**
 * The file that owns a node: the node itself when it is a file, else its nearest file ancestor.
 * An external function stub has no parent, so its module is the part of its id before "#" (the
 * TypeScript id convention "<file>#<name>"). That module is external.
 */
function moduleOf(view: IRView, id: NodeId): ModuleRef | undefined {
  const start = view.node(id);
  let cur = start;
  while (cur) {
    if (cur.kind === "structure.file") return { id: cur.id, external: isExternal(cur) };
    if (cur.parent === undefined) break;
    cur = view.node(cur.parent);
  }
  if (start !== undefined && isExternal(start)) {
    const file = String(id).split("#")[0];
    if (file !== undefined && file !== "" && file !== id) return { id: file, external: true };
  }
  return undefined;
}

const weakest = (a: PairInfo["confidence"], b: PairInfo["confidence"]): PairInfo["confidence"] => {
  const rank = { exact: 0, inferred: 1, heuristic: 2 } as const;
  return rank[a] >= rank[b] ? a : b;
};

/**
 * Module-level graph: imports and includes, plus calls lifted to the modules that contain them.
 * `local` holds the modules that have a node of their own in the view. Any other module is external.
 */
export function buildModuleGraph(view: IRView): {
  pairs: Map<string, PairInfo>;
  from: Map<string, [NodeId, NodeId]>;
  unresolved: number;
  local: Set<NodeId>;
} {
  const pairs = new Map<string, PairInfo>();
  const endpoints = new Map<string, [NodeId, NodeId]>();
  const local = new Set<NodeId>();
  let unresolved = 0;

  const add = (kind: "imports" | "calls", edge: IREdge, fromMod: ModuleRef, toMod: ModuleRef) => {
    if (fromMod.id === toMod.id) return;
    for (const m of [fromMod, toMod]) if (!m.external) local.add(m.id);
    const key = `${fromMod.id}\0${toMod.id}`;
    endpoints.set(key, [fromMod.id, toMod.id]);
    const info = pairs.get(key) ?? { imports: 0, calls: 0, confidence: edge.provenance.confidence };
    info[kind === "imports" ? "imports" : "calls"]++;
    info.confidence = weakest(info.confidence, edge.provenance.confidence);
    if (info.span === undefined && edge.span !== undefined && kind === "imports") info.span = edge.span;
    pairs.set(key, info);
  };

  const importEdges = [...view.edges({ facet: "packaging", kind: "packaging.import" }), ...view.edges({ facet: "packaging", kind: "packaging.include" })];
  for (const edge of importEdges) {
    const fromMod = moduleOf(view, edge.from);
    if (fromMod === undefined) continue;
    const targets = edgeTargets(edge);
    if (targets.unresolved) {
      // Only an import made inside the scope is this scope's unresolved import.
      if (!fromMod.external) unresolved++;
      continue;
    }
    for (const t of [...targets.nodes, ...targets.candidates]) {
      const toMod = moduleOf(view, t);
      if (toMod !== undefined) add("imports", edge, fromMod, toMod);
    }
  }

  for (const edge of view.edges({ facet: "calls", kind: "calls.call" })) {
    const fromMod = moduleOf(view, edge.from);
    if (fromMod === undefined) continue;
    for (const t of [...edgeTargets(edge).nodes]) {
      const toMod = moduleOf(view, t);
      if (toMod !== undefined) add("calls", edge, fromMod, toMod);
    }
  }
  return { pairs, from: endpoints, unresolved, local };
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

export default lensDependencies;
