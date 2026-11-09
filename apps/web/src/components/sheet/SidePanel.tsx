import { useEffect, type ReactNode } from "react";

interface Props {
  open: boolean;
  /** The panel's name for screen readers. */
  label: string;
  onClose: () => void;
  children: ReactNode;
}

/**
 * The floating glass card on the right of the sheet. It holds the source viewer and the exec panels. It stays mounted when
 * closed, so the map can hand it its panel; a closed panel is hidden and inert. Escape closes it unless an earlier handler
 * (the map, or the Find palette) already used the key.
 */
export function SidePanel({ open, label, onClose, children }: Props) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  return (
    <aside className={open ? "sh-side open" : "sh-side"} aria-label={label} aria-hidden={!open} inert={!open}>
      <button type="button" className="sh-close" aria-label="Close the side panel" onClick={onClose}>
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </button>
      <div className="sh-side-body">{children}</div>
    </aside>
  );
}
