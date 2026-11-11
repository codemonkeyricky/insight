import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type Ref } from "react";
import { createPortal } from "react-dom";

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
      {l.count !== undefined && l.count > 0 && <Count n={l.count} label={`${l.count} ${l.title.toLowerCase()}`} />}
    </a>
  );
  return (
    <nav className="sh-tabs" role="tablist" aria-label="Layers" ref={strip}>
      {pages.map(tab)}
      {lenses.length > 0 && (
        <>
          <span className="sh-tab-sep" role="presentation" aria-hidden="true" />
          <LensMenu lenses={lenses} />
        </>
      )}
    </nav>
  );
}

function Count({ n, label }: { n: number; label: string }) {
  return (
    <span className="badge-count" aria-label={label}>
      {n}
    </span>
  );
}

/**
 * The scope's lenses behind one tab. The tab reads "Lenses", or "Lenses: <name>" while a lens is open, and is selected then. The
 * menu floats over the page (a portal, so the strip's overflow does not clip it) and is a menu of links, one per lens.
 */
function LensMenu({ lenses }: { lenses: LayerLink[] }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  // ArrowDown on the closed tab opens the menu and moves focus to its first item once it is drawn.
  const focusFirst = useRef(false);
  const menuId = useId();
  const current = lenses.find((l) => l.current);
  const label = current ? `Lenses: ${current.title}` : "Lenses";

  const items = () => Array.from(menu.current?.querySelectorAll<HTMLAnchorElement>('[role="menuitem"]') ?? []);
  const show = () => {
    const r = trigger.current?.getBoundingClientRect();
    if (r) setPos({ top: r.bottom + 6, left: Math.max(8, Math.min(r.left, window.innerWidth - 248)) });
    setOpen(true);
  };
  // Closing with the keyboard returns focus to the tab; a pointer close leaves focus where the user put it.
  const close = (returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) trigger.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    if (focusFirst.current) {
      focusFirst.current = false;
      items()[0]?.focus();
    }
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close(true);
      }
    };
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!menu.current?.contains(t) && !trigger.current?.contains(t)) close(false);
    };
    // The menu is placed from the tab's position, so a resize or a scroll of the strip closes it rather than leaving it adrift.
    const onMove = () => close(false);
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    window.addEventListener("resize", onMove);
    window.addEventListener("scroll", onMove, true);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
      window.removeEventListener("resize", onMove);
      window.removeEventListener("scroll", onMove, true);
    };
    // close and items read refs and state setters only, so they are the same on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const onTriggerKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== "ArrowDown") return;
    e.preventDefault();
    if (open) items()[0]?.focus();
    else {
      focusFirst.current = true;
      show();
    }
  };
  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const list = items();
    const n = list.length;
    if (n === 0) return;
    const i = list.indexOf(document.activeElement as HTMLAnchorElement);
    if (e.key === "ArrowDown") list[i < 0 ? 0 : (i + 1) % n]?.focus();
    else if (e.key === "ArrowUp") list[i <= 0 ? n - 1 : i - 1]?.focus();
    else if (e.key === "Home") list[0]?.focus();
    else if (e.key === "End") list[n - 1]?.focus();
    else if (e.key === "Tab") close(false);
    else return;
    e.preventDefault();
  };

  return (
    <>
      <button
        ref={trigger}
        type="button"
        role="tab"
        className="sh-tab sh-tab-menu"
        aria-selected={current !== undefined}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => (open ? close(false) : show())}
        onKeyDown={onTriggerKey}
      >
        {label}
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
          <path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open &&
        pos &&
        createPortal(
          <LensPopover id={menuId} lenses={lenses} pos={pos} menuRef={menu} onKeyDown={onMenuKey} onPick={() => close(true)} />,
          document.body,
        )}
    </>
  );
}

/** The lens menu's panel: one menu item per lens, a link to the same lens tab. Exported for the tests, which render it directly. */
export function LensPopover({
  id,
  lenses,
  pos,
  menuRef,
  onKeyDown,
  onPick,
}: {
  id?: string;
  lenses: LayerLink[];
  pos?: { top: number; left: number };
  menuRef?: Ref<HTMLDivElement>;
  onKeyDown?: (e: KeyboardEvent<HTMLDivElement>) => void;
  onPick?: () => void;
}) {
  return (
    <div
      ref={menuRef}
      id={id}
      role="menu"
      aria-label="Lenses"
      className="sh-menu"
      style={pos ? { top: pos.top, left: pos.left } : undefined}
      onKeyDown={onKeyDown}
    >
      {lenses.map((l) => (
        <a
          key={l.id}
          role="menuitem"
          href={l.href}
          aria-current={l.current ? "page" : undefined}
          className={["sh-menu-item", l.dim ? "dim" : ""].filter(Boolean).join(" ")}
          title={l.reason}
          onClick={onPick}
        >
          {l.title}
          {l.count !== undefined && l.count > 0 && <Count n={l.count} label={`${l.count} ${l.title.toLowerCase()}`} />}
        </a>
      ))}
    </div>
  );
}
