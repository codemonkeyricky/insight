import { useCallback, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

/** A camera: the scale of the content and where its origin sits in the stage, in px. */
export interface Camera {
  k: number;
  x: number;
  y: number;
}

export interface FitOpts {
  /** Room kept between the content and the stage's edges, in px. */
  pad: number;
  maxK: number;
  minK: number;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** The camera that shows a `contentW` by `contentH` box in a `stageW` by `stageH` stage. Wide content is limited by the width, tall content by the height. */
export function fitBox(contentW: number, contentH: number, stageW: number, stageH: number, o: FitOpts): Camera {
  if (contentW <= 0 || contentH <= 0 || stageW <= 0 || stageH <= 0) return { k: 1, x: 0, y: 0 };
  const k = clamp(Math.min((stageW - 2 * o.pad) / contentW, (stageH - 2 * o.pad) / contentH), o.minK, o.maxK);
  const x = (stageW - contentW * k) / 2;
  // Content still taller than the stage at the chosen scale starts at its top edge; otherwise it is centred.
  const y = contentH * k > stageH ? o.pad : (stageH - contentH * k) / 2;
  return { k, x, y };
}

/** The zoom range of the wheel and the + and − buttons. Matches the System view. */
const MIN_K = 0.1;
const MAX_K = 2.5;
/** The fit of the Packages view: content at most 1.15 times its size, 16 px from the stage's edges, down to 0.1. */
const FIT: FitOpts = { pad: 16, maxK: 1.15, minK: 0.1 };
/** A pointer that moves more than this many px is a drag, not a click. */
const DRAG_PX = 3;
/** Room kept below the stage's top edge when it is not expanded, in px. */
const BOTTOM_ROOM = 12;

interface Drag {
  x: number;
  y: number;
  cx: number;
  cy: number;
  moved: boolean;
}

/**
 * Pan and zoom for a stage element, as the System view has them: the wheel zooms around the pointer, a drag pans, the + and −
 * buttons zoom around the centre, Fit refits the content, and Expand fills the window (Esc leaves). The stage's height is the
 * room the window leaves, at least 60% of the window, or the whole window while expanded. `moved()` tells a drag from a click:
 * it is true from the drag's first 3 px until the next press.
 */
export function usePanZoom(stageEl: HTMLDivElement | null, content: { w: number; h: number }) {
  const [cam, setCam] = useState<Camera>({ k: 1, x: 0, y: 0 });
  const [expanded, setExpanded] = useState(false);
  /** The stage's height in px when not expanded; null while expanded, so the window sets it. */
  const [stageH, setStageH] = useState<number | null>(null);
  const drag = useRef<Drag | null>(null);
  const movedRef = useRef(false);

  const fit = useCallback(() => {
    const vh = typeof window === "undefined" ? 900 : window.innerHeight;
    if (expanded) {
      const vw = typeof window === "undefined" ? 1440 : window.innerWidth;
      setStageH(null);
      setCam(fitBox(content.w, content.h, vw, vh, FIT));
      return;
    }
    const w = stageEl?.clientWidth ?? 900;
    // As tall as the window leaves room for below the stage's top edge, and at least 60% of the window.
    const room = stageEl ? vh - stageEl.getBoundingClientRect().top - BOTTOM_ROOM : 0;
    const h = Math.max(420, vh * 0.6, room);
    setStageH(h);
    setCam(fitBox(content.w, content.h, w, h, FIT));
  }, [stageEl, expanded, content.w, content.h]);

  // Fits when the content changes (a new layout), when the stage first mounts, and when it expands or collapses.
  useLayoutEffect(() => {
    fit();
  }, [fit]);

  // Esc leaves the expanded view.
  useLayoutEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExpanded(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded]);

  // The wheel zooms around the pointer. React's onWheel is passive, so the listener is added by hand.
  useLayoutEffect(() => {
    const el = stageEl;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      // The side panel scrolls itself.
      if ((e.target as Element).closest("aside")) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const px = e.clientX - r.left;
      const py = e.clientY - r.top;
      setCam((c) => {
        const k = Math.min(MAX_K, Math.max(MIN_K, c.k * Math.exp(-e.deltaY * 0.0015)));
        const s = k / c.k;
        return { k, x: px - (px - c.x) * s, y: py - (py - c.y) * s };
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [stageEl]);

  /** Zooms by `f` around the centre of the stage. */
  const zoomBy = (f: number) => {
    const px = (stageEl?.clientWidth ?? 800) / 2;
    const py = (stageEl?.clientHeight ?? 500) / 2;
    setCam((c) => {
      const k = Math.min(MAX_K, Math.max(MIN_K, c.k * f));
      const s = k / c.k;
      return { k, x: px - (px - c.x) * s, y: py - (py - c.y) * s };
    });
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    movedRef.current = false;
    if (e.button !== 0 || (e.target as Element).closest("button,a,input,label,aside")) return;
    drag.current = { x: e.clientX, y: e.clientY, cx: cam.x, cy: cam.y, moved: false };
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved && Math.abs(dx) + Math.abs(dy) > DRAG_PX) {
      d.moved = true;
      // Capture only now: capturing on press would retarget the click that a plain press makes.
      e.currentTarget.setPointerCapture?.(e.pointerId);
    }
    if (d.moved) setCam((c) => ({ ...c, x: d.cx + dx, y: d.cy + dy }));
  };
  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    movedRef.current = d?.moved ?? false;
  };

  return {
    cam,
    expanded,
    setExpanded,
    stageH,
    zoomBy,
    fit,
    /** True when the last press was a drag. The click that follows a drag is ignored by the caller. */
    moved: () => movedRef.current,
    pointer: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp },
  };
}
