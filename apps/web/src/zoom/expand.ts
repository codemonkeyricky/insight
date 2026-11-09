// The zoom map's expanded set: the function boxes whose control-flow chart is drawn. Only these change it. Pure, so the
// rules are unit tested (test/expand.test.ts).

/**
 * What acts on a function box. A click on its box, a call to it from another chart, and a URL that names it all expand
 * it. Escape collapses the selected function. No other action touches the set.
 */
export type ExpandAction = "click" | "call" | "url" | "escape";

/**
 * The set after `action` on `id`. Expanding adds `id` and keeps every other expanded function, so a caller stays open
 * when its callee opens. Escape removes `id` alone. Returns `prev` itself when nothing changes, so React skips the update.
 */
export function expandedAfter(prev: ReadonlySet<string>, action: ExpandAction, id: string): ReadonlySet<string> {
  const has = prev.has(id);
  if (action === "escape") {
    if (!has) return prev;
    const next = new Set(prev);
    next.delete(id);
    return next;
  }
  if (has) return prev;
  return new Set(prev).add(id);
}
