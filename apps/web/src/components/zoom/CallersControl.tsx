// The "◂ callers" button: a small header control that opens the callers box of a function. It sits in the header of a
// chart box, a nested frame, or a grid card, and it never selects or toggles the box it is in (a click stops there).
// It is a keyboard control too: Tab reaches it, Enter or Space presses it. Its look follows the close × and the chevron: the
// same hairline and fill tokens (see styles.css).
import { keyActivates } from "./keys";

/** The button's size, in world units (its text is kept readable by the label's own size rule in styles.css). */
export const CALLERS_BTN_W = 78;
export const CALLERS_BTN_H = 22;
/** The compact button's width: the ◂ alone, for a card whose name needs the room, or a map zoomed out (see FULL_K). */
export const CALLERS_COMPACT_W = 26;

/**
 * The label keeps its size on screen (11 px) while the pill zooms with the map, so a zoomed-out pill is too small for it:
 * below FULL_K the button is compact (the ◂ alone), and below GLYPH_K, where the pill is shorter than the glyph, it is not
 * drawn.
 */
const LABEL_PX = 64;
const GLYPH_PX = 10;
export const FULL_K = LABEL_PX / CALLERS_BTN_W;
export const GLYPH_K = GLYPH_PX / CALLERS_BTN_H;

/** The width the button takes at scale `k`: the full pill, the compact one, or none when it is not drawn (see GLYPH_K). */
export function callersChipW(k: number, compact = false): number {
  if (k < GLYPH_K) return 0;
  return compact || k < FULL_K ? CALLERS_COMPACT_W : CALLERS_BTN_W;
}

/**
 * `x` is the left edge of the button, full or compact: the button sits at the left of a header, before the function's name. Its box opens to the left only on an in-place chart; on a chart opened from a call step it opens to the right (see expand.ts's opensLeft). `k` is the
 * map's label scale (lod.ts): the pill's size on screen is its size times `k`. `compact` asks for the ◂ alone at any scale.
 */
export function CallersButton({ x, y, name, open, onClick, k = 1, compact = false }: { x: number; y: number; name: string; open: boolean; onClick: () => void; k?: number; compact?: boolean }) {
  if (k < GLYPH_K) return null;
  const small = compact || k < FULL_K;
  const w = small ? CALLERS_COMPACT_W : CALLERS_BTN_W;
  const left = x;
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
      <rect x={left} y={y} width={w} height={CALLERS_BTN_H} rx={CALLERS_BTN_H / 2} className="zm-callers-bg" />
      <text x={left + w / 2} y={y + CALLERS_BTN_H / 2} dominantBaseline="central" textAnchor="middle">
        {small ? "◂" : "◂ callers"}
      </text>
    </g>
  );
}
