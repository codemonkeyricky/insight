// The callers box: a box that lists who calls a function. It opens left of a roots-only function card and left from the
// header of an in-place chart that replaced such a card; from any other chart's header (one opened from a call step) it
// opens right of the chart.
// Its header is "Callers of <name>" with a close ×, and its body is one row per caller: the name, the file and line, the
// kinds of its edges, and a ◂ at the row's left end that opens the caller's chart to the left of the row (see ZoomMap.openCallerChart). A caller
// already open above it (a recursion) shows ↺ instead: its ◂ selects that chart rather than opening it again. The rows are
// fetched when the box opens; the box reports how many rows it shows, so the box grows to hold them. Every control is a
// keyboard control too (Tab, then Enter or Space). A caller is a call, dispatch, spawn, or a reference that invokes the
// function (new, JSX, handler). When no caller is listed but the function is passed as a value somewhere, the box says
// it is called through, and how many places pass it (valueRefCount).
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { CHART_HEAD, CHART_PAD } from "@insight/flow";
import { CALLOUT_INSET, callerRowRect, callersLines, CALLERS_CAP, CALLER_ROW_H, CALLERS_W, type Expansion } from "../../zoom/expand";
import { mergeCallers, refOfCallersKey, valueRefCount, type CallerRow } from "../../zoom/callers";
import { readLambdas } from "../../zoom/lambdaPref";
import { displayName } from "../../zoom/names";
import { fitLabel, labelChars } from "../../zoom/lod";
import { api } from "../../api";
import { keyActivates } from "./keys";

interface Props {
  /** The project, for the callers query. */
  id: string;
  /** The scope the query runs in (the scope the map shows). */
  scope: string;
  expansion: Expansion;
  /** The label scale: the camera's scale in its quarter-octave bucket (lod.ts). */
  k: number;
  /** A box closing (its fade-out): it fetches nothing, and shows the rows it last showed. */
  closing?: boolean;
  /** Whether a caller's function is open above this box in its own chain (a recursion): its row shows ↺ and selects. */
  inChain: (fnId: string) => boolean;
  onClose: () => void;
  /** Opens a caller's chart to the left of its row. */
  onOpen: (row: CallerRow, index: number) => void;
  /** Selects a caller: a click on its row. A function selects its function; a file row opens its file at the line. */
  onSelect: (row: CallerRow) => void;
  /**
   * Reports how many rows the box lays out (see callersLines), so the map can grow the box, and the ids of the callers its
   * rows show, in order (undefined while they load or failed), so the charts opened from them follow their rows.
   */
  onLines: (lines: number, ids: readonly string[] | undefined) => void;
  /** The focus was on a row that the new rows no longer have, and fell to the page: the map gives it back to its stage. */
  onFocusLost?: () => void;
}

/** `valueRefs` is how many places pass the function as a value (not counted in `rows`), shown when no caller is listed. */
type Loaded = { key: string; rows?: CallerRow[]; valueRefs?: number; error?: string };

/**
 * What each box last showed, by project, scope, function and the Lambdas choice: its rows, its error, or that it was
 * loading. A box that opens again starts from its rows (and fetches afresh), and a closing box shows what the open box
 * last showed while it fades. Kept small: the least recently used entry goes first.
 */
const lastShown = new Map<string, Loaded>();
const LAST_SHOWN_MAX = 64;
/** Forgets what every box showed (for tests, which mount boxes of one function with different rows). */
export function forgetCallerRows(): void {
  lastShown.clear();
}
function remember(key: string, state: Loaded) {
  lastShown.delete(key);
  lastShown.set(key, state);
  if (lastShown.size > LAST_SHOWN_MAX) lastShown.delete(lastShown.keys().next().value as string);
}
/** The rows a box of `key` last showed, as a loaded state, when it showed rows. Reading it makes the entry recent. */
function recall(key: string): Loaded | undefined {
  const got = lastShown.get(key);
  if (got?.rows === undefined) return undefined;
  remember(key, got);
  return got;
}

