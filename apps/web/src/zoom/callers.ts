// The callers of a function as the callers box lists them: one row per caller, however many reference rows join them
// (a call and a dispatch of the same caller are one row with both kinds). A reference row is a caller too when it invokes
// the function: `new X()`, JSX `<X/>` or an event handler registration (INVOKING_REFS). Any other reference (a function
// passed around as a value) is not listed; it is counted instead (valueRefCount), so the box can say it is called through.
// Pure, so the merge is unit tested.
import type { RefRow } from "@insight/model";

/**
 * One caller row: the caller's id and name, where it is, whether it is a function, the kinds of its edges except a plain
 * call, and whether every edge is only a candidate (a possible caller, not a certain one).
 */
export interface CallerRow {
  id: string;
  name: string;
  file: string;
  line: number;
  isFunction: boolean;
  kinds: string[];
  candidate: boolean;
}

/** The prefix of a callers box's key: the box is an expansion keyed by its function's id behind this prefix. */
const CALLERS_PREFIX = "callers:";

/** The key of a function's callers box. Like a chart's key it is the function's identity: one callers box per function. */
export const callersKey = (ref: string): string => `${CALLERS_PREFIX}${ref}`;

/** Whether an expansion key is a callers box's (see callersKey), not a function's. */
export const isCallersKey = (key: string): boolean => key.startsWith(CALLERS_PREFIX);

/** The function whose callers a callers box lists, from the box's key. A function's own key is returned as it is. */
export const refOfCallersKey = (key: string): string => (isCallersKey(key) ? key.slice(CALLERS_PREFIX.length) : key);

/** The edge kinds a caller row lists: a call, a dispatch and a spawn. */
const CALLER_KINDS: ReadonlySet<RefRow["kind"]> = new Set(["call", "dispatch", "spawn"]);

/**
 * The `how` values of a reference row that invoke the function, so its row is a caller: a construction (`new`), a JSX
 * render (`jsx`) or an event handler registration (`handler`). Other reference rows are not callers.
 */
export const INVOKING_REFS: ReadonlySet<string> = new Set(["new", "jsx", "handler"]);

/** The badge each invoking reference shows: a JSX render reads "renders"; "new" and "handler" show as they are. */
const REF_BADGE: ReadonlyMap<string, string> = new Map([
  ["new", "new"],
  ["jsx", "renders"],
  ["handler", "handler"],
]);

/** Whether a reference row is a caller: it invokes the function (INVOKING_REFS). */
const isInvokingRef = (r: Pick<RefRow, "kind" | "how">): boolean => r.kind === "reference" && r.how !== undefined && INVOKING_REFS.has(r.how);

/** Whether a row is a caller row at all: a call, dispatch or spawn, or a reference that invokes the function. */
const isCallerRow = (r: Pick<RefRow, "kind" | "how">): boolean => CALLER_KINDS.has(r.kind) || isInvokingRef(r);

/** Whether a row's caller is left out: an anonymous (λ) caller, unless the Lambdas choice shows it. */
const hiddenLambda = (r: Pick<RefRow, "name">, lambdas: boolean): boolean => !lambdas && r.name.startsWith("λ");

/**
 * The badge a caller's edge shows: "message" for a message dispatch, "new", "renders" (JSX) or "handler" for an invoking
 * reference, the kind for a spawn or dispatch, and none for a plain call.
 */
export function kindBadge(row: Pick<RefRow, "kind" | "how">): string | undefined {
  if (row.kind === "call") return undefined;
  if (row.kind === "reference") return row.how !== undefined ? REF_BADGE.get(row.how) : undefined;
  return row.kind === "dispatch" && row.how === "message" ? "message" : row.kind;
}

/**
 * The callers of a function, merged by caller id in the order the rows first show them. Rows that are not callers (a
 * reference that only passes the function as a value) are dropped; see valueRefCount. Anonymous (λ) callers are dropped
 * unless `lambdas` is set, as the reference lists drop them. A caller's line is the first non-zero line of its rows, and
 * it is a candidate only when all of its rows are.
 */
export function mergeCallers(rows: readonly RefRow[], lambdas: boolean): CallerRow[] {
  const byId = new Map<string, CallerRow>();
  for (const r of rows) {
    if (!isCallerRow(r)) continue;
    if (hiddenLambda(r, lambdas)) continue;
    const badge = kindBadge(r);
    const got = byId.get(r.id);
    if (got !== undefined) {
      if (badge !== undefined && !got.kinds.includes(badge)) got.kinds.push(badge);
      if (!r.candidate) got.candidate = false;
      if (got.line === 0 && r.line > 0) got.line = r.line;
      continue;
    }
    byId.set(r.id, { id: r.id, name: r.name, file: r.file, line: r.line, isFunction: r.isFunction, kinds: badge !== undefined ? [badge] : [], candidate: r.candidate });
  }
  return [...byId.values()];
}

/**
 * The number of distinct places that pass the function as a value: the ids of the reference rows that do not invoke it
 * (not in INVOKING_REFS). Anonymous (λ) places are left out unless `lambdas` is set, as mergeCallers leaves them out.
 */
export function valueRefCount(rows: readonly RefRow[], lambdas: boolean): number {
  const ids = new Set<string>();
  for (const r of rows) {
    if (r.kind !== "reference" || isInvokingRef(r)) continue;
    if (hiddenLambda(r, lambdas)) continue;
    ids.add(r.id);
  }
  return ids.size;
}
