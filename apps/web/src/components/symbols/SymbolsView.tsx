// The Symbols tab: a call graph of the exported functions. A start list on the left names the exported functions of the
// scope; picking one opens its box as the head of a chain. A box lists the exported functions it calls (through internal
// helpers); picking one opens that callee's box to the right and drops whatever was right of the box. A "Callers" chip opens a
// box to the left that lists who calls the function, and picking a caller makes it the new head of the chain. The chain is
// kept in the URL (repeated `chain=` params), so a reload or a shared link opens the same boxes.
//
// The boxes sit on a pan and zoom stage (usePanZoom). The camera follows the openings: a box that opens off screen is revealed
// with a tween, and a box whose left neighbour changes (a caller prepended, a callers box opened or closed) keeps its place on
// screen, so nothing jumps under the reader. A box that leaves is kept for a moment in place, fading out. A camera change writes
// the world's transform directly, so a drag or a tween frame does not re-render the view.
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type Dispatch, type SetStateAction } from "react";
import type { ProjectModel } from "@insight/model";
import { api } from "../../api";
import { fileTarget, useCodeTarget } from "../../codeTarget";
import { hrefView } from "../../router";
import { displayName } from "../../zoom/names";
import { exportedCallees, exportedCallers, exportedFunctions, isExportedFunction, type ExportedSymbol, type SymbolLink } from "../../symbols/graph";
import { columnKeys, prefersReducedMotion, type Camera, type Rect } from "../../symbols/camera";
import { connectorPath, offsetWithin } from "../../symbols/connectors";
import { usePanZoom } from "../views/usePanZoom";

/** Separates the ids of a chain when it is kept as one string (a dependency key). No id holds a NUL. */
const KEY_SEP = "\u0000";

/** How long a box that left stays in place, fading out, before it is dropped. Matches the leave animation (160 ms) plus a margin. */
const GHOST_MS = 180;

/**
 * Px at the top of the stage kept clear for the zoom toolbar, which sits over the stage's top right corner (8 px from the top, about
 * 32 px tall). A fit, a reveal and the first camera all keep the boxes below it, with 8 px to spare.
 */
const TOOLBAR_BAND = 48;

interface Props {
  id: string;
  scope: string;
  /** The chain as the URL holds it: one `chain=` value per function id. */
  chain?: string[];
}

/**
 * The ids a chain names. The URL holds one `chain=` value per id; an older link holds them joined by commas in one value, and is
 * read as ids only when every part is a known exported function (checked by the caller, which has the model). Otherwise the value
 * is kept as it is, so validChain drops it.
 */
function legacyIds(model: ProjectModel, raw: string[]): string[] {
  if (raw.length !== 1 || isExportedFunction(model, raw[0] as string) || !(raw[0] as string).includes(",")) return raw;
  const parts = (raw[0] as string).split(",").filter((s) => s.length > 0);
  return parts.length > 0 && parts.every((p) => isExportedFunction(model, p)) ? parts : raw;
}

/** The chain up to its first id that is not an exported function of the project. A stale or edited link keeps what it can. */
export function validChain(model: ProjectModel, raw: string[]): string[] {
  const out: string[] = [];
  for (const id of legacyIds(model, raw)) {
    if (!isExportedFunction(model, id)) break;
    out.push(id);
  }
  return out;
}

/** The start list's rows that match a filter: its text is matched against the name and the file, ignoring case. */
export function filterSymbols(symbols: ExportedSymbol[], query: string): ExportedSymbol[] {
  const q = query.trim().toLowerCase();
  if (q === "") return symbols;
  return symbols.filter((s) => s.name.toLowerCase().includes(q) || s.file.toLowerCase().includes(q));
}

/** Calls `f` once per id: the first answer for an id is kept for the model's life. */
function memoBy(f: (id: string) => SymbolLink[]): (id: string) => SymbolLink[] {
  const seen = new Map<string, SymbolLink[]>();
  return (id) => {
    let hit = seen.get(id);
    if (hit === undefined) {
      hit = f(id);
      seen.set(id, hit);
    }
    return hit;
  };
}

