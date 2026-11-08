// Label level of detail for the zoom map. Labels keep a constant size on screen, so a box that is small on screen has
// too little room for its text. These helpers decide how many characters a box can show and how to cut the text. They
// are pure, so the rules are unit tested (test/lod.test.ts).

/** Width of one label character on screen, in px. 12px monospace (the function labels) is 0.6em, which is 7.2 px. */
export const LABEL_CHAR_PX = 7.2;
/** Room kept free on screen beside a label, in px: 12 px at each side of the box (see ZoomMap). */
export const LABEL_PAD_PX = 24;
/** A label is cut to at most this many characters when it does not fit; fewer than this and it is not drawn. */
export const MIN_LABEL_CHARS = 5;

const ELLIPSIS = "…";

/**
 * How many characters of a label fit in a box `boxScreenWidth` px wide on screen, after the padding. Zero when the box
 * has no room for even the padding.
 */
export function labelChars(boxScreenWidth: number, charPx = LABEL_CHAR_PX, padPx = LABEL_PAD_PX): number {
  if (!(boxScreenWidth > padPx)) return 0;
  return Math.floor((boxScreenWidth - padPx) / charPx);
}

/**
 * The label as it fits in `maxChars` characters, or null when fewer than MIN_LABEL_CHARS fit (draw no label).
 *
 * - A label that fits is returned whole.
 * - Otherwise it is cut to `maxChars` characters in all, the last one an ellipsis ("…"), so at least
 *   MIN_LABEL_CHARS - 1 characters of the text remain.
 * - A file-like label (one containing "/" or ".", such as "src/lib/ap.ts") keeps its END: the cut is taken from the
 *   front, giving "…ap.ts", because the file name is what a reader looks for. Other labels keep their start.
 *
 * The result is never longer than `maxChars`.
 */
export function fitLabel(label: string, maxChars: number): string | null {
  if (!(maxChars >= MIN_LABEL_CHARS)) return null;
  if (label.length <= maxChars) return label;
  const keep = maxChars - 1;
  if (/[/.]/.test(label)) return ELLIPSIS + label.slice(label.length - keep);
  return label.slice(0, keep) + ELLIPSIS;
}

/** The space between a frame header's label and its detail, in characters. */
const HEADER_GAP_CHARS = 2;

/**
 * The text a frame's header shows at a screen width: the label, and the detail at its right. The detail is dropped
 * first when the space is short: it is kept only when the label keeps at least MIN_LABEL_CHARS beside it, and the label
 * gets the width minus the detail's width. A detail that does not fit whole is never cut; it is dropped, and the label
 * takes the whole width.
 */
export function headerLabels(
  label: string,
  detail: string | undefined,
  boxScreenWidth: number,
): { label: string | null; detail: string | null } {
  const avail = labelChars(boxScreenWidth);
  let kept = detail ? fitLabel(detail, avail) : null;
  let room = kept !== null ? avail - kept.length - HEADER_GAP_CHARS : avail;
  if (kept !== null && room < MIN_LABEL_CHARS) {
    kept = null;
    room = avail;
  }
  return { label: fitLabel(label, room), detail: kept };
}

/**
 * The quarter-octave bucket of a camera scale: the map re-renders its labels only when the bucket changes, that is
 * once the zoom moves by a quarter of a doubling. `k` is a positive scale.
 */
export function lodBucket(k: number): number {
  return Math.round(Math.log2(k) * 4);
}

/** The scale a bucket stands for: the scale at the bucket's centre, 2^(bucket / 4). */
export const bucketScale = (bucket: number): number => 2 ** (bucket / 4);
