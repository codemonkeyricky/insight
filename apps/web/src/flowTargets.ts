import type { FlowNode, FunctionFlow, ScopeFlowStats } from "@insight/flow";
import { inScope } from "./router";

/** The file of an IR id such as `src/lib/math.ts#add`: the part before the '#'. An id with no '#' names a file. */
export function fileOfId(id: string): string {
  const at = id.indexOf("#");
  return at === -1 ? id : id.slice(0, at);
}

/** The name in an IR id such as `src/lib/math.ts#Counter.increment`: the part after the '#'. */
export function nameOfId(id: string): string {
  const at = id.indexOf("#");
  return at === -1 ? id : id.slice(at + 1);
}

/** True when a callee in `target` lies outside `scope`, so a chart of `scope` cannot resolve the call. */
export function outsideScope(target: string, scope: string): boolean {
  return !inScope(fileOfId(target), scope);
}

/**
 * The nearest scope that holds `file`: the smallest folder on the way up from `scope` (the scope itself
 * counts), or the project. Selecting that scope resolves a call to a function in `file`.
 */
export function nearestScopeContaining(scope: string, file: string): string {
  const parts = scope === "" ? [] : scope.split("/");
  for (let n = parts.length; n > 0; n--) {
    const folder = parts.slice(0, n).join("/");
    if (inScope(file, folder)) return folder;
  }
  return "";
}

/** Where a call to `target` made from a view of `scope` is resolved: the file it lands in and the scope that holds it. */
export function outsideCall(target: string, scope: string): { file: string; scope: string } {
  const file = fileOfId(target);
  return { file, scope: nearestScopeContaining(scope, file) };
}

/** The sentence that says why a call step is unresolved. */
export function outsideText(target: string): string {
  return `calls ${nameOfId(target)} in ${fileOfId(target)} — outside this scope. Select a parent folder to resolve it.`;
}

/** The share of a scope's calls that resolve inside it, rounded. Undefined when the scope has no calls. */
export function resolutionPercent(stats: Pick<ScopeFlowStats, "calls" | "resolved">): number | undefined {
  return stats.calls === 0 ? undefined : Math.round((stats.resolved / stats.calls) * 100);
}

/** A step of a chart that calls a function outside the scope: the step, the callee and the scope that resolves it. */
export interface OutsideStep {
  node: FlowNode;
  target: string;
  name: string;
  file: string;
  scope: string;
}

/** The unresolved steps of one function's chart. */
export function outsideSteps(fn: FunctionFlow, scope: string): OutsideStep[] {
  const out: OutsideStep[] = [];
  for (const node of fn.nodes) {
    const target = node.target;
    if (target === undefined || !outsideScope(target, scope)) continue;
    out.push({ node, target, name: nameOfId(target), ...outsideCall(target, scope) });
  }
  return out;
}
