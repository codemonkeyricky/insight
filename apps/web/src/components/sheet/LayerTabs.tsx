import { useEffect, useLayoutEffect, useRef } from "react";

/** One tab of the layers strip: a page of the project. */
export interface LayerLink {
  id: string;
  title: string;
  href: string;
  current: boolean;
}

interface Props {
  links: LayerLink[];
}

/**
 * The layers as tabs over the center pane: the project's pages. Each tab is a link, so it
 * keeps the scope and works from the keyboard and in a new tab. The strip scrolls sideways inside itself, with no scrollbar: a
 * fade marks an edge that has tabs past it, and the current tab is brought into view.
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
    cur?.scrollIntoView({ block: "nearest", inline: "nearest" });
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
    // A tab's text can change without the strip resizing, so the content is watched too.
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
  return (
    <nav className="sh-tabs" role="tablist" aria-label="Layers" ref={strip}>
      {links.map((l) => (
        <a
          key={l.id}
          role="tab"
          href={l.href}
          aria-selected={l.current}
          aria-current={l.current ? "page" : undefined}
          className="sh-tab"
        >
          {l.title}
        </a>
      ))}
    </nav>
  );
}
