import { useEffect, useLayoutEffect, useRef } from "react";

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
 * scope and works from the keyboard and in a new tab. The strip scrolls sideways inside itself, with no scrollbar: a fade marks
 * an edge that has tabs past it, and the current tab is brought into view.
 */
export function LayerTabs({ links }: Props) {
  const strip = useRef<HTMLElement>(null);
  const currentId = links.find((l) => l.current)?.id;
  // The fade shows on an edge only while the strip has more tabs past it, so a strip that fits shows none.
  const fades = () => {
    const el = strip.current;
    if (!el) return;
    const past = el.scrollWidth - el.clientWidth - el.scrollLeft;
    el.style.setProperty("--fade-l", el.scrollLeft > 2 ? "24px" : "0px");
    el.style.setProperty("--fade-r", past > 2 ? "32px" : "0px");
  };
  // The current tab is kept in view when the page changes, so a lens past the edge is reachable and visible as current.
  useLayoutEffect(() => {
    const el = strip.current;
    const cur = el?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (el && cur) {
      const left = cur.offsetLeft;
      const right = left + cur.offsetWidth;
      if (left < el.scrollLeft + 12) el.scrollLeft = left - 12;
      else if (right > el.scrollLeft + el.clientWidth - 12) el.scrollLeft = right - el.clientWidth + 12;
    }
    fades();
    // The scroll follows the current tab only, not every re-render of the same page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentId]);
  useEffect(() => {
    const el = strip.current;
    if (!el) return;
    // The strip's width settles after the panes lay out, so the fade is measured again on the next frame and on each resize.
    fades();
    const frame = requestAnimationFrame(fades);
    // Web fonts settle after first paint, and they change the tabs' widths.
    void document.fonts?.ready.then(fades);
    // A tab's text or count can change without the strip resizing (the Findings count loads after the page), so the content is watched too.
    const mo = new MutationObserver(fades);
    mo.observe(el, { childList: true, subtree: true, characterData: true });
    const ro = new ResizeObserver(fades);
    ro.observe(el);
    for (const tab of el.children) ro.observe(tab);
    el.addEventListener("scroll", fades, { passive: true });
    window.addEventListener("resize", fades);
    return () => {
      cancelAnimationFrame(frame);
      mo.disconnect();
      ro.disconnect();
      el.removeEventListener("scroll", fades);
      window.removeEventListener("resize", fades);
    };
    // fades reads the strip only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
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
    <nav className="sh-tabs" role="tablist" aria-label="Layers" ref={strip}>
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
