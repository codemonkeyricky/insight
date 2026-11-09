/** The facts the title block shows. A value that is not known is "—". */
export interface TitleFacts {
  project: string;
  scope: string;
  selected: string;
  source: string;
  commit: string;
  indexed: string;
  files: string;
  /** The zone the focused node sits in, such as "C4". */
  zone?: string;
}

const DASH = "—";

/** A short commit id, or a dash when the snapshot has none. */
export const shortCommit = (commit?: string): string => (commit ? commit.slice(0, 7) : DASH);

/**
 * The glass card at the bottom right of the sheet: the project's facts. Compact by default, a single line of scope,
 * selection and zone; `expanded` shows the full table. `locked` (a chart is open) keeps it compact, so it never covers
 * the chart. `emphasis` marks it as the overview.
 */
export function TitleBlock({
  facts,
  emphasis = false,
  expanded = false,
  locked = false,
  onToggle,
}: {
  facts: TitleFacts;
  emphasis?: boolean;
  expanded?: boolean;
  locked?: boolean;
  onToggle?: () => void;
}) {
  const full = expanded && !locked;
  const cells: [string, string, boolean][] = [
    ["Project", facts.project, true],
    ["Scope", facts.scope, true],
    ["Selected", facts.selected, false],
    ["Zone", facts.zone ?? DASH, false],
    ["Source", facts.source, true],
    ["Commit", facts.commit, false],
    ["Indexed", facts.indexed, false],
    ["Files", facts.files, false],
  ];
  return (
    <section className={`sh-card sh-title${emphasis ? " emph" : ""}${full ? " full" : ""}`} aria-label="Title block">
      <div className="sh-title-line">
        <span className="sh-title-summary" title={`${facts.scope} · ${facts.selected} · ${facts.zone ?? DASH}`}>
          {facts.scope} · {facts.selected} · {facts.zone ?? DASH}
        </span>
        <button type="button" className="sh-title-toggle" aria-expanded={full} disabled={locked} onClick={onToggle}>
          {full ? "Less" : "Details"}
        </button>
      </div>
      {full && (
        <dl className="sh-title-grid">
          {cells.map(([k, v, wide]) => (
            <div key={k} className={wide ? "wide" : undefined}>
              <dt>{k}</dt>
              <dd title={v}>{v}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}
