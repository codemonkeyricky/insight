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

/** The glass card at the bottom right of the sheet: the project's facts. `emphasis` marks it as the overview. */
export function TitleBlock({ facts, emphasis = false }: { facts: TitleFacts; emphasis?: boolean }) {
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
    <section className={emphasis ? "sh-card sh-title emph" : "sh-card sh-title"} aria-label="Title block">
      <dl className="sh-title-grid">
        {cells.map(([k, v, wide]) => (
          <div key={k} className={wide ? "wide" : undefined}>
            <dt>{k}</dt>
            <dd title={v}>{v}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
