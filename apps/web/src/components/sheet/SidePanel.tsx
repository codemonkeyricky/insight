import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { advance, atRest, releaseVelocity, restingAt, type DragSample, type Spring } from "../../zoom/spring";
import { landingFor, restHeights, resolveHeight, SHEET_MAX_WIDTH, SHEET_TOP, type Rest } from "./bottomSheet";

interface Props {
  open: boolean;
  /** The panel's name for screen readers. */
  label: string;
  onClose: () => void;
  /** Content pinned above the scrolling body: it stays in view while the body scrolls. Capped at a share of the panel. */
  pinned?: ReactNode;
  children: ReactNode;
}

/** The sheet's spring response in seconds: critically damped, a little quicker than the camera. */
const SHEET_RESPONSE_S = 0.32;
/** Movement before a press counts as a drag, so a tap on a link in the sheet still clicks. */
const DRAG_SLOP_PX = 8;
/** Where a glide counts as settled: px, and px/s for the velocity. */
const REST_PX = 0.5;
/** The longest a drag keeps its samples. Only the last 100 ms decide the release speed. */
const MAX_SAMPLES = 32;

/** On a phone the panel is a bottom sheet. The check reads the same width as the CSS breakpoint. */
const phone = () => typeof matchMedia === "function" && matchMedia(`(max-width: ${SHEET_MAX_WIDTH}px)`).matches;
const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
const viewportH = () => window.innerHeight;

/** A press that may become a drag: where it started, and the grab offset from the sheet's top edge. */
interface Press {
  id: number;
  y0: number;
  offset: number;
  active: boolean;
  detach: () => void;
}

/** The pointer fields a drag reads: the window's events carry them, as do React's. */
interface PointerLike {
  pointerId: number;
  clientY: number;
}

const swallowClick = (e: Event) => {
  e.preventDefault();
  e.stopPropagation();
};

/** The sheet's motion state. It lives in a ref: the frame loop writes the transform, not React. */
interface Motion {
  /** The visible height in px: the sheet's top edge is `viewport - height`. */
  pos: number;
  rest: Rest | "drag";
  spring: Spring;
  frame?: number;
  last: number;
  onDone?: () => void;
  press?: Press;
  samples: DragSample[];
}

/**
 * The panel on the right of the sheet (a bottom sheet on a phone). It holds the source viewer and the exec panels. It stays
 * mounted when closed, so the map can hand it its panel; a closed panel is hidden and inert. Escape closes it unless an
 * earlier handler (the map, or the Find palette) already used the key.
 *
 * On a phone, the sheet rests at 40% or 90% of the viewport. A drag from its handle or header (or from the body, when the
 * sheet is not at its top) tracks the finger from where it was grabbed. A release projects its momentum and glides to the
 * rest nearest that point, with the release speed as the glide's start speed, so the motion has no seam. A drag past the
 * closed rest closes it. A glide can be caught mid-flight by a new press.
 */
