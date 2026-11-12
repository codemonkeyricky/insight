// Logic for the lens tabs and lens pages of a scope. Only type imports, so the capture script can
// load the content rule (resultHasContent) directly, the same as scopeKey.ts.
import type { LensView, ScopeLensRow, ScopeStats, TreeNode, TreeView } from "./api";

/** The lens rows that get a tab: every row but the hidden ones (the manifest's `hidden` flag), in the order the server gave. */
export function tabbedLenses(rows: readonly ScopeLensRow[]): ScopeLensRow[] {
  return rows.filter((r) => !r.hidden);
}

export interface LensTab {
  id: string;
  title: string;
  /** A dimmed tab is still a link: opening it shows the lens, or why it has nothing. */
  dim: boolean;
  /** The tooltip of a dimmed tab. */
  reason?: string;
}

/** `runsOnOpen` is false in the static demo, where opening a lens that was not captured cannot run it. */
export function lensTab(row: ScopeLensRow, runsOnOpen = true): LensTab {
  if (row.status === "ok" && row.hasContent !== false) return { id: row.id, title: row.title, dim: false };
  return { id: row.id, title: row.title, dim: true, reason: dimReason(row, runsOnOpen) };
}

/**
 * The server's reason often starts with the status ("unavailable: scope ... has no X facts"). The page
 * already shows the status, so that prefix is dropped here.
 */
export function plainReason(reason: string | undefined, status: string): string {
  const text = reason ?? status;
  const prefix = `${status}: `;
  return text.startsWith(prefix) ? text.slice(prefix.length) : text;
}

function dimReason(row: ScopeLensRow, runsOnOpen: boolean): string {
  if (row.status === "unavailable" || row.status === "error") return plainReason(row.reason, row.status);
  if (row.status === "not-run") {
    return runsOnOpen ? "Not run on this scope yet. Opening it runs the lens." : "Not captured for this scope in the demo.";
  }
  return "Nothing to show for this scope.";
}

/** The line above a lens: what it covers and how big that is, for example "src/core · 12 nodes · 9 edges · 2 external". */
export function scopeBanner(label: string, stats: ScopeStats): string {
  return `${label} · ${stats.nodes} nodes · ${stats.edges} edges · ${stats.external} external`;
}

/** Processes and threads when the scope starts work, functions when it starts none. */
export type Granularity = "processes" | "functions";

/**
 * The granularity of the execution tree, from its root: a process root means the scope starts work.
 * Undefined when there is no execution tree or it has nothing in it.
 */
export function granularityOf(views: readonly LensView[]): Granularity | undefined {
  const tree = views.find((v): v is TreeView => v.type === "tree" && v.id === "execution");
  if (!tree) return undefined;
  if (tree.root.kind === "process") return "processes";
  return hasTreeNodes(tree.root) ? "functions" : undefined;
}

/** True when a tree has something under its root other than an empty-state placeholder. */
function hasTreeNodes(node: TreeNode): boolean {
  return (node.children ?? []).some((c) => c.kind !== "empty");
}

/** The group the Dependencies lens gives a module that the scope imports but does not contain. */
export const OUTSIDE_SCOPE = "(outside scope)";

/**
 * The text drawn beside a graph node. A file path shows its last two parts (`components/Workspace.tsx`),
 * so a crowded graph stays readable. The full path is still the label of a node once it is picked.
 */
export function nodeText(label: string): string {
  if (/\s/.test(label) || !label.includes("/")) return label;
  return label.split("/").slice(-2).join("/");
}

/** True when a view has something to draw or list. */
export function viewHasContent(view: LensView): boolean {
  if (view.type === "graph") return view.nodes.length > 0 || view.edges.length > 0;
  if (view.type === "table") return view.rows.length > 0;
  return hasTreeNodes(view.root);
}

/** The rule for a captured lens result: it has at least one finding, or a view with something in it. Metrics alone do not count. */
export function resultHasContent(result: { findings: readonly unknown[]; views: readonly LensView[] }): boolean {
  return result.findings.length > 0 || result.views.some(viewHasContent);
}
