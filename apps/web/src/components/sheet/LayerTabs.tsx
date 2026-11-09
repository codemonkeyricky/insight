/** One tab of the layers strip: a page of the project, or a lens of the scope. */
export interface LayerLink {
  id: string;
  title: string;
  href: string;
  current: boolean;
  group: "page" | "lens";
  /** A count shown after the title (the Findings tab's total). */
  count?: number;
  dim?: boolean;
  reason?: string;
}

interface Props {
  links: LayerLink[];
}

/**
 * The layers as tabs over the center pane: the project's pages, then the scope's lenses. Each tab is a link, so it keeps the
 * scope and works from the keyboard and in a new tab. The strip scrolls sideways inside itself on a phone.
 */
export function LayerTabs({ links }: Props) {
  const pages = links.filter((l) => l.group === "page");
  const lenses = links.filter((l) => l.group === "lens");
  const tab = (l: LayerLink) => (
    <a
      key={l.id}
      role="tab"
      href={l.href}
      aria-selected={l.current}
      aria-current={l.current ? "page" : undefined}
      className={["sh-tab", l.dim ? "dim" : ""].filter(Boolean).join(" ")}
      title={l.reason}
    >
      {l.title}
      {l.count !== undefined && l.count > 0 && (
        <span className="sh-count" aria-label={`${l.count} ${l.title.toLowerCase()}`}>
          {l.count}
        </span>
      )}
    </a>
  );
  return (
    <nav className="sh-tabs" role="tablist" aria-label="Layers">
      {pages.map(tab)}
      {lenses.length > 0 && (
        <>
          <span className="sh-tab-sep" role="presentation" aria-hidden="true" />
          {lenses.map(tab)}
        </>
      )}
    </nav>
  );
}