export function SidePanel({ open, label, onClose, pinned, children }: Props) {
  const asideRef = useRef<HTMLElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [rest, setRestState] = useState<Motion["rest"]>("mid");
  const motion = useRef<Motion>({ pos: 0, rest: "closed", spring: restingAt(0), last: 0, samples: [] });
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  const setRest = (next: Motion["rest"]) => {
    motion.current.rest = next;
    setRestState(next);
  };

  // The sheet's transform: the top edge sits `pos` px above the bottom of the viewport. The height is 90% of the viewport, so
  // a rest at the top has no transform, and a height above it (the rubber band) moves the top edge up past that rest.
  const write = (pos: number) => {
    const s = motion.current;
    s.pos = pos;
    const el = asideRef.current;
    if (el) el.style.transform = `translate3d(0, ${viewportH() * SHEET_TOP - pos}px, 0)`;
  };

  const stop = () => {
    const s = motion.current;
    if (s.frame !== undefined) cancelAnimationFrame(s.frame);
    s.frame = undefined;
    s.onDone = undefined;
  };

  /** Glides the sheet to `target` from where it is, starting at `velocity` (px/s, up positive). Reduced motion cuts there. */
  const glide = (target: number, velocity: number, onDone?: () => void) => {
    const s = motion.current;
    stop();
    if (reduced()) {
      write(target);
      onDone?.();
      return;
    }
    s.spring = { value: s.pos, velocity, carry: 0 };
    s.last = 0;
    s.onDone = onDone;
    const frame = (now: number) => {
      s.frame = undefined;
      const dt = s.last === 0 ? 1 / 60 : Math.min(0.1, (now - s.last) / 1000);
      s.last = now;
      s.spring = advance(s.spring, target, dt, SHEET_RESPONSE_S);
      if (atRest(s.spring, target, REST_PX)) {
        write(target);
        const done = s.onDone;
        s.onDone = undefined;
        done?.();
        return;
      }
      write(s.spring.value);
      s.frame = requestAnimationFrame(frame);
    };
    s.frame = requestAnimationFrame(frame);
  };

  /** Glides to a rest, then records it (and closes, for the closed rest). */
  const settle = (next: Rest, velocity: number) => {
    glide(restHeights(viewportH())[next], velocity, () => {
      setRest(next);
      if (next === "closed") onCloseRef.current();
    });
  };

  // Opening on a phone rises from the bottom to the middle rest. Closing resets the sheet, so the next opening starts again.
  useLayoutEffect(() => {
    const el = asideRef.current;
    const s = motion.current;
    if (!open || !phone() || !el) {
      stop();
      s.pos = 0;
      if (el) {
        el.style.transform = "";
        el.style.height = "";
      }
      setRest(open ? "mid" : "closed");
      return;
    }
    el.style.height = `${viewportH() * SHEET_TOP}px`;
    write(0);
    setRest("drag");
    glide(restHeights(viewportH()).mid, 0, () => setRest("mid"));
    // The effect runs when the panel opens or closes; the sheet's own motion is kept in the ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  /** A press listens on the window: a drag keeps tracking the finger when it leaves the sheet, as a native sheet does. */
  const onPointerDown = (e: PointerEvent<HTMLElement>) => {
    if (!open || !phone() || e.button !== 0) return;
    const s = motion.current;
    const target = e.target as Element;
    const onGrab = target.closest(".sh-grab") !== null;
    // The body drags only when it cannot scroll: away from the top rest, where it takes the finger as the sheet does.
    const onBody = bodyRef.current?.contains(target) === true && s.rest !== "top";
    if (!onGrab && !onBody) return;
    // A press during a glide catches the sheet where it is: the frame loop has written that height already.
    stop();
    const id = e.pointerId;
    const move = (ev: PointerLike) => {
      if (ev.pointerId === id) moveDrag(ev);
    };
    const up = (ev: PointerLike) => {
      if (ev.pointerId === id) endDrag();
    };
    const detach = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    s.press = { id, y0: e.clientY, offset: e.clientY - (viewportH() - s.pos), active: false, detach };
    s.samples = [];
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  const moveDrag = (e: PointerLike) => {
    const s = motion.current;
    const press = s.press;
    if (press === undefined) return;
    if (!press.active) {
      if (Math.abs(e.clientY - press.y0) < DRAG_SLOP_PX) return;
      press.active = true;
      setRest("drag");
    }
    // 1:1: the sheet's top edge stays at the finger, offset by where the sheet was grabbed.
    const pos = resolveHeight(viewportH() - (e.clientY - press.offset), viewportH());
    write(pos);
    s.samples.push({ t: performance.now(), x: 0, y: pos });
    if (s.samples.length > MAX_SAMPLES) s.samples.splice(0, s.samples.length - MAX_SAMPLES);
  };

  const endDrag = () => {
    const s = motion.current;
    const press = s.press;
    if (press === undefined) return;
    press.detach();
    s.press = undefined;
    if (!press.active) return;
    // A drag that moved must not also click what it started on (a link in the sheet).
    window.addEventListener("click", swallowClick, true);
    window.setTimeout(() => window.removeEventListener("click", swallowClick, true), 350);
    // The release speed, then where the momentum carries the sheet: the rest nearest the projected end takes it.
    const { vy } = releaseVelocity(s.samples, performance.now());
    s.samples = [];
    settle(landingFor(s.pos, vy, viewportH()), vy);
  };

  const cls = ["sh-side", open ? "open" : "", `is-${rest}`].filter(Boolean).join(" ");
  return (
    <aside
      ref={asideRef}
      className={cls}
      aria-label={label}
      aria-hidden={!open}
      inert={!open}
      onPointerDown={onPointerDown}
    >
      <div className="sh-grab" aria-hidden="true">
        <span className="sh-handle" />
        <span className="sh-grab-label">{label}</span>
      </div>
      <button type="button" className="sh-close" aria-label="Close the side panel" onClick={onClose}>
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </button>
      {pinned && <div className="sh-pinned">{pinned}</div>}
      <div className="sh-side-body" ref={bodyRef}>
        {children}
      </div>
    </aside>
  );
}
