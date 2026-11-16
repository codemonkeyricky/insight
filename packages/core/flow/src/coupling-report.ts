import { footprintSummary, type CouplingFootprint, type FootprintEntry } from "./coupling.js";
import type { CouplingFunction, CouplingIndex } from "./index.js";
import { normalizeScopeInput } from "./scope-input.js";

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

/**
 * How many functions one report lists, and how many entries one class bucket of one function lists. A whole-project
 * report of a large repository is otherwise unbounded and the hosted Function buffers its body. The cap applies to the
 * CLI, the local server and the hosted Function alike (they share this builder); when it cuts anything the JSON carries
 * `"truncated": true`, so a reader can tell a short report from a complete one.
 *
 * 200 functions × at most 50 footprint entries (FOOTPRINT_CAP) is a few hundred KB in practice, well inside the
 * Function's response budget. The per-class cap is a second guard for a footprint that hoists rows past the cap.
 */
export const COUPLING_REPORT_FUNCTION_LIMIT = 200;
export const COUPLING_REPORT_CLASS_LIMIT = 100;

/** The coupling footprint of a set of functions, in the JSON shape the CLI `--json` and the HTTP route share. */
export interface CouplingReport {
  functions: CouplingReportFunction[];
  /** Present and true only when the function or class cap cut the report. */
  truncated?: true;
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

/** The five class buckets of a footprint, each sorted the same way and capped; `truncated` says whether any was cut. */
function buckets(fp: CouplingFootprint, index: CouplingIndex): {
  cross: CouplingReportEntry[];
  io: CouplingReportEntry[];
  state: CouplingReportEntry[];
  conc: CouplingReportEntry[];
  escape: CouplingReportEntry[];
  truncated: boolean;
} {
  let truncated = false;
  const of = (cls: FootprintEntry["cls"]) => {
    const all = sortedEntries(fp.entries.filter((e) => e.cls === cls), index);
    if (all.length <= COUPLING_REPORT_CLASS_LIMIT) return all;
    truncated = true;
    return all.slice(0, COUPLING_REPORT_CLASS_LIMIT);
  };
  return { cross: of("cross"), io: of("io"), state: of("state"), conc: of("conc"), escape: of("escape"), truncated };
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
 *
 * The report is capped (see COUPLING_REPORT_FUNCTION_LIMIT and COUPLING_REPORT_CLASS_LIMIT): functions are sorted by id
 * before the cap, so the same snapshot always yields the same cut, and `truncated: true` marks a report the cap shortened.
 */
export function couplingReport(index: CouplingIndex, opts: CouplingReportOptions = {}): CouplingReport {
  const ids = opts.ids === undefined ? undefined : new Set(opts.ids);
  const scope = opts.scope === undefined ? "" : normalizeScopeInput(opts.scope);
  const selected: { id: string; fn: CouplingFunction }[] = [];
  for (const [id, fn] of index.functions) {
    if (ids !== undefined) {
      if (!ids.has(id)) continue;
    } else if (scope !== "") {
      const file = fn.file;
      if (file === undefined || !(file === scope || file.startsWith(`${scope}/`))) continue;
    }
    selected.push({ id, fn });
  }
  selected.sort((a, b) => cmp(a.id, b.id));
  let truncated = selected.length > COUPLING_REPORT_FUNCTION_LIMIT;
  const functions: CouplingReportFunction[] = [];
  for (const { id, fn } of selected.slice(0, COUPLING_REPORT_FUNCTION_LIMIT)) {
    const fp = index.footprints.get(id) ?? EMPTY;
    const { truncated: cut, ...bucketsOf } = buckets(fp, index);
    functions.push({
      id,
      name: fn.name,
      ...(fn.file !== undefined ? { file: fn.file } : {}),
      module: index.modules.moduleOf(id) ?? ".",
      summary: footprintSummary(fp),
      ...bucketsOf,
    });
    if (cut) truncated = true;
  }
  return truncated ? { functions, truncated: true } : { functions };
}
