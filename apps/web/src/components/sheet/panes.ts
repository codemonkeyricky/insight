// The three-pane layout's sizing: the narrow-screen check, and the width of the side panes, kept across visits. Storage can be
// blocked, so every access is guarded and the default width stands in.
import { useCallback, useEffect, useState } from "react";
import { SHEET_MAX_WIDTH } from "./bottomSheet";

const NARROW_QUERY = `(max-width: ${SHEET_MAX_WIDTH}px)`;

/** True when the window is narrow enough for one column with drawers. */
export const isNarrow = (): boolean => typeof window !== "undefined" && typeof matchMedia === "function" && matchMedia(NARROW_QUERY).matches;

/** Whether the layout is narrow, kept current as the window resizes. */
export function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(isNarrow);
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const mq = matchMedia(NARROW_QUERY);
    const onChange = () => setNarrow(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return narrow;
}

export const PANE_MIN = 220;
export const PANE_MAX = 560;
export const TREE_KEY = "insight.treeWidth";
export const CODE_KEY = "insight.codeWidth";

/** A stored width, when it is a number within the pane's limits. */
export function readWidth(key: string, fallback: number): number {
  try {
    const v = Number(window.localStorage.getItem(key));
    return Number.isFinite(v) && v >= PANE_MIN && v <= PANE_MAX ? v : fallback;
  } catch {
    return fallback;
  }
}

function writeWidth(key: string, width: number): void {
  try {
    window.localStorage.setItem(key, String(width));
  } catch {
    // Storage blocked: the width lasts for this visit only.
  }
}

/** A pane width in px, kept in localStorage under `key`. `set` clamps to the pane limits and saves. */
export function usePaneWidth(key: string, fallback: number): [number, (next: number) => void] {
  const [width, setWidth] = useState(() => readWidth(key, fallback));
  const set = useCallback(
    (next: number) => {
      const clamped = Math.min(PANE_MAX, Math.max(PANE_MIN, Math.round(next)));
      setWidth(clamped);
      writeWidth(key, clamped);
    },
    [key],
  );
  return [width, set];
}
