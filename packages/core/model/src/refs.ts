import type { NodeId } from "@insight/ir";
import type { Rel, RelKind } from "./model.js";
import { anonymousOwned, describe, folded, INVOKING_HOWS, order } from "./refs-common.js";
import type { ScopeView } from "./view.js";

/**
 * One row of a function's reverse-reference lists. Rows with the same `id` and `kind` are one row, with `count` of
 * the relations between them. `file` and `line` locate the row's function (its definition). A row for a file (module-level
 * code that calls or references the function) names the file, and its line is the first call site.
 */
export interface RefRow {
  id: NodeId;
  name: string;
  file: string;
  line: number;
  /** True when the row is a function. A file row (module-level code) and any other node are not. */
  isFunction: boolean;
  kind: RelKind;
  /** The edge's `how`, from the first relation of the row, when the edge has one; an invoking how (INVOKING_HOWS) wins over a non-invoking one. */
  how?: string;
  /** True when every relation of the row is a candidate of a candidate set. */
  candidate: boolean;
  count: number;
  /** True when the row's function, or file, lies in the view. */
  inScope: boolean;
}

/** The two reverse-reference lists of a function, across the whole project. */
export interface Refs {
  /** What calls or references the function. Anonymous callers count as their parent (see docs/scoped-ir.md). */
  calledBy: RefRow[];
  /** What the function calls or references. Calls from its anonymous functions count as its own. */
  calls: RefRow[];
}

/**
 * The reverse references of a function, over the whole project. The view decides only `inScope`: the lists themselves
 * come from the project model, so a function's callers outside the scope are listed too. An id the model does not hold
 * has no references.
 */
export function refsOf(view: ScopeView, id: NodeId): Refs {
  const { model } = view;
  if (!model.byId.has(id)) return { calledBy: [], calls: [] };
  const owned = anonymousOwned(model);

  const callers = (model.in.get(id) ?? []).map((rel) => ({ rel, ...folded(model, rel) }));
  const callees = [id, ...(owned.get(id) ?? [])].flatMap((src) => (model.out.get(src) ?? []).map((rel) => ({ rel, other: rel.to })));

  return {
    calledBy: rowsOf(view, callers).sort(order),
    calls: rowsOf(view, callees).sort(order),
  };
}

/** Collapses the relations into one row per (function, kind), with the count and the first site. */
function rowsOf(view: ScopeView, items: Array<{ rel: Rel; other: NodeId; label?: string }>): RefRow[] {
  const groups = new Map<string, { row: RefRow; site?: { file: string; line: number } }>();
  for (const { rel, other, label } of items) {
    const key = `${other}\0${rel.kind}\0${label ?? ""}`;
    const site = rel.edge.span ? { file: rel.edge.span.file, line: rel.edge.span.start[0] + 1 } : undefined;
    const group = groups.get(key);
    if (group) {
      group.row.count++;
      group.row.candidate &&= rel.candidate;
      // The row keeps the first relation's how, unless a later one invokes the function and the first does not: a caller
      // that both renders <F/> and passes F as a value stays a caller whichever comes first.
      if (rel.how !== undefined && INVOKING_HOWS.has(rel.how) && !(group.row.how !== undefined && INVOKING_HOWS.has(group.row.how))) group.row.how = rel.how;
      if (site && (!group.site || site.file < group.site.file || (site.file === group.site.file && site.line < group.site.line))) group.site = site;
      continue;
    }
    const row = describe(view, other, rel.kind);
    if (label !== undefined) row.name = `${row.name} · ${label}`;
    row.count = 1;
    row.candidate = rel.candidate;
    if (rel.how !== undefined) row.how = rel.how;
    groups.set(key, { row, ...(site ? { site } : {}) });
  }
  return [...groups.values()].map(({ row, site }) => {
    if (row.file === "" && site) {
      row.file = site.file;
      row.line = site.line;
    }
    if (row.line === 0 && site) row.line = site.line;
    return row;
  });
}
