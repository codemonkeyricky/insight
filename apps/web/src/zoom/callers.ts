// The callers of a function as the callers box lists them: one row per caller, however many reference rows join them
// (a call and a dispatch of the same caller are one row with both kinds). Pure, so the merge is unit tested.
import type { RefRow } from "@insight/model";

/** One caller row: the caller's id and name, where it is, whether it is a function, and the kinds of its edges except a plain call. */
export interface CallerRow {
  id: string;
  name: string;
  file: string;
  line: number;
  isFunction: boolean;
  kinds: string[];
}

/** The badge a reference kind shows: "message" for a message dispatch, the kind otherwise. A plain call has none. */
export function kindBadge(row: Pick<RefRow, "kind" | "how">): string | undefined {
  if (row.kind === "call") return undefined;
  return row.kind === "dispatch" && row.how === "message" ? "message" : row.kind;
}

/**
 * The callers of a function, merged by caller id in the order the rows first show them. Anonymous (λ) callers are dropped
 * unless `lambdas` is set, as the reference lists drop them. A caller's line is the first non-zero line of its rows.
 */
export function mergeCallers(rows: readonly RefRow[], lambdas: boolean): CallerRow[] {
  const byId = new Map<string, CallerRow>();
  for (const r of rows) {
    if (!lambdas && r.name.startsWith("λ")) continue;
    const badge = kindBadge(r);
    const got = byId.get(r.id);
    if (got !== undefined) {
      if (badge !== undefined && !got.kinds.includes(badge)) got.kinds.push(badge);
      if (got.line === 0 && r.line > 0) got.line = r.line;
      continue;
    }
    byId.set(r.id, { id: r.id, name: r.name, file: r.file, line: r.line, isFunction: r.isFunction, kinds: badge !== undefined ? [badge] : [] });
  }
  return [...byId.values()];
}
