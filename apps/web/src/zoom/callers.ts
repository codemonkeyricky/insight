// The callers of a function as the callers box lists them: one row per caller, however many reference rows join them
// (a call and a dispatch of the same caller are one row with both kinds). Pure, so the merge is unit tested.
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

/** The edge kinds a caller row lists. A reference (a function passed as a value) is not a caller, so it is left out. */
const CALLER_KINDS: ReadonlySet<RefRow["kind"]> = new Set(["call", "dispatch", "spawn"]);

/** The badge a reference kind shows: "message" for a message dispatch, the kind otherwise. A plain call has none. */
export function kindBadge(row: Pick<RefRow, "kind" | "how">): string | undefined {
  if (row.kind === "call") return undefined;
  return row.kind === "dispatch" && row.how === "message" ? "message" : row.kind;
}

/**
 * The callers of a function, merged by caller id in the order the rows first show them. Reference rows are not callers and
 * are dropped. Anonymous (λ) callers are dropped unless `lambdas` is set, as the reference lists drop them. A caller's line is
 * the first non-zero line of its rows, and it is a candidate only when all of its rows are.
 */
export function mergeCallers(rows: readonly RefRow[], lambdas: boolean): CallerRow[] {
  const byId = new Map<string, CallerRow>();
  for (const r of rows) {
    if (!CALLER_KINDS.has(r.kind)) continue;
    if (!lambdas && r.name.startsWith("λ")) continue;
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
