import { enclosing, type IRView, type Lens, type LensFinding, type LensResult, type TableView } from "@insight/sdk";
import type { NodeId, Span } from "@insight/ir";

export interface ComplexityConfig {
  /** Functions above this cyclomatic complexity get a warning. Default 10. */
  maxComplexity?: number;
}

export interface FunctionComplexity {
  id: NodeId;
  name: string;
  /** 1 plus one per branch (switch included), loop and try. */
  complexity: number;
  branches: number;
  loops: number;
  tries: number;
  span?: Span;
}

const DEFAULT_MAX = 10;

/** Cyclomatic complexity per function, counted from flow records owned by each function. */
export function measureFunctions(view: IRView): FunctionComplexity[] {
  const byId = new Map<NodeId, FunctionComplexity>();
  for (const fn of view.nodes({ facet: "structure", kind: "structure.function" })) {
    byId.set(fn.id, {
      id: fn.id,
      name: String(fn.attrs.name ?? fn.id),
      complexity: 1,
      branches: 0,
      loops: 0,
      tries: 0,
      ...(fn.span ? { span: fn.span } : {}),
    });
  }
  // Kind queries are subkind-aware, so flow.switch and any plugin kind extending flow.branch count too.
  const count = (kind: string, field: "branches" | "loops" | "tries") => {
    for (const node of view.nodes({ facet: "flow", kind })) {
      const owner = enclosing(view, node.id, "structure.function");
      const entry = owner ? byId.get(owner.id) : undefined;
      if (entry) entry[field]++;
    }
  };
  count("flow.branch", "branches");
  count("flow.loop", "loops");
  count("flow.try", "tries");
  for (const entry of byId.values()) entry.complexity = 1 + entry.branches + entry.loops + entry.tries;
  return [...byId.values()].sort((a, b) => b.complexity - a.complexity || a.id.localeCompare(b.id));
}

const locationOf = (span: Span | undefined): string => (span ? `${span.file}:${span.start[0] + 1}` : "");

export const lensFlowComplexity: Lens = {
  id: "lens-flow-complexity",
  title: "Complexity",
  requires: ["structure", "flow"],

  async run(view, ctx): Promise<LensResult> {
    const config = (ctx.config ?? {}) as ComplexityConfig;
    const max = typeof config.maxComplexity === "number" && config.maxComplexity > 0 ? config.maxComplexity : DEFAULT_MAX;
    const functions = measureFunctions(view);

    const findings: LensFinding[] = functions
      .filter((f) => f.complexity > max)
      .map((f) => ({
        lens: "lens-flow-complexity",
        id: `complexity:${f.id}`,
        severity: "warning" as const,
        message: `${f.name} has complexity ${f.complexity}, above ${max}`,
        nodes: [f.id],
        ...(f.span ? { span: f.span } : {}),
      }));

    const table: TableView = {
      type: "table",
      id: "complexity",
      title: "Functions by complexity",
      columns: ["Function", "Complexity", "Branches", "Loops", "Try", "Location"],
      rows: functions.map((f) => [f.name, f.complexity, f.branches, f.loops, f.tries, locationOf(f.span)]),
    };

    return {
      findings,
      views: [table],
      metrics: {
        functions: functions.length,
        maxComplexity: functions.reduce((m, f) => Math.max(m, f.complexity), 0),
        overThreshold: findings.length,
        threshold: max,
      },
    };
  },
};

export default lensFlowComplexity;
