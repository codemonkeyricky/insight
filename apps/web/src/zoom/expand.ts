// The zoom map's expanded set: the function boxes whose control-flow chart is drawn. Only these change it. Pure, so the
// rules are unit tested (test/expand.test.ts).

/**
 * What acts on a function box. A click on its box, a call to it from another chart, and a URL that names it all expand
 * it. Escape collapses the selected function. No other action touches the set.
 */
export type ExpandAction = "click" | "call" | "url" | "escape";

/**
 * The set after `action` on `id`. Expanding adds `id` and keeps every other expanded box, so a caller stays open when its
 * callee opens. Escape removes `id`, and with `under` (a test for "inside `id`") every expanded box inside it too, so a
 * closed container is not opened again by a chart inside it. Returns `prev` itself when nothing changes, so React skips
 * the update.
 */
export function expandedAfter(
  prev: ReadonlySet<string>,
  action: ExpandAction,
  id: string,
  under?: (other: string) => boolean,
): ReadonlySet<string> {
  const has = prev.has(id);
  if (action === "escape") {
    const inside = under === undefined ? [] : [...prev].filter(under);
    if (!has && inside.length === 0) return prev;
    const next = new Set(prev);
    next.delete(id);
    for (const other of inside) next.delete(other);
    return next;
  }
  if (has) return prev;
  return new Set(prev).add(id);
}
