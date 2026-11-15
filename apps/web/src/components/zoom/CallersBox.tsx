// The callers box: a box to the right of a function (or of a chart's header, or of a call step) that lists who calls it.
// Its header is "Callers of <name>" with a close ×, and its body is one row per caller: the name, the file and line, the
// kinds of its edges, and a ▸ that opens the caller's chart to the right of the row (see ZoomMap.openCallerChart). A caller
// already open above it (a recursion) shows ↺ instead: its ▸ selects that chart rather than opening it again. The rows are
// fetched when the box opens; the box reports how many rows it shows, so the box grows to hold them. Every control is a
// keyboard control too (Tab, then Enter or Space).
import { useEffect, useState } from "react";
import { CHART_HEAD, CHART_PAD } from "@insight/flow";
import { CALLOUT_INSET, callerRowRect, callersLines, CALLERS_CAP, CALLER_ROW_H, CALLERS_W, type Expansion } from "../../zoom/expand";
import { mergeCallers, type CallerRow } from "../../zoom/callers";
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
  /** A box closing (its fade-out): it fetches nothing and shows no rows. */
  closing?: boolean;
  /** Whether a caller's function is open above this box in its own chain (a recursion): its row shows ↺ and selects. */
  inChain: (fnId: string) => boolean;
  onClose: () => void;
  /** Opens a caller's chart to the right of its row. */
  onOpen: (row: CallerRow, index: number) => void;
  /** Selects a caller: a click on its row. A function selects its function; a file row opens its file at the line. */
  onSelect: (row: CallerRow) => void;
  /** Reports how many rows the box lays out (see callersLines), so the map can grow the box. */
  onLines: (lines: number) => void;
}

type Loaded = { key: string; rows?: CallerRow[]; error?: string };

/** The ref of a callers box: its key without the "callers:" prefix. */
const refOf = (e: Expansion): string => e.fnId.slice("callers:".length);

export function CallersBox({ id, scope, expansion, k, closing = false, inChain, onClose, onOpen, onSelect, onLines }: Props) {
  const ref = refOf(expansion);
  const { x, y, w, h } = expansion;
  const key = `${id}\0${scope}\0${ref}`;
  const [loaded, setLoaded] = useState<Loaded>();
  useEffect(() => {
    if (closing) return;
    let cancelled = false;
    const lambdas = readLambdas();
    api.getRefs(id, scope, ref).then(
      (refs) => {
        if (!cancelled) setLoaded({ key, rows: mergeCallers(refs.calledBy, lambdas) });
      },
      (e: unknown) => {
        if (!cancelled) setLoaded({ key, error: e instanceof Error ? e.message : String(e) });
      },
    );
    // A box closed or moved to another project before its rows arrive takes them no more: the late result is dropped.
    return () => {
      cancelled = true;
    };
  }, [id, scope, ref, key, closing]);
  const shown = loaded?.key === key ? loaded : undefined;
  const rows = closing ? undefined : shown?.rows;
  const lines = callersLines(rows?.length);
  useEffect(() => {
    if (!closing) onLines(lines);
  }, [lines, closing]);

  const o = { x: x + CHART_PAD, y: y + CHART_HEAD + CHART_PAD };
  const rowW = CALLERS_W - 2 * CHART_PAD;
  const name = displayName(expansion.chart.name, ref);
  const label = fitLabel(`Callers of ${name}`, labelChars((w - 2 * 14) * k));
  const shownRows = rows === undefined ? [] : rows.slice(0, CALLERS_CAP);
  const hidden = rows === undefined ? 0 : rows.length - shownRows.length;
  return (
    <g className="zm-expansion zm-callers" role="group" aria-label={`Callers of ${name}`}>
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
        {!closing && rows === undefined && (
          <CallersNote y={0} rowW={rowW} k={k} text={shown?.error !== undefined ? `Callers are not available: ${shown.error}` : "Loading callers…"} />
        )}
        {!closing && rows !== undefined && rows.length === 0 && (
          <CallersNote y={0} rowW={rowW} k={k} text="No callers found" note="Entry point, or called from outside the index." />
        )}
        {shownRows.map((r, i) => (
          <CallerLine key={r.id} row={r} index={i} rowW={rowW} k={k} chained={inChain(r.id)} onOpen={onOpen} onSelect={onSelect} />
        ))}
        {hidden > 0 && <CallersNote y={shownRows.length * CALLER_ROW_H} rowW={rowW} k={k} text={`+${hidden} more`} />}
      </g>
    </g>
  );
}

/** A row that says something in place of callers (loading, none found, failed, or the "+N more" count). */
function CallersNote({ y, rowW, k, text, note }: { y: number; rowW: number; k: number; text: string; note?: string }) {
  const line = fitLabel(text, labelChars(rowW * k, 7, 14));
  const sub = note === undefined ? null : fitLabel(note, labelChars(rowW * k, 6, 14));
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

/** The width a "possible" tag takes, in world units, at the row's small type. */
const POSSIBLE_W = 8 * "possible".length + 10;

/**
 * One caller row: a hit area that selects it, its name and file, its edge kinds, a muted "possible" tag for a candidate
 * caller, and at the end a ▸ that opens its chart (or ↺ when it is already open above, which selects it).
 */
function CallerLine({ row, index, rowW, k, chained, onOpen, onSelect }: { row: CallerRow; index: number; rowW: number; k: number; chained: boolean; onOpen: (row: CallerRow, index: number) => void; onSelect: (row: CallerRow) => void }) {
  const r = callerRowRect(index);
  const badges = row.kinds.join(" · ");
  // A function row keeps room for its ▸ at the end; the tags sit left of that room.
  const edge = row.isFunction ? 30 : 8;
  const possibleW = row.candidate ? POSSIBLE_W : 0;
  const kindsW = badges === "" ? 0 : 8 * badges.length + 10;
  const name = fitLabel(row.name, labelChars((rowW - edge - possibleW - kindsW) * k, 7, 14));
  const where = row.line > 0 ? `${row.file}:${row.line}` : row.file;
  const file = fitLabel(where, labelChars(rowW * k, 6, 14));
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
        <text x={r.x + 10} y={top + 12} dominantBaseline="central" className="zm-caller-name" onClick={() => onSelect(row)}>
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
        <text x={r.x + 10} y={top + 26} dominantBaseline="central" className="zm-caller-file">
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
          <rect x={r.x + rowW - 24} y={top + CALLER_ROW_H / 2 - 12} width={24} height={24} rx={6} className="zm-caller-chev-hit" />
          <text x={r.x + rowW - 12} y={top + CALLER_ROW_H / 2} dominantBaseline="central" textAnchor="middle">
            {chained ? "↺" : "▸"}
          </text>
        </g>
      )}
    </g>
  );
}
