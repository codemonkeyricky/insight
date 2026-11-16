import { footprintSummary, type CouplingFootprint, type FootprintEntry } from "./coupling.js";
import type { CouplingIndex } from "./index.js";

/** One row of a function's coupling footprint, as an agent reads it. */
export interface CouplingReportEntry {
  /** What the row says: a call label, an effect, a variable name (`◆ ` marks module-private state), `throws`. */
  label: string;
  /** A cross row: the callee's function id. A state row: the variable's node id. */
  target?: string;
  /** The file of the target node (the callee, or the variable), with a 1-based `line` of its declaration. */
  file?: string;
  line?: number;
}

/** One function of the report. */
export interface CouplingReportFunction {
  id: string;
  name: string;
  /** The function's source file, when the IR gives one (a file's top-level flow has none). */
  file?: string;
  /** The module (package, or top-level folder in a project without package metadata) the function belongs to. */
  module: string;
  /** The same one-line summary the canvas and the function panel show (`footprintSummary`). */
  summary: string;
  cross: CouplingReportEntry[];
  io: CouplingReportEntry[];
  state: CouplingReportEntry[];
  conc: CouplingReportEntry[];
  escape: CouplingReportEntry[];
}

/** The coupling footprint of a set of functions, in the JSON shape the CLI `--json` and the HTTP route share. */
export interface CouplingReport {
  functions: CouplingReportFunction[];
}

/** How to choose the functions a report covers. */
export interface CouplingReportOptions {
  /**
   * Exact function ids (from `CouplingIndex.functions`). When given, `scope` is ignored. This is what an `fn=` query uses.
   */
  ids?: Iterable<string>;
  /**
   * A file path or a folder prefix, relative to the project root and using `/`. A function is in scope when its file is
   * the scope or lies under it. `""` or `.` is the whole project, which is the default.
   */
  scope?: string;
}

const EMPTY: CouplingFootprint = { entries: [], modules: [], escape: false, state: { writes: 0, reads: 0, hidden: false } };

/** Code-unit order, so the output does not depend on the machine's locale. */
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The scope path with `\` as `/`, no empty or `.` segments; `""` stays the whole project. */
function normalizeScope(scope: string | undefined): string {
  if (scope === undefined) return "";
  return scope
    .replace(/\\/g, "/")
    .split("/")
    .filter((part) => part !== "" && part !== ".")
    .join("/");
}

/** The report entry of one footprint entry, with the target's declaration when the index knows it. */
function reportEntry(e: FootprintEntry, index: CouplingIndex): CouplingReportEntry {
  const out: CouplingReportEntry = { label: e.hidden === true ? `◆ ${e.label}` : e.label };
  if (e.target === undefined) return out;
  out.target = e.target;
  // A cross row points at a function; a state row points at a data.variable node. Both may have a source span.
  if (e.cls === "cross") {
    const fn = index.functions.get(e.target);
    if (fn?.file !== undefined) {
      out.file = fn.file;
      if (fn.line !== undefined) out.line = fn.line;
    }
  } else {
    const span = index.state.get(e.target)?.node.span;
    if (span !== undefined) {
      out.file = span.file;
      // IR spans are 0-based lines; the line an editor shows is start + 1.
      out.line = span.start[0] + 1;
    }
  }
  return out;
}

/** Entries in a stable order: by target (rows without one first), then label, then file and line. */
function sortedEntries(entries: Iterable<FootprintEntry>, index: CouplingIndex): CouplingReportEntry[] {
  return [...entries]
    .map((e) => reportEntry(e, index))
    .sort(
      (a, b) =>
        cmp(a.target ?? "", b.target ?? "") ||
        cmp(a.label, b.label) ||
        cmp(a.file ?? "", b.file ?? "") ||
        (a.line ?? 0) - (b.line ?? 0),
    );
}

/** The five class buckets of a footprint, each sorted the same way. */
function buckets(fp: CouplingFootprint, index: CouplingIndex) {
  const of = (cls: FootprintEntry["cls"]) => sortedEntries(fp.entries.filter((e) => e.cls === cls), index);
  return { cross: of("cross"), io: of("io"), state: of("state"), conc: of("conc"), escape: of("escape") };
}

/**
 * The coupling footprint of a project's functions as flat, JSON-serialisable rows: the same data the Flow tab's coupling
 * chart draws, grouped by class, for an agent that does not read the chart. `cross` rows name the callee, `state` rows the
 * variable; those two carry the target's declaration file and 1-based line when the IR has a span for it. `io`, `conc` and
 * `escape` rows have only a label, because the footprint records no site for them.
 *
 * Selection: `opts.ids` reports exactly those function ids; otherwise `opts.scope` is a file or folder prefix and the
 * default is the whole project. Functions are ordered by id, and every class bucket by target, label, file, line, so two
 * callers (the CLI and the HTTP route) produce the same bytes from the same snapshot.
 *
 * The function list includes functions with no coupling (`summary` is `no coupling`): an agent asking about one function
 * gets an answer, not an omission. The summary is `footprintSummary`, the string the canvas and the panel show.
 */
export function couplingReport(index: CouplingIndex, opts: CouplingReportOptions = {}): CouplingReport {
  const ids = opts.ids === undefined ? undefined : new Set(opts.ids);
  const scope = normalizeScope(opts.scope);
  const functions: CouplingReportFunction[] = [];
  for (const [id, fn] of index.functions) {
    if (ids !== undefined) {
      if (!ids.has(id)) continue;
    } else if (scope !== "") {
      const file = fn.file;
      if (file === undefined || !(file === scope || file.startsWith(`${scope}/`))) continue;
    }
    const fp = index.footprints.get(id) ?? EMPTY;
    functions.push({
      id,
      name: fn.name,
      ...(fn.file !== undefined ? { file: fn.file } : {}),
      module: index.modules.moduleOf(id) ?? ".",
      summary: footprintSummary(fp),
      ...buckets(fp, index),
    });
  }
  functions.sort((a, b) => cmp(a.id, b.id));
  return { functions };
}
