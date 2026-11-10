// The control-flow chart's motion: which edges march, which back-edges send a pulse round their loop, and how many paths may
// animate at once. The rules are pure (test/flowMotion.test.ts). The hooks at the bottom only read the page: whether it is
// visible, whether a chart is on screen, and the budget the open charts share.
import { useEffect, useMemo, useState, useSyncExternalStore, type RefObject } from "react";
import type { FlowEdge, FlowNode } from "@insight/flow";

/** The most edges that march at once across the open charts. Past it, only the back-edges march. */
export const MARCH_BUDGET = 300;
/** A pulse's trip round a back-edge, in seconds. */
export const PULSE_S = 1.6;

/**
 * Which edges are back-edges, the ones that return to a loop's head. The layout marks them `back`. A chart that does not
 * mark them is read the same way: an edge into a loop's head from below it climbs back up the loop.
 */
export function backEdgeFlags(nodes: readonly FlowNode[], edges: readonly FlowEdge[]): boolean[] {
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  return edges.map((e) => {
    if (e.kind === "back") return true;
    const from = byId.get(e.from);
    const to = byId.get(e.to);
    return to !== undefined && to.shape === "loop" && from !== undefined && from.y > to.y;
  });
}

/** What one edge animates: its march overlay, and a pulse travelling along it. */
export interface EdgeMotion {
  march: boolean;
  pulse: boolean;
}

/**
 * The motion of each edge, given whether each is a back-edge. Off, or reduced motion, animates nothing. Otherwise every
 * edge marches when the chart's edges fit in `budget`; past it only the back-edges march. Only back-edges pulse.
 */
export function edgeMotions(back: readonly boolean[], opts: { on: boolean; reduced: boolean; budget: number }): EdgeMotion[] {
  if (!opts.on || opts.reduced) return back.map(() => ({ march: false, pulse: false }));
  const all = back.length <= opts.budget;
  return back.map((b) => ({ march: all || b, pulse: b }));
}

/** The class of a connector's group: its draw-in or retract, or a plain fade under reduced motion (no drawing). */
export function connectorClass(closing: boolean, reduced: boolean): string {
  if (reduced) return "zm-connector-group is-fade";
  return closing ? "zm-connector-group is-closing" : "zm-connector-group is-opening";
}

/** The page's own budget: every chart claims its edges here, in the order they opened, so the cap is shared. */
const claims = new Map<string, number>();

/**
 * Records that the chart `key` animates `edges` paths (0 when it is off screen or hidden), and returns how many paths the
 * charts before it leave for it. A chart opened later sees what the earlier ones take.
 */
export function claimMarch(key: string, edges: number): number {
  claims.set(key, edges);
  let used = 0;
  for (const [k, n] of claims) {
    if (k === key) break;
    used += n;
  }
  return Math.max(0, MARCH_BUDGET - used);
}

/** Frees a chart's claim when it leaves the map. */
export function releaseMarch(key: string): void {
  claims.delete(key);
}

/** The reader's reduced-motion choice (a platform setting). */
export function prefersReducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

const subscribeVisible = (cb: () => void) => {
  document.addEventListener("visibilitychange", cb);
  return () => document.removeEventListener("visibilitychange", cb);
};
const isVisible = () => typeof document === "undefined" || document.visibilityState !== "hidden";

/** Whether the page is visible. Hidden, the charts stop marching: their overlays are not drawn. */
export function usePageVisible(): boolean {
  return useSyncExternalStore(subscribeVisible, isVisible, () => true);
}

/** Whether the element is on screen. It starts true, so a chart is drawn before the observer reports. */
export function useOnScreen(ref: RefObject<Element | null>): boolean {
  const [on, setOn] = useState(true);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((entries) => setOn(entries.some((e) => e.isIntersecting)));
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);
  return on;
}

/** The budget this chart may spend on marching paths, claimed while it is shown on screen. */
export function useMarchBudget(key: string, edges: number, visible: boolean): number {
  const claimed = visible ? edges : 0;
  const budget = useMemo(() => claimMarch(key, claimed), [key, claimed]);
  useEffect(() => {
    claimMarch(key, claimed);
    return () => releaseMarch(key);
  }, [key, claimed]);
  return budget;
}
