import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { EASE_OUT, lerpCamera, prefersReducedMotion, REVEAL_MARGIN, revealPan, TWEEN_MS, type Camera, type Rect } from "../../symbols/camera";

export type { Camera } from "../../symbols/camera";

export interface FitOpts {
  /** Room kept between the content and the stage's edges, in px. */
  pad: number;
  maxK: number;
  /** The smallest scale a fit settles on. A wider drawing is then left-aligned and panned, so its text stays readable. */
  fitMinK: number;
  /** Room kept above the content, in px, when set: the content sits below it, whether it is taller than the stage or centred. */
  padTop?: number;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/**
 * The camera that fits a `contentW` by `contentH` box in a `stageW` by `stageH` stage. The scale is limited by the width or the
 * height, clamped to [fitMinK, maxK]. Content wider than the stage at that scale sits at the left pad; narrower content is centred.
 * Content taller than the stage sits at the top pad; shorter content is centred vertically (and never above `padTop`, when set).
 */
export function fitBox(contentW: number, contentH: number, stageW: number, stageH: number, o: FitOpts): Camera {
  if (contentW <= 0 || contentH <= 0 || stageW <= 0 || stageH <= 0) return { k: 1, x: 0, y: 0 };
  const k = clamp(Math.min((stageW - 2 * o.pad) / contentW, (stageH - 2 * o.pad) / contentH), o.fitMinK, o.maxK);
  const x = contentW * k > stageW ? o.pad : (stageW - contentW * k) / 2;
  const yTall = contentH * k > stageH;
  const yCentred = (stageH - contentH * k) / 2;
  const y = o.padTop === undefined ? (yTall ? o.pad : yCentred) : Math.max(o.padTop, yTall ? o.padTop : yCentred);
  return { k, x, y };
}

/** The zoom range of the wheel and the + and − buttons. Matches the System view. */
const MIN_K = 0.1;
const MAX_K = 2.5;
/** The fit of the Packages view: its floor matches the System view's FIT_MIN_K, content at most 1.15 times its size, 16 px from the edges. */
const FIT: FitOpts = { pad: 16, maxK: 1.15, fitMinK: 0.56 };
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
 * buttons zoom around the centre, Fit refits the content (never below `fitMinK`, so text stays readable), and Expand fills the window
 * (Esc leaves). The stage's height is the room the window leaves, at least 60% of the window, or the whole window while expanded.
 * `moved()` tells a drag from a click: it is true from the drag's first 3 px until the click that follows it.
 *
 * The camera changes instantly on a wheel, a drag and an automatic fit. The buttons' Fit, + and −, and `animateTo` tween it over
 * 320 ms; a wheel, a press, an automatic fit or another tween stops a running tween. Under reduced motion every change is instant.
 * A zoom button pressed during a tween compounds from the tween's target, so quick presses add up.
 */
export interface PanZoomOpts {
  /** The smallest scale a fit settles on (default FIT.fitMinK). */
  fitMinK?: number;
  /** The largest scale a fit settles on (default FIT.maxK). */
  maxK?: number;
  /** The stage's height in px, when the caller sizes the stage itself. Fit then uses it, and the stage does not set its own height. */
  height?: number;
  /**
   * Whether the camera fits the content by itself when the content changes, the stage mounts, or it expands (default true). When
   * false the camera starts with its origin at `bandTop` and only the Fit button fits it.
   */
  autoFit?: boolean;
  /**
   * Px at the top of the stage reserved for controls laid over it (default 0). A fit and a reveal keep content below it, and the
   * camera starts with its origin there.
   */
  bandTop?: number;
  /**
   * Receives each camera change in place of a re-render: the owner writes the transform to the DOM. When given, camera changes do
   * not re-render the owner, so a drag or a tween frame costs one style write.
   */
  applyTo?: (cam: Camera) => void;
}

export function usePanZoom(stageEl: HTMLDivElement | null, content: { w: number; h: number }, opts: PanZoomOpts = {}) {
  const fitMinK = opts.fitMinK ?? FIT.fitMinK;
  const maxK = opts.maxK ?? FIT.maxK;
  const height = opts.height;
  const autoFit = opts.autoFit ?? true;
  const bandTop = opts.bandTop ?? 0;
  // The camera lives in a ref, so a tween step or a drag reads the latest value at once; a redraw re-renders the stage.
  const camRef = useRef<Camera>({ k: 1, x: 0, y: bandTop });
  // The camera a running tween is heading to, so a zoom pressed during the tween starts from there.
  const targetRef = useRef<Camera | null>(null);
  const applyRef = useRef(opts.applyTo);
  applyRef.current = opts.applyTo;
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const [expanded, setExpanded] = useState(false);
  /** The stage's height in px when not expanded; null while expanded, so the window sets it. */
  const [stageH, setStageH] = useState<number | null>(null);
  const drag = useRef<Drag | null>(null);
  const movedRef = useRef(false);
  const tween = useRef<number | null>(null);

  const setCamera = useCallback((next: Camera) => {
    camRef.current = next;
    const apply = applyRef.current;
    if (apply) apply(next);
    else redraw();
  }, []);

  const cancelTween = useCallback(() => {
    if (tween.current !== null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(tween.current);
    tween.current = null;
    targetRef.current = null;
  }, []);

  /** Moves the camera to `target` over TWEEN_MS with the ease-out curve. Reduced motion, or no animation frames, jumps. */
  const animateTo = useCallback(
    (target: Camera) => {
      cancelTween();
      if (prefersReducedMotion() || typeof requestAnimationFrame !== "function") {
        setCamera(target);
        return;
      }
      const from = camRef.current;
      targetRef.current = target;
      let t0: number | null = null;
      const step = (now: number) => {
        if (t0 === null) t0 = now;
        const p = Math.min(1, (now - t0) / TWEEN_MS);
        if (p >= 1) {
          tween.current = null;
          targetRef.current = null;
          setCamera(target);
          return;
        }
        setCamera(lerpCamera(from, target, EASE_OUT(p)));
        tween.current = requestAnimationFrame(step);
      };
      tween.current = requestAnimationFrame(step);
    },
    [cancelTween, setCamera],
  );

  /** The camera that fits the content, and the stage height it implies (null when the window or the caller sets it). */
  const fitTarget = useCallback((): { cam: Camera; stageH: number | null } => {
    const fo: FitOpts = { ...FIT, fitMinK, maxK, padTop: bandTop > 0 ? bandTop : undefined };
    const vh = typeof window === "undefined" ? 900 : window.innerHeight;
    if (expanded) {
      const vw = typeof window === "undefined" ? 1440 : window.innerWidth;
      return { cam: fitBox(content.w, content.h, vw, vh, fo), stageH: null };
    }
    const w = stageEl?.clientWidth ?? 900;
    if (height !== undefined) return { cam: fitBox(content.w, content.h, w, height, fo), stageH: null };
    // As tall as the window leaves room for below the stage's top edge, and at least 60% of the window.
    const room = stageEl ? vh - stageEl.getBoundingClientRect().top - BOTTOM_ROOM : 0;
    const h = Math.max(420, vh * 0.6, room);
    return { cam: fitBox(content.w, content.h, w, h, fo), stageH: h };
  }, [stageEl, expanded, content.w, content.h, fitMinK, maxK, height, bandTop]);

  // Fits at once when the content changes (a new layout), when the stage first mounts, and when it expands or collapses. A tween
  // still running is stopped first, so its remaining frames cannot overwrite the fit.
  useLayoutEffect(() => {
    if (!autoFit) return;
    cancelTween();
    const t = fitTarget();
    setStageH(t.stageH);
    setCamera(t.cam);
  }, [fitTarget, autoFit, setCamera, cancelTween]);

  // The Fit button refits with the tween.
  const fit = useCallback(() => {
    const t = fitTarget();
    setStageH(t.stageH);
    animateTo(t.cam);
  }, [fitTarget, animateTo]);

  // Esc leaves the expanded view.
  useLayoutEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExpanded(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded]);

  // A tween left running when the stage unmounts is cancelled.
  useEffect(() => cancelTween, [cancelTween]);

  // The wheel zooms around the pointer. React's onWheel is passive, so the listener is added by hand.
  useLayoutEffect(() => {
    const el = stageEl;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      // The side panel scrolls itself.
      if ((e.target as Element).closest("aside")) return;
      e.preventDefault();
      cancelTween();
      const r = el.getBoundingClientRect();
      const px = e.clientX - r.left;
      const py = e.clientY - r.top;
      const c = camRef.current;
      const k = clamp(c.k * Math.exp(-e.deltaY * 0.0015), MIN_K, MAX_K);
      const s = k / c.k;
      setCamera({ k, x: px - (px - c.x) * s, y: py - (py - c.y) * s });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [stageEl, cancelTween, setCamera]);

  /** Zooms by `f` around the centre of the stage, with the tween, from the tween's target when one is running. */
  const zoomBy = (f: number) => {
    const c = targetRef.current ?? camRef.current;
    const px = (stageEl?.clientWidth ?? 800) / 2;
    const py = (stageEl?.clientHeight ?? 500) / 2;
    const k = clamp(c.k * f, MIN_K, MAX_K);
    const s = k / c.k;
    animateTo({ k, x: px - (px - c.x) * s, y: py - (py - c.y) * s });
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    movedRef.current = false;
    if (e.button !== 0 || (e.target as Element).closest("button,a,input,label,aside")) return;
    cancelTween();
    drag.current = { x: e.clientX, y: e.clientY, cx: camRef.current.x, cy: camRef.current.y, moved: false };
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
    if (d.moved) setCamera({ ...camRef.current, x: d.cx + dx, y: d.cy + dy });
  };
  // The click that a drag ends with reads the flag, then clears it: a window listener runs after the element's own handlers. A press
  // clears the flag too, so a drag that ends off the stage leaves nothing behind for the next click.
  const clearMoved = () => {
    movedRef.current = false;
  };
  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    if (d?.moved) {
      movedRef.current = true;
      window.addEventListener("click", clearMoved, { once: true });
    }
  };

  /** Sets the camera's x at once (no tween). The caller keeps a box where it was when the layout to its left changes. */
  const moveX = useCallback(
    (x: number) => {
      cancelTween();
      setCamera({ ...camRef.current, x });
    },
    [cancelTween, setCamera],
  );

  /**
   * Tweens the camera so `box` (unscaled world coordinates) is visible, if it is not. `margin` is kept on every side, and the top
   * is kept at least `bandTop` clear. A stage with no size reveals nothing. A reveal is measured from the tween's target, if any.
   */
  const revealBox = useCallback(
    (box: Rect, margin?: number) => {
      const el = stageEl;
      if (!el || el.clientWidth === 0 || el.clientHeight === 0) return;
      const m = margin ?? REVEAL_MARGIN;
      const base = targetRef.current ?? camRef.current;
      const next = revealPan(base, box, { w: el.clientWidth, h: el.clientHeight }, m, Math.max(m, bandTop));
      if (next !== base) animateTo(next);
    },
    [stageEl, animateTo, bandTop],
  );

  const getCam = useCallback(() => camRef.current, []);
  /** True when the last press was a drag. The click that follows a drag is ignored by the caller. */
  const moved = useCallback(() => movedRef.current, []);

  return {
    cam: camRef.current,
    expanded,
    setExpanded,
    stageH,
    zoomBy,
    fit,
    moved,
    getCam,
    moveX,
    revealBox,
    animateTo,
    pointer: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp },
  };
}
