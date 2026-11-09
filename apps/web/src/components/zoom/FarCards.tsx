// The far tier's card grid: one card per child of the scope, packed in rows in screen space over the free part of the
// stage. The cards are buttons (a click or Enter drills into the child). Links between cards are curves, and a card with
// findings has a revision cloud round it and a count pill.
import { useEffect, useMemo, useRef } from "react";
import type { Rect } from "@insight/flow";
import { badgeText, cloudPath } from "../../zoom/findingsLayer";
import { farEdgeWidth } from "../../zoom/cards";
import { linkPath, packCards } from "../../zoom/farGrid";

/** Links are drawn only while there are at most this many (more would be a tangle). */
export const FAR_LINK_LIMIT = 30;
/** The gap between a card and its findings cloud, in px. */
const CLOUD_OFFSET = 6;

export interface FarCard {
  id: string;
  label: string;
  count: number;
  /** The findings of the card's functions, summed. */
  findings: number;
  /** The scope a click drills into. Undefined for a card without a source file (it does not open). */
  path?: string;
}

export interface FarPair {
  a: string;
  b: string;
  count: number;
}

interface Props {
  cards: readonly FarCard[];
  pairs: readonly FarPair[];
  /** The free area of the stage, in px: left of the Layers panel and above the minimap. */
  area: Rect;
  /** Whether the layer shows (the far tier). Hidden, it takes no pointer events and is not focusable. */
  shown: boolean;
  /** Whether the findings layer is on: clouds and pills show only then. */
  findingsOn: boolean;
  onOpen: (path: string) => void;
  /** A wheel over the layer, where it cannot scroll, is passed to the map's camera. */
  onWheel: (ev: globalThis.WheelEvent) => void;
}

export function FarCards({ cards, pairs, area, shown, findingsOn, onOpen, onWheel }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // A native, non-passive listener, so the wheel can be stopped from scrolling the page. The grid scrolls itself when it is
  // taller than its area; otherwise the wheel goes to the map's camera.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onNative = (ev: globalThis.WheelEvent) => {
      if (el.scrollHeight > el.clientHeight + 1) return;
      ev.preventDefault();
      onWheel(ev);
    };
    el.addEventListener("wheel", onNative, { passive: false });
    return () => el.removeEventListener("wheel", onNative);
  }, [onWheel]);
  const { placed, height } = useMemo(
    () => packCards(cards.map((c) => ({ id: c.id, count: c.count })), area.w),
    [cards, area.w],
  );
  const byId = useMemo(() => new Map(cards.map((c) => [c.id, c])), [cards]);
  const at = useMemo(() => new Map(placed.map((p) => [p.id, p])), [placed]);
  const links = pairs.length <= FAR_LINK_LIMIT ? pairs.flatMap((e) => {
    const a = at.get(e.a);
    const b = at.get(e.b);
    return a && b ? [{ key: `${e.a}\u0000${e.b}`, d: linkPath(a, b), count: e.count }] : [];
  }) : [];

  return (
    <div
      className={`zm-far-layer${shown ? " on" : ""}`}
      style={{ left: area.x, top: area.y, width: area.w, height: area.h }}
      aria-hidden={!shown}
    >
      <div className="zm-far-scroll" ref={scrollRef}>
        <div className="zm-far-content" style={{ width: area.w, height }}>
          <svg className="zm-far-links" width={area.w} height={height} aria-hidden="true">
            {links.map((l) => (
              <path key={l.key} d={l.d} className="zm-far-link" style={{ strokeWidth: farEdgeWidth(l.count) }}>
                <title>{`${l.count} call${l.count === 1 ? "" : "s"} between two groups`}</title>
              </path>
            ))}
            {findingsOn &&
              placed.map((p) => {
                const c = byId.get(p.id);
                if (!c || c.findings <= 0) return null;
                return <path key={`cloud-${p.id}`} d={cloudPath(p, CLOUD_OFFSET)} className="zm-cloud" />;
              })}
          </svg>
          {placed.map((p) => {
            const c = byId.get(p.id);
            if (!c) return null;
            const fns = `${c.count} function${c.count === 1 ? "" : "s"}`;
            return (
              <button
                key={p.id}
                type="button"
                className="zm-far-card"
                style={{ left: p.x, top: p.y, width: p.w, height: p.h }}
                disabled={!shown || c.path === undefined}
                title={c.path === undefined ? c.label : `${c.path} (${fns})`}
                onClick={() => {
                  if (c.path !== undefined) onOpen(c.path);
                }}
              >
                <span className="zm-far-name">{c.label}</span>
                <span className="zm-far-count">{fns}</span>
                {findingsOn && c.findings > 0 && (
                  <span className="zm-far-pill" aria-label={`${c.findings} finding${c.findings === 1 ? "" : "s"}`}>
                    {badgeText(c.findings)}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