export function CallersBox({ id, scope, expansion, k, closing = false, inChain, onClose, onOpen, onSelect, onLines, onFocusLost }: Props) {
  const ref = refOfCallersKey(expansion.fnId);
  const { x, y, w, h } = expansion;
  // The Lambdas choice is read once: the Flow view mounts the map afresh when it changes, so a box never outlives it.
  const lambdas = readLambdas();
  const key = `${id}\0${scope}\0${ref}\0${lambdas ? "1" : "0"}`;
  const [loaded, setLoaded] = useState<Loaded | undefined>(() => (closing ? undefined : recall(key)));
  useEffect(() => {
    if (closing) return;
    let cancelled = false;
    api.getRefs(id, scope, ref).then(
      (refs) => {
        if (!cancelled) setLoaded({ key, rows: mergeCallers(refs.calledBy, lambdas), valueRefs: valueRefCount(refs.calledBy, lambdas) });
      },
      (e: unknown) => {
        if (!cancelled) setLoaded({ key, error: e instanceof Error ? e.message : String(e) });
      },
    );
    // A box closed or moved to another project before its rows arrive takes them no more: the late result is dropped.
    return () => {
      cancelled = true;
    };
  }, [id, scope, ref, key, lambdas, closing]);
  // An open box shows what it loaded for its key, else the rows a box of the key last showed (a new scope, a reopen). A
  // closing box is a fresh copy drawn for the fade: it shows what the open box last showed.
  const shown: Loaded = closing ? (lastShown.get(key) ?? { key }) : loaded?.key === key ? loaded : (recall(key) ?? { key });
  useEffect(() => {
    if (!closing) remember(key, shown);
  }, [closing, key, shown.rows, shown.valueRefs, shown.error]);
  const rows = shown.rows;
  const valueRefs = shown.valueRefs ?? 0;
  const lines = callersLines(rows?.length);
  const ids = rows?.map((r) => r.id);
  const idsKey = ids?.join("\0");
  useEffect(() => {
    if (!closing) onLines(lines, ids);
    // `ids` is new on every render: its joined key stands for it.
  }, [lines, idsKey, closing]);
  // A row that had the focus and is gone after the rows changed (a refetch) drops the focus to the page: the map takes it
  // back. Whether the focus was in the box is read as the box renders, before the rows change.
  const rootRef = useRef<SVGGElement>(null);
  const hadFocus = useRef(false);
  const active = typeof document === "undefined" ? null : document.activeElement;
  hadFocus.current = rootRef.current !== null && active !== null && rootRef.current.contains(active);
  useLayoutEffect(() => {
    if (closing || !hadFocus.current) return;
    const now = document.activeElement;
    if (now === null || now === document.body || !now.isConnected) onFocusLost?.();
  }, [idsKey, closing]);

  const o = { x: x + CHART_PAD, y: y + CHART_HEAD + CHART_PAD };
  const rowW = CALLERS_W - 2 * CHART_PAD;
  const name = displayName(expansion.chart.name, ref);
  // The title starts 14 in and keeps clear of the close × at the right (CHART_HEAD square).
  const label = fitLabel(`Callers of ${name}`, labelChars((w - 14 - CHART_HEAD - 4) * k));
  const shownRows = rows === undefined ? [] : rows.slice(0, CALLERS_CAP);
  const hidden = rows === undefined ? 0 : rows.length - shownRows.length;
  return (
    <g ref={rootRef} className="zm-expansion zm-callers" role="group" aria-label={`Callers of ${name}`}>
      <title>{`Callers of ${ref}`}</title>
      <rect x={x} y={y} width={w} height={h} rx={14} className="zm-expansion-body" />
      <rect x={x} y={y + CALLOUT_INSET} width={3} height={Math.max(0, h - 2 * CALLOUT_INSET)} rx={1.5} className="zm-expansion-accent" />
      <g className="zm-expansion-title">
        <rect x={x} y={y} width={w} height={CHART_HEAD} rx={14} className="zm-expansion-head" />
        <line x1={x + 12} x2={x + w - 12} y1={y + CHART_HEAD} y2={y + CHART_HEAD} className="zm-expansion-rule" />
        {label !== null && (
          <text x={x + 14} y={y + CHART_HEAD / 2} dominantBaseline="central" className="zm-label">
            {label}
          </text>
        )}
      </g>
      <g
        className="zm-expansion-close"
        role="button"
        tabIndex={0}
        aria-label={`Close the callers of ${name}`}
        onClick={(ev) => {
          ev.stopPropagation();
          onClose();
        }}
        onKeyDown={(ev) => {
          if (!keyActivates(ev.key)) return;
          ev.stopPropagation();
          ev.preventDefault();
          onClose();
        }}
      >
        <rect x={x + w - CHART_HEAD} y={y} width={CHART_HEAD} height={CHART_HEAD} className="zm-expansion-close-hit" />
        <circle cx={x + w - CHART_HEAD / 2} cy={y + CHART_HEAD / 2} r={9} className="zm-expansion-close-bg" />
        <text x={x + w - CHART_HEAD / 2} y={y + CHART_HEAD / 2} dominantBaseline="central" textAnchor="middle">
          ×
        </text>
      </g>
      <g transform={`translate(${o.x} ${o.y})`}>
        {rows === undefined && (
          <CallersNote y={0} rowW={rowW} text={shown.error !== undefined ? `Callers are not available: ${shown.error}` : "Loading callers…"} />
        )}
        {rows !== undefined && rows.length === 0 && valueRefs > 0 && (
          <CallersNote y={0} rowW={rowW} text="No direct callers" note={`Passed as a value from ${valueRefs} place${valueRefs === 1 ? "" : "s"}; called through it.`} />
        )}
        {rows !== undefined && rows.length === 0 && valueRefs === 0 && (
          <CallersNote y={0} rowW={rowW} text="No callers found" note="Entry point, or called from outside the index." />
        )}
        {shownRows.map((r, i) => (
          <CallerLine key={r.id} row={r} index={i} rowW={rowW} chained={inChain(r.id)} onOpen={onOpen} onSelect={onSelect} />
        ))}
        {hidden > 0 && <CallersNote y={shownRows.length * CALLER_ROW_H} rowW={rowW} text={`+${hidden} more`} />}
      </g>
    </g>
  );
}