/** One column as it was rendered: plain data, so a column that leaves can be drawn again from it. */
interface ColView {
  key: string;
  i: number;
  fnId: string;
  name: string;
  file: string;
  callersOpen: boolean;
  callers: SymbolLink[];
  callees: SymbolLink[];
  /** The callee whose box is the next column, if any. */
  selected: string | undefined;
}

/**
 * A column (or a callers box) that left, kept for GHOST_MS at its last place. `token` is unique for the life of the view, so
 * two ghosts of the same column (it opened and closed twice) are two elements with two keys. `left` is the column's place in the track.
 */
interface Ghost {
  token: number;
  view: ColView;
  left: number;
}

interface Link {
  key: string;
  d: string;
  /** Whether the connector carries the ambient flow (a chain connector; a callers connector does not). */
  flow: boolean;
}

/**
 * The box that stays on screen across a layout change: its place in the chain after the change (`index`), and the screen x it had
 * before the change. A caller picked from the head moves the head to index 1 (the caller becomes index 0), so the anchor is 1.
 */
interface Anchor {
  index: number;
  screenX: number;
}

interface StartGroup {
  file: string;
  items: ExportedSymbol[];
}

interface StartListProps {
  /** The exported functions of the scope, before the filter. */
  total: number;
  /** The exported functions the filter keeps. */
  matches: number;
  groups: StartGroup[];
  filter: string;
  /** The id at the head of the chain, which the list marks. */
  headId: string | undefined;
  onFilter: (query: string) => void;
  onPick: (id: string) => void;
  /** True when the last press was a drag, so the click that ends it picks nothing. */
  moved: () => boolean;
}

/**
 * The start list. Memoized: a camera change never re-renders it, and its props are stable (a filter keystroke or a new head is the
 * only change that reaches it).
 */
