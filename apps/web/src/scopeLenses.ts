// The content rule for a captured lens result. The demo capture script (scripts/capture-demo.mjs) loads this file directly
// under Node's type stripping, so it keeps no value imports and needs no extension on any import.
import type { LensView, TreeNode } from "./api";

/** True when a view has something to draw or list. */
export function viewHasContent(view: LensView): boolean {
  if (view.type === "graph") return view.nodes.length > 0 || view.edges.length > 0;
  if (view.type === "table") return view.rows.length > 0;
  if (view.type === "state-machine") return view.transitions.length > 0;
  if (view.type === "schema-diagram") return view.entities.length > 0;
  return hasTreeNodes(view.root);
}

/** True when a tree has something under its root other than an empty-state placeholder. */
function hasTreeNodes(node: TreeNode): boolean {
  return (node.children ?? []).some((c) => c.kind !== "empty");
}

/** The rule for a captured lens result: it has at least one finding, or a view with something in it. Metrics alone do not count. */
export function resultHasContent(result: { findings: readonly unknown[]; views: readonly LensView[] }): boolean {
  return result.findings.length > 0 || result.views.some(viewHasContent);
}