/** A row that says something in place of callers (loading, none found, failed, or the "+N more" count). */
function CallersNote({ y, rowW, text, note }: { y: number; rowW: number; text: string; note?: string }) {
  const line = fitLabel(text, labelChars(rowW, NAME_CHAR_W, 14));
  const sub = note === undefined ? null : fitLabel(note, labelChars(rowW, FILE_CHAR_W, 14));
  const ry = y + CALLER_ROW_H / 2;
  return (
    <g className="zm-callers-note">
      {line !== null && (
        <text x={10} y={sub === null ? ry : y + 12} dominantBaseline="central" className="zm-caller-name">
          {line}
        </text>
      )}
      {sub !== null && (
        <text x={10} y={y + 26} dominantBaseline="central" className="zm-caller-file">
          {sub}
        </text>
      )}
    </g>
  );
}

/**
 * The width of one character of a row's name (12 px code font) and of its file line (10.5 px), in world units. The rows'
 * type is sized in world units (it zooms with the map, see styles.css), so a row is fitted to its world width at any scale.
 */
const NAME_CHAR_W = 7.4;
const FILE_CHAR_W = 6.5;

/** The room a row's ◂ takes at its start: its hit area's width, in world units. */
const CHEV_W = 24;

/** The width a "possible" tag takes, in world units, at the row's small type. */
const POSSIBLE_W = 8 * "possible".length + 10;

/**
 * One caller row: a hit area that selects it, its name and file, its edge kinds, a muted "possible" tag for a candidate
 * caller, and at the start a ◂ that opens its chart to the left (or ↺ when it is already open above, which selects it).
 */
function CallerLine({ row, index, rowW, chained, onOpen, onSelect }: { row: CallerRow; index: number; rowW: number; chained: boolean; onOpen: (row: CallerRow, index: number) => void; onSelect: (row: CallerRow) => void }) {
  const r = callerRowRect(index);
  const badges = row.kinds.join(" · ");
  // A function row keeps room for its ◂ at the start: its name and file shift right by that room.
  const inset = row.isFunction ? 10 + CHEV_W : 10;
  const edge = 8;
  const possibleW = row.candidate ? POSSIBLE_W : 0;
  const kindsW = badges === "" ? 0 : 8 * badges.length + 10;
  const name = fitLabel(row.name, labelChars(rowW - inset - edge - possibleW - kindsW, NAME_CHAR_W, 14));
  const where = row.line > 0 ? `${row.file}:${row.line}` : row.file;
  const file = fitLabel(where, labelChars(rowW - inset, FILE_CHAR_W, 14));
  const top = r.y;
  const kindsEnd = r.x + rowW - edge - possibleW;
  return (
    <g className="zm-caller-row" data-caller={row.id}>
      <title>{row.name}</title>
      <rect
        x={r.x}
        y={top + 2}
        width={rowW}
        height={CALLER_ROW_H - 4}
        rx={7}
        className="zm-caller-hit"
        role="button"
        tabIndex={0}
        aria-label={`Select ${row.name}`}
        onClick={() => onSelect(row)}
        onKeyDown={(ev) => {
          if (!keyActivates(ev.key)) return;
          ev.stopPropagation();
          ev.preventDefault();
          onSelect(row);
        }}
      />
      {name !== null && (
        <text x={r.x + inset} y={top + 12} dominantBaseline="central" className="zm-caller-name">
          {name}
        </text>
      )}
      {badges !== "" && (
        <text x={kindsEnd} y={top + 12} dominantBaseline="central" textAnchor="end" className="zm-caller-kind">
          {badges}
        </text>
      )}
      {row.candidate && (
        <text x={r.x + rowW - edge} y={top + 12} dominantBaseline="central" textAnchor="end" className="zm-caller-possible">
          possible
        </text>
      )}
      {file !== null && (
        <text x={r.x + inset} y={top + 26} dominantBaseline="central" className="zm-caller-file">
          {file}
        </text>
      )}
      {row.isFunction && (
        <g
          className={`zm-caller-chev${chained ? " is-chained" : ""}`}
          role="button"
          tabIndex={0}
          aria-label={chained ? `Already open above: ${row.name}` : `Open the chart of ${row.name}`}
          onClick={(ev) => {
            ev.stopPropagation();
            onOpen(row, index);
          }}
          onKeyDown={(ev) => {
            if (!keyActivates(ev.key)) return;
            ev.stopPropagation();
            ev.preventDefault();
            onOpen(row, index);
          }}
          onDoubleClick={(ev) => ev.stopPropagation()}
        >
          <title>{chained ? `${row.name} is already open above` : `Open the chart of ${row.name}`}</title>
          <rect x={r.x + 6} y={top + CALLER_ROW_H / 2 - 12} width={CHEV_W} height={24} rx={6} className="zm-caller-chev-hit" />
          <text x={r.x + 6 + CHEV_W / 2} y={top + CALLER_ROW_H / 2} dominantBaseline="central" textAnchor="middle">
            {chained ? "↺" : "◂"}
          </text>
        </g>
      )}
    </g>
  );
}
