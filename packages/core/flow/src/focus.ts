import type { Item } from "./build.js";

/**
 * Effect kinds the inter-module focus hides: kernel access (files, OS, processes) and the environment. Network and clock
 * effects are kept. Extend this list to hide more kinds.
 */
export const HIDDEN_EFFECT_PREFIXES: readonly string[] = ["effects.fs.", "effects.os.", "effects.proc.", "effects.env."];

/** A function a chart may call: its file, and whether it is exported (`attrs.exported`). */
export interface FocusCallee {
  file: string;
  exported: boolean;
}

export interface FocusOptions {
  /** The file the chart belongs to. A call to a function of this file is never kept. */
  file: string;
  /** Every function that may be a call target, by id. A call to an id missing here is dropped. */
  callees: ReadonlyMap<string, FocusCallee>;
}

/**
 * The inter-module view of a chart. Keeps control flow, awaits, spawns, returns, throws, lock and sync rows, state rows,
 * handler rows and net or clock effects. Drops:
 * - kernel and environment effects (see HIDDEN_EFFECT_PREFIXES);
 * - calls that do not resolve to one exported function of another file (unresolved, candidate-only, same-file, internal), and
 *   an await of such a call (an await of only hidden effects goes too);
 * - the `finally` marker, while a `try` frame is unwrapped so its try and catch bodies are spliced inline in order;
 * - a branch, switch, loop or try whose bodies are all empty after filtering. A lock frame is never pruned.
 *
 * It runs after the chart is built (`convert`, `frameLocks`, `mergeStateReads`). The input is not changed.
 */
export function filterChartItems(items: readonly Item[], opts: FocusOptions): Item[] {
  return filterList(items, opts);
}

function hiddenEffect(kind: string | undefined): boolean {
  return kind !== undefined && HIDDEN_EFFECT_PREFIXES.some((p) => kind.startsWith(p));
}

/** A call row is kept only when it names one exported function of another file. */
function keepCall(item: Extract<Item, { t: "step" }>, opts: FocusOptions): boolean {
  if (item.target === undefined || item.targets !== undefined) return false;
  const callee = opts.callees.get(item.target);
  return callee !== undefined && callee.exported && callee.file !== opts.file;
}

/**
 * An await row is the await of what it wraps. An await of a call is kept only as that call is (see keepCall, so an await of
 * an unresolved or same-file call goes). An await of effects alone is kept unless every effect is hidden, so no bare
 * `await` is left behind a dropped kernel effect. An await of a plain value (no call, no effect) is control flow and stays.
 */
function keepAwait(item: Extract<Item, { t: "step" }>, opts: FocusOptions): boolean {
  const awaited = item.awaited;
  if (awaited === undefined) return item.target === undefined || keepCall(item, opts);
  if (awaited.call) return keepCall(item, opts);
  return awaited.effects.length === 0 || !awaited.effects.every(hiddenEffect);
}

function filterList(items: readonly Item[], opts: FocusOptions): Item[] {
  const out: Item[] = [];
  for (const item of items) {
    if (item.t === "step") {
      if (item.role === "marker") continue;
      // A handler row ("on ▸") is message coupling, so it is kept whatever its target.
      if (item.role === "call" && !item.handler && !keepCall(item, opts)) continue;
      if (item.role === "await" && !keepAwait(item, opts)) continue;
      if (item.role === "effect" && hiddenEffect(item.kind)) continue;
      out.push(item);
    } else if (item.t === "term") {
      out.push(item);
    } else if (item.t === "loop") {
      const body = filterList(item.body, opts);
      if (body.length > 0) out.push({ ...item, body });
    } else if (item.role === "try") {
      // The try frame is hidden, not its code: the try body and the catch body run inline, in order.
      for (const arm of item.arms) out.push(...filterList(arm.body, opts));
    } else {
      const arms = item.arms.map((arm) => ({ ...arm, body: filterList(arm.body, opts) }));
      // A lock frame stays even when empty: its acquire and release are sync rows the chart keeps.
      if (item.role !== "lock" && arms.every((arm) => arm.body.length === 0)) continue;
      out.push({ ...item, arms });
    }
  }
  return out;
}