const StartList = memo(function StartList({ total, matches, groups, filter, headId, onFilter, onPick, moved }: StartListProps) {
  return (
    <aside className="sym-list" aria-label="Exported functions">
      <div className="sym-filter">
        <input
          type="search"
          className="sym-filter-input"
          placeholder="Filter functions"
          aria-label="Filter exported functions"
          value={filter}
          onChange={(e) => onFilter(e.target.value)}
        />
      </div>
      {total === 0 && <p className="muted small sym-none">No exported functions in this scope</p>}
      {total > 0 && matches === 0 && <p className="muted small sym-none">No function matches “{filter}”</p>}
      {groups.map((g) => (
        <section key={g.file} className="sym-group">
          <h3 className="sym-file">{g.file}</h3>
          <ul className="sym-starts">
            {g.items.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  className="sym-start"
                  aria-current={headId === s.id ? "true" : undefined}
                  onClick={() => {
                    if (!moved()) onPick(s.id);
                  }}
                >
                  {displayName(s.name, s.id)}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </aside>
  );
});

/** A connector: a stroke that draws on when it first mounts, and carries an ambient flow when it is a chain connector. */
function Connector({ d, flow }: { d: string; flow: boolean }) {
  const ref = useRef<SVGPathElement>(null);
  // Set on mount to the path's length, so the stroke draws from its start; cleared when the draw ends.
  const [len, setLen] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null || prefersReducedMotion() || typeof el.getTotalLength !== "function") return;
    setLen(el.getTotalLength());
  }, []);
  const drawing = len !== null;
  return (
    <>
      <path
        ref={ref}
        d={d}
        className={drawing ? "sym-link sym-link-draw" : "sym-link"}
        style={drawing ? ({ strokeDasharray: `${len} ${len}`, "--len": len } as CSSProperties) : undefined}
        onAnimationEnd={() => setLen(null)}
      />
      {flow && <path className="sym-link-flow" d={d} />}
    </>
  );
}

/** The rectangle of `el` in the track's unscaled coordinates. */
function boxIn(el: HTMLElement, track: HTMLElement): Rect {
  const o = offsetWithin(el, track);
  return { x: o.x, y: o.y, w: el.offsetWidth, h: el.offsetHeight };
}

/** Writes the camera to the world layer. The world's transform is the only thing a camera change touches. */
function writeCam(el: HTMLElement, c: Camera) {
  el.style.transform = `translate(${c.x}px, ${c.y}px) scale(${c.k})`;
}

export function SymbolsView({ id, scope, chain: chainParam }: Props) {
  const { showCode } = useCodeTarget();
  const [loaded, setLoaded] = useState<{ key: string; model?: ProjectModel; error?: string }>();
  const [raw, setRaw] = useState<string[]>(() => chainParam ?? []);
  // The function whose callers box is open, by id, so the box stays on that function whatever the chain becomes.
  const [callersOf, setCallersOf] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [canvasEl, setCanvasEl] = useState<HTMLDivElement | null>(null);
  const [canvasH, setCanvasH] = useState(0);
  const [content, setContent] = useState({ w: 0, h: 0 });
  const [links, setLinks] = useState<Link[]>([]);
  const [ghosts, setGhosts] = useState<Ghost[]>([]);
  const [ghostCallers, setGhostCallers] = useState<Ghost[]>([]);
  // The elements the connectors and the camera read, by their place in the chain.
  const els = useRef(new Map<string, HTMLElement>());
  const colEls = useRef(new Map<string, HTMLElement>());
  const trackRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<HTMLDivElement>(null);
  const prevViews = useRef(new Map<string, ColView>());
  const prevLeft = useRef(new Map<string, number>());
  const anchor = useRef<Anchor | null>(null);
  // Set when a caller is picked: the new head box is revealed once the chain has moved.
  const headPending = useRef(false);
  const prevLast = useRef("");
  const prevCallersAt = useRef<number | null>(null);
  const timers = useRef(new Set<number>());
  const ghostSeq = useRef(0);

  const writeWorld = useCallback((c: Camera) => {
    if (worldRef.current !== null) writeCam(worldRef.current, c);
  }, []);
  const pz = usePanZoom(canvasEl, content, {
    autoFit: false,
    fitMinK: 0.4,
    maxK: 1,
    bandTop: TOOLBAR_BAND,
    height: canvasH > 0 ? canvasH : undefined,
    applyTo: writeWorld,
  });
  // The latest reveal, for the focus handler, which is bound once per stage.
  const revealRef = useRef(pz.revealBox);
  revealRef.current = pz.revealBox;

  useEffect(() => {
    let cancelled = false;
    api.getSymbolModel(id).then(
      (model) => {
        if (!cancelled) setLoaded({ key: id, model });
      },
      (e: unknown) => {
        if (!cancelled) setLoaded({ key: id, error: e instanceof Error ? e.message : String(e) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [id]);

  // The URL is the source of the chain: a change of `chain=` (a link, Back, or the write in go) replaces what the view holds,
  // and closes an open callers box, since the chain it was open on has moved.
  const chainUrl = (chainParam ?? []).join(KEY_SEP);
  useEffect(() => {
    setRaw(chainUrl === "" ? [] : chainUrl.split(KEY_SEP));
    setCallersOf(null);
  }, [chainUrl]);

  // Drops the timers of boxes that left, when the view goes.
  useEffect(
    () => () => {
      timers.current.forEach((t) => window.clearTimeout(t));
      timers.current.clear();
    },
    [],
  );

  const model = loaded?.key === id ? loaded.model : undefined;
  const error = loaded?.key === id ? loaded.error : undefined;
  const graph = useMemo(
    () =>
      model === undefined
        ? undefined
        : { callees: memoBy((fn) => exportedCallees(model, fn)), callers: memoBy((fn) => exportedCallers(model, fn)) },
    [model],
  );
  const chain = useMemo(() => (model === undefined ? [] : validChain(model, raw)), [model, raw]);
  const symbols = useMemo(() => (model === undefined ? [] : exportedFunctions(model, scope)), [model, scope]);
  const shown = useMemo(() => filterSymbols(symbols, filter), [symbols, filter]);
  const groups = useMemo(() => {
    const out: StartGroup[] = [];
    for (const s of shown) {
      const last = out[out.length - 1];
      if (last !== undefined && last.file === s.file) last.items.push(s);
      else out.push({ file: s.file, items: [s] });
    }
    return out;
  }, [shown]);
  const callersAt = useMemo(() => {
    if (callersOf === null) return null;
    const at = chain.indexOf(callersOf);
    return at >= 0 ? at : null;
  }, [callersOf, chain]);
  const keys = useMemo(() => columnKeys(chain), [chain]);
  const views = useMemo<ColView[]>(() => {
    if (model === undefined || graph === undefined) return [];
    return chain.map((fnId, i) => {
      const fn = model.functionById.get(fnId);
      return {
        key: keys[i] ?? fnId,
        i,
        fnId,
        name: displayName(fn?.name ?? fnId, fnId),
        file: fn?.file ?? "",
        callersOpen: callersAt === i,
        callers: graph.callers(fnId),
        callees: graph.callees(fnId),
        selected: chain[i + 1],
      };
    });
  }, [model, graph, chain, keys, callersAt]);

  // Moves the chain: the state, and the URL that names it (so the chain survives a reload).
  const go = useCallback(
    (next: string[]) => {
      setRaw(next);
      setCallersOf(null);
      const href = hrefView(id, "symbols", { scope, ...(next.length > 0 ? { chain: next } : {}) });
      if (window.location.hash !== href) window.location.hash = href;
    },
    [id, scope],
  );
  const pickStart = useCallback((sid: string) => go([sid]), [go]);

  const chainKey = chain.join(KEY_SEP);

  // A new project or model: nothing from the old one is kept (no ghost, no remembered place of a column).
  useLayoutEffect(() => {
    prevViews.current = new Map();
    prevLeft.current.clear();
    anchor.current = null;
    timers.current.forEach((t) => window.clearTimeout(t));
    timers.current.clear();
    setGhosts([]);
    setGhostCallers([]);
    prevLast.current = "";
    prevCallersAt.current = null;
  }, [model]);

  // Connectors: from the row that opened the next box to that box, and from the open callers box to the box it leads to. They
  // are computed in the track's unscaled coordinates, so they do not depend on the camera. Runs on a layout change only.
  useLayoutEffect(() => {
    const draw = () => {
      const track = trackRef.current;
      if (track === null) return setLinks([]);
      const out: Link[] = [];
      for (let i = 0; i + 1 < chain.length; i++) {
        const row = els.current.get(`row:${i}:${chain[i + 1] ?? ""}`);
        // An open callers box sits between the row and the box it leads to, so the row's connector ends at that box instead.
        const cb = callersAt === i + 1 ? els.current.get(`callers:${i + 1}`) : undefined;
        const to = cb ?? els.current.get(`box:${i + 1}`);
        if (row && to) {
          const a = offsetWithin(row, track);
          const b = offsetWithin(to, track);
          out.push({
            key: `row:${keys[i] ?? ""}:${chain[i + 1] ?? ""}->box:${keys[i + 1] ?? ""}`,
            d: connectorPath({ right: a.x + row.offsetWidth, y: a.y + row.offsetHeight / 2 }, { left: b.x, y: b.y + 20 }),
            flow: true,
          });
        }
      }
      if (callersAt !== null) {
        const cb = els.current.get(`callers:${callersAt}`);
        const box = els.current.get(`box:${callersAt}`);
        if (cb && box) {
          const a = offsetWithin(cb, track);
          const b = offsetWithin(box, track);
          out.push({
            key: `callers:${keys[callersAt] ?? ""}->box:${keys[callersAt] ?? ""}`,
            d: connectorPath({ right: a.x + cb.offsetWidth, y: a.y + 20 }, { left: b.x, y: b.y + 20 }, 72),
            flow: false,
          });
        }
      }
      setLinks(out);
      // The track's own size is the world's content size, for the Fit button.
      setContent((prev) => (prev.w === track.offsetWidth && prev.h === track.offsetHeight ? prev : { w: track.offsetWidth, h: track.offsetHeight }));
    };
    draw();
    window.addEventListener("resize", draw);
    // The track resizes with its content and the viewport, not only with the window; a resize observer follows both.
    const track = trackRef.current;
    const observer = track !== null && typeof ResizeObserver !== "undefined" ? new ResizeObserver(draw) : null;
    if (track !== null) observer?.observe(track);
    return () => {
      window.removeEventListener("resize", draw);
      observer?.disconnect();
    };
  }, [chain, keys, callersAt, model]);

  // The stage's height, for Fit.
  useLayoutEffect(() => {
    if (canvasEl === null) return;
    const measure = () => setCanvasH(canvasEl.clientHeight);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(canvasEl);
    return () => observer.disconnect();
  }, [canvasEl]);

  // Keyboard focus into the stage: the stage is overflow hidden, so the browser would scroll it. Its scroll is held at 0, and the
  // box that took the focus is revealed with the camera instead.
  useLayoutEffect(() => {
    const canvas = canvasEl;
    if (canvas === null) return;
    const pin = () => {
      if (canvas.scrollLeft !== 0) canvas.scrollLeft = 0;
      if (canvas.scrollTop !== 0) canvas.scrollTop = 0;
    };
    const onFocus = (e: FocusEvent) => {
      pin();
      const track = trackRef.current;
      const target = e.target;
      if (track === null || !(target instanceof Element)) return;
      const box = target.closest<HTMLElement>(".sym-box");
      if (box !== null && track.contains(box)) revealRef.current(boxIn(box, track));
    };
    canvas.addEventListener("focusin", onFocus);
    canvas.addEventListener("scroll", pin);
    return () => {
      canvas.removeEventListener("focusin", onFocus);
      canvas.removeEventListener("scroll", pin);
    };
  }, [canvasEl]);

  // The camera's first write, once the world exists (the world is drawn when the model has loaded).
  const ready = model !== undefined;
  const getCam = pz.getCam;
  useLayoutEffect(() => {
    if (ready) writeWorld(getCam());
  }, [ready, writeWorld, getCam]);

  // Runs after every layout change, before paint: the boxes that left are kept in place, the anchored box keeps its screen place,
  // and the camera follows what opened. A camera change does not come here, so a drag or a tween frame reads no layout.
  useLayoutEffect(() => {
    const cur = new Map(views.map((v) => [v.key, v] as const));
    const dropLater = (set: Dispatch<SetStateAction<Ghost[]>>, token: number) => {
      const t = window.setTimeout(() => {
        timers.current.delete(t);
        set((list) => list.filter((x) => x.token !== token));
      }, GHOST_MS);
      timers.current.add(t);
    };
    if (!prefersReducedMotion()) {
      const cols: Ghost[] = [];
      const cals: Ghost[] = [];
      for (const [key, prev] of prevViews.current) {
        const now = cur.get(key);
        if (now === undefined) cols.push({ token: ++ghostSeq.current, view: prev, left: prevLeft.current.get(key) ?? 0 });
        else if (prev.callersOpen && !now.callersOpen) cals.push({ token: ++ghostSeq.current, view: prev, left: 0 });
      }
      if (cols.length > 0) setGhosts((g) => [...g, ...cols]);
      if (cals.length > 0) setGhostCallers((g) => [...g, ...cals]);
      for (const g of cols) dropLater(setGhosts, g.token);
      for (const g of cals) dropLater(setGhostCallers, g.token);
    }
    for (const [key, el] of colEls.current) prevLeft.current.set(key, el.offsetLeft);
    // A column that is gone keeps no place: its ghost, if any, has its left already.
    for (const key of [...prevLeft.current.keys()]) if (!cur.has(key)) prevLeft.current.delete(key);
    prevViews.current = cur;

    const track = trackRef.current;
    const a = anchor.current;
    anchor.current = null;
    if (a !== null && track !== null) {
      const el = els.current.get(`box:${a.index}`);
      if (el !== undefined) pz.moveX(a.screenX - offsetWithin(el, track).x * pz.getCam().k);
    }

    const lastKey = keys[chain.length - 1] ?? "";
    let target: string | undefined;
    if (headPending.current) target = "box:0";
    else if (callersAt !== null && callersAt !== prevCallersAt.current) target = `callers:${callersAt}`;
    else if (lastKey !== prevLast.current && lastKey !== "") target = `box:${chain.length - 1}`;
    headPending.current = false;
    prevLast.current = lastKey;
    prevCallersAt.current = callersAt;
    const reveal = target !== undefined ? els.current.get(target) : undefined;
    if (reveal !== undefined && track !== null) pz.revealBox(boxIn(reveal, track));
  }, [views, callersAt, chain, keys]);

  if (error !== undefined) return <p className="error" role="alert">{error}</p>;
  if (model === undefined || graph === undefined) return <p className="muted small">Loading symbols</p>;

  /**
   * Records where the box at chain position `i` is on screen, and the index it will have after the change that follows (the
   * layout change keeps that box where it was on screen).
   */
  const anchorAt = (i: number, index: number) => {
    const track = trackRef.current;
    const el = els.current.get(`box:${i}`);
    if (track === null || el === undefined) return;
    const c = pz.getCam();
    anchor.current = { index, screenX: offsetWithin(el, track).x * c.k + c.x };
  };
  const pickCallee = (i: number, calleeId: string) => {
    const kept = chain.slice(0, i + 1);
    // A row that is already the next box closes everything right of this one.
    go(chain[i + 1] === calleeId ? kept : [...kept, calleeId]);
  };
  const pickCaller = (i: number, callerId: string) => {
    // The caller becomes the new head; the boxes right of the box it calls stay as they were. The box it calls (chain[i]) is at
    // index 1 of the new chain, and keeps its place.
    anchorAt(i, 1);
    headPending.current = true;
    go([callerId, ...chain.slice(i)]);
  };
  const toggleCallers = (i: number, fnId: string) => {
    anchorAt(i, i);
    setCallersOf(callersAt === i ? null : fnId);
  };
  /** A click that ends a drag opens nothing. */
  const guard = (f: () => void) => () => {
    if (!pz.moved()) f();
  };
  const showSource = (v: ColView) => {
    const fn = model.functionById.get(v.fnId);
    const line = model.functionById.get(v.fnId)?.span?.start[0];
    if (fn !== undefined) showCode(fileTarget(fn.file, line !== undefined ? line + 1 : undefined));
  };

  const reg = (key: string) => (el: HTMLElement | null) => {
    if (el) els.current.set(key, el);
    else els.current.delete(key);
  };
  const colRef = (key: string) => (el: HTMLElement | null) => {
    if (el) colEls.current.set(key, el);
    else colEls.current.delete(key);
  };

  /** The callers box of a column. A ghost (`live` false) is the one that left: it is inert and hidden from assistive tech. */
  const callersBox = (v: ColView, live: boolean) => (
    <section
      className={live ? "sym-box sym-callers" : "sym-box sym-callers sym-leaving"}
      aria-label={`Callers of ${v.name}`}
      aria-hidden={live ? undefined : true}
      inert={live ? undefined : true}
      ref={live ? reg(`callers:${v.i}`) : undefined}
    >
      <header className="sym-head">
        <span className="sym-callers-title">Callers of {v.name}</span>
        {live && (
          <button type="button" className="sym-close" aria-label={`Close the callers of ${v.name}`} onClick={guard(() => toggleCallers(v.i, v.fnId))}>
            ×
          </button>
        )}
      </header>
      {v.callers.length === 0 ? (
        <p className="muted small sym-none">No exported callers</p>
      ) : (
        <ul className="sym-rows">
          {v.callers.map((c, n) => (
            <li key={c.id} style={{ "--i": n } as CSSProperties}>
              <button type="button" className="sym-row" onClick={guard(() => pickCaller(v.i, c.id))}>
                <span className="sym-row-name">{displayName(c.name, c.id)}</span>
                {c.via !== undefined && <span className="sym-via">via {displayName(c.via)}</span>}
                {c.candidate && <span className="sym-maybe">maybe</span>}
                <span className="sym-chev" aria-hidden="true">›</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );

  /**
   * One column: its callers box (when open, or leaving), and its function box. A ghost (`live` false) is drawn at `left` under
   * its unique `token`, and is inert.
   */
  const column = (v: ColView, live: boolean, token = 0, left = 0) => {
    const leavingCallers = live && !v.callersOpen ? ghostCallers.find((g) => g.view.key === v.key) : undefined;
    return (
      <div
        key={live ? v.key : `ghost:${token}`}
        className={live ? "sym-column" : "sym-column sym-leaving"}
        style={live ? undefined : { left }}
        aria-hidden={live ? undefined : true}
        inert={live ? undefined : true}
        ref={live ? colRef(v.key) : undefined}
      >
        {v.callersOpen && callersBox(v, live)}
        {leavingCallers !== undefined && callersBox(leavingCallers.view, false)}
        <section className={live ? "sym-box" : "sym-box sym-leaving"} data-box={v.fnId} aria-label={`Calls of ${v.name}`} ref={live ? reg(`box:${v.i}`) : undefined}>
          <header className="sym-head">
            <button type="button" className="sym-title" title="Show the source" onClick={guard(() => showSource(v))}>
              <span className="sym-name">{v.name}</span>
              <span className="sym-path">{v.file}</span>
            </button>
            <button type="button" className="sym-chip" aria-expanded={v.callersOpen} onClick={guard(() => toggleCallers(v.i, v.fnId))}>
              Callers {v.callers.length}
            </button>
          </header>
          {v.callees.length === 0 ? (
            <p className="muted small sym-none">Calls no exported functions</p>
          ) : (
            <ul className="sym-rows">
              {v.callees.map((c, n) => (
                <li key={c.id} style={{ "--i": n } as CSSProperties}>
                  <button
                    type="button"
                    className="sym-row"
                    aria-pressed={v.selected === c.id}
                    data-row={c.id}
                    ref={live ? reg(`row:${v.i}:${c.id}`) : undefined}
                    onClick={guard(() => pickCallee(v.i, c.id))}
                  >
                    <span className="sym-row-name">{displayName(c.name, c.id)}</span>
                    {c.via !== undefined && <span className="sym-via">via {displayName(c.via)}</span>}
                    {c.candidate && <span className="sym-maybe">maybe</span>}
                    <span className="sym-chev" aria-hidden="true">›</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    );
  };

  return (
    <div className="sym">
      <StartList
        total={symbols.length}
        matches={shown.length}
        groups={groups}
        filter={filter}
        headId={chain[0]}
        onFilter={setFilter}
        onPick={pickStart}
        moved={pz.moved}
      />
      <div
        className={`sym-canvas${pz.expanded ? " expanded" : ""}`}
        ref={setCanvasEl}
        onPointerDown={pz.pointer.onPointerDown}
        onPointerMove={pz.pointer.onPointerMove}
        onPointerUp={pz.pointer.onPointerUp}
        onPointerCancel={pz.pointer.onPointerCancel}
      >
        <div className="sym-bar">
          <span className="sysv-zoom" role="group" aria-label="Zoom">
            <button type="button" onClick={() => pz.zoomBy(1 / 1.25)} aria-label="Zoom out">
              −
            </button>
            <button type="button" onClick={() => pz.zoomBy(1.25)} aria-label="Zoom in">
              +
            </button>
            <button type="button" onClick={() => pz.fit()}>
              Fit
            </button>
            <button type="button" onClick={() => pz.setExpanded(!pz.expanded)} aria-pressed={pz.expanded} title="Fill the window (Esc leaves)">
              {pz.expanded ? "Close" : "Expand"}
            </button>
          </span>
        </div>
        {chain.length === 0 && <p className="muted small sym-empty">Pick an exported function on the left to open its calls.</p>}
        <div className="sym-world" ref={worldRef}>
          {chain.length > 0 && (
            <div className="sym-track" ref={trackRef}>
              {views.map((v) => column(v, true))}
              {ghosts.map((g) => column(g.view, false, g.token, g.left))}
              <svg className="sym-links" aria-hidden="true">
                {links.map((l) => (
                  <Connector key={l.key} d={l.d} flow={l.flow} />
                ))}
              </svg>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
