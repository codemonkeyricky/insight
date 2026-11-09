import { useRef, type KeyboardEvent, type PointerEvent } from "react";

interface Props {
  /** The pane the handle resizes: `left` is the file tree (drag right grows it), `right` is the code pane (drag left grows it). */
  side: "left" | "right";
  label: string;
  width: number;
  /** Whether the pane it resizes is shown. A hidden pane's handle is hidden too. */
  shown: boolean;
  onResize: (next: number) => void;
}

/** Keyboard step for the handle, in px. */
const STEP = 16;

/**
 * The divider between a side pane and the center: a 1 px line with a wider hit area. It drags (with the pointer captured, so
 * a fast drag keeps resizing) and takes the arrow keys as a separator.
 */
export function Splitter({ side, label, width, shown, onResize }: Props) {
  const drag = useRef<{ x: number; w: number } | null>(null);
  const sign = side === "left" ? 1 : -1;

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    drag.current = { x: e.clientX, w: width };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const start = drag.current;
    if (start === null) return;
    onResize(start.w + sign * (e.clientX - start.x));
  };
  const end = () => {
    drag.current = null;
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const grow = (side === "left" && e.key === "ArrowRight") || (side === "right" && e.key === "ArrowLeft");
    const shrink = (side === "left" && e.key === "ArrowLeft") || (side === "right" && e.key === "ArrowRight");
    if (!grow && !shrink) return;
    e.preventDefault();
    onResize(width + (grow ? STEP : -STEP));
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={Math.round(width)}
      tabIndex={shown ? 0 : -1}
      className={`sh-split sh-split-${side}${shown ? "" : " is-off"}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onKeyDown={onKeyDown}
    />
  );
}
