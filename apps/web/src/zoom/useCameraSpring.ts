// The zoom map's camera motion. A move the map makes (`to`) is a 260 ms eased tween from where the camera is, on the map's
// one curve (see tween.ts), so it reads with the boxes and details that move with it. A fling keeps the critically damped
// spring on each camera axis (x, y and log scale): it carries its release velocity and settles on the projected distance.
// Either move is written through `apply` every frame. A move in flight can be retargeted or stopped without a jump, and
// reduced motion cuts instead. Nothing here reads a gesture: the map decides when to move, and calls `stop` when the user
// takes the camera back.
import { useEffect, useMemo, useRef } from "react";
import type { Camera } from "@insight/flow";
import { advance, atRest, momentumOffset, type Spring } from "./spring";
import { cameraBetween, progressAt } from "./tween";

/** Where a spring counts as settled: a camera translation under this many px, a scale under this in log terms. */
const REST_PX = 0.05;
const REST_LOG_K = 1e-4;
/** A frame's time is capped, so a tab that was in the background does not jump the camera far in one step. */
const MAX_FRAME_S = 0.1;

export interface CameraSpring {
  /** Moves the camera to `target` on the spring, from its current place. `instant` (or reduced motion) cuts there. */
  to(target: Camera, instant: boolean): void;
  /** Carries the camera on from a drag's release at `vx`, `vy` px/s: it settles at the projected distance (see momentumOffset). */
  fling(vx: number, vy: number): void;
  /** Stops a move in flight where the camera is. */
  stop(): void;
}

interface Axes {
  x: Spring;
  y: Spring;
  /** The scale, on a log axis, so a zoom feels even at every scale. */
  k: Spring;
}

interface State {
  axes?: Axes;
  target?: Camera;
  /** A tween in flight: it starts at `from` (where the camera was when it was asked for) and reaches `to` after TWEEN_MS. */
  tween?: { from: Camera; to: Camera; start?: number };
  frame?: number;
  last: number;
}

const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * The spring for the camera. `getCamera` reads the camera as it is now, and `apply` writes a camera to the map; the hook
 * calls `apply` once a frame while a move is in flight, and once more with the exact target when it settles.
 */
export function useCameraSpring(getCamera: () => Camera, apply: (c: Camera) => void): CameraSpring {
  const getRef = useRef(getCamera);
  const applyRef = useRef(apply);
  const st = useRef<State>({ last: 0 });

  useEffect(() => {
    getRef.current = getCamera;
    applyRef.current = apply;
  });

  return useMemo<CameraSpring>(() => {
    const cancel = () => {
      const s = st.current;
      if (s.frame !== undefined) cancelAnimationFrame(s.frame);
      s.frame = undefined;
      s.axes = undefined;
      s.target = undefined;
      s.tween = undefined;
      s.last = 0;
    };

    const frame = (now: number) => {
      const s = st.current;
      s.frame = undefined;
      if (s.tween !== undefined) {
        const tw = s.tween;
        if (tw.start === undefined) tw.start = now;
        const p = progressAt(tw.start, now);
        if (p >= 1) {
          s.tween = undefined;
          applyRef.current(tw.to);
          return;
        }
        applyRef.current(cameraBetween(tw.from, tw.to, p));
        s.frame = requestAnimationFrame(frame);
        return;
      }
      const { axes, target } = s;
      if (axes === undefined || target === undefined) return;
      const dt = s.last === 0 ? 1 / 60 : Math.min(MAX_FRAME_S, (now - s.last) / 1000);
      s.last = now;
      const logK = Math.log(target.k);
      const next: Axes = {
        x: advance(axes.x, target.x, dt),
        y: advance(axes.y, target.y, dt),
        k: advance(axes.k, logK, dt),
      };
      s.axes = next;
      if (atRest(next.x, target.x, REST_PX) && atRest(next.y, target.y, REST_PX) && atRest(next.k, logK, REST_LOG_K)) {
        cancel();
        applyRef.current(target);
        return;
      }
      applyRef.current({ x: next.x.value, y: next.y.value, k: Math.exp(next.k.value) });
      s.frame = requestAnimationFrame(frame);
    };

    const run = (target: Camera, velocity: { x: number; y: number }) => {
      const s = st.current;
      const cur = getRef.current();
      // A move in flight keeps its carry and its velocity on the axes it already has; a new one starts from rest.
      const prev = s.axes;
      s.axes = {
        x: { value: cur.x, velocity: velocity.x, carry: prev?.x.carry ?? 0 },
        y: { value: cur.y, velocity: velocity.y, carry: prev?.y.carry ?? 0 },
        k: { value: Math.log(cur.k), velocity: prev?.k.velocity ?? 0, carry: prev?.k.carry ?? 0 },
      };
      s.target = target;
      // A fling takes over from a tween in flight: the spring carries the camera from where it is now.
      s.tween = undefined;
      if (s.frame === undefined) {
        s.last = 0;
        s.frame = requestAnimationFrame(frame);
      }
    };

    return {
      to(target, instant) {
        if (instant || reduced()) {
          cancel();
          applyRef.current(target);
          return;
        }
        // A retarget starts from the camera as it is drawn now, so an interrupted move does not jump; the clock restarts.
        const s = st.current;
        s.axes = undefined;
        s.target = undefined;
        s.tween = { from: getRef.current(), to: target };
        if (s.frame !== undefined) cancelAnimationFrame(s.frame);
        s.frame = requestAnimationFrame(frame);
      },
      fling(vx, vy) {
        if (reduced() || (Math.abs(vx) < 1 && Math.abs(vy) < 1)) return;
        const cur = getRef.current();
        const target: Camera = { k: cur.k, x: cur.x + momentumOffset(vx), y: cur.y + momentumOffset(vy) };
        run(target, { x: vx, y: vy });
      },
      stop: cancel,
    };
    // The hook's state lives in refs, so the object is built once and stays stable for the life of the component.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
