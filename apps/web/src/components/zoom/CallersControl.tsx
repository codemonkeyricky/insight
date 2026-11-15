// The "◂ callers" button: a small header control that opens the callers box of a function. It sits in the header of a
// chart box, a nested frame, or a roots-only card, and it never selects or toggles the box it is in (a click stops there).
// It is a keyboard control too: Tab reaches it, Enter or Space presses it. Its look follows the close × and the chevron: the
// same hairline and fill tokens (see styles.css).
import { keyActivates } from "./keys";

/** The button's size, in world units (its text is kept readable by the label's own size rule in styles.css). */
export const CALLERS_BTN_W = 78;
export const CALLERS_BTN_H = 22;

export function CallersButton({ x, y, name, open, onClick }: { x: number; y: number; name: string; open: boolean; onClick: () => void }) {
  const label = `Show callers of ${name}`;
  return (
    <g
      className={`zm-callers-btn${open ? " is-open" : ""}`}
      role="button"
      tabIndex={0}
      aria-label={label}
      aria-pressed={open}
      onClick={(e) => {
        e.stopPropagation();
        e.preventDefault();
        onClick();
      }}
      onKeyDown={(e) => {
        if (!keyActivates(e.key)) return;
        e.stopPropagation();
        e.preventDefault();
        onClick();
      }}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <title>{label}</title>
      <rect x={x} y={y} width={CALLERS_BTN_W} height={CALLERS_BTN_H} rx={CALLERS_BTN_H / 2} className="zm-callers-bg" />
      <text x={x + CALLERS_BTN_W / 2} y={y + CALLERS_BTN_H / 2} dominantBaseline="central" textAnchor="middle">
        ◂ callers
      </text>
    </g>
  );
}
