import { useEffect, useId, useLayoutEffect, useMemo, useState } from "react";
import type { StageGraph, StageDriver } from "@insight/model";
import { api } from "../../api";
import { basename } from "../../arch/pipeline-layout";
import { DATA_H, LABEL_H, planStages, type LayoutChip, type LayoutDataLink, type LayoutNode, type LayoutPath, type Point } from "../../arch/stages-layout";
import { fileTarget, useCodeTarget } from "../../codeTarget";
import { hrefView } from "../../router";
import type { StagesPayload } from "../../model/payloads";
import { usePanZoom } from "./usePanZoom";

type Site = { file: string; line: number };
/**
 * The smallest scale Fit may settle on. Fit never goes below it: when one frame cannot wrap, so the diagram is still wider than the
 * stage at this scale, it is left at this scale and panned, not shrunk further.
 */
const STAGE_MIN_K = 0.35;
/** The stage is as tall as its diagram at the fitted scale, plus this room; at least STAGE_MIN_H px, at most 75% of the window. */
const STAGE_PAD = 16;
const STAGE_MIN_H = 240;
const STAGE_MAX_VH = 0.75;
/** The width a stage is laid out for until it is measured. */
const FALLBACK_W = 1000;

/** The width of an element, kept current as it resizes. 0 until it is measured. */
function useElementWidth(el: HTMLElement | null): number {
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    if (!el) return;
    const measure = () => setW(el.clientWidth);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return w;
}
type FrameNode = Extract<LayoutNode, { kind: "frame" }>;

/**
 * The Stages section of the Pipeline view: the call order of one pipeline driver as a static-analysis diagram. Loops, branches,
 * try/catch and exits are drawn as the code has them; a fanout card lists the components its candidates live in. The
 * payload is computed in the page from the project model (api.getStages). A card or a frame opens the Code pane at its call
 * line; a component chip opens that component's System scope.
 */
export function StagesView({ id, scope, tests = false, onTests }: { id: string; scope: string; tests?: boolean; onTests?: (on: boolean) => void }) {
  const [showAll, setShowAll] = useState(false);
  const [pick, setPick] = useState<{ scope: string; driver: string } | null>(null);
  // The picked driver is kept for the scope it was picked in; a new scope starts with its first driver.
  const driver = pick !== null && pick.scope === scope ? pick.driver : undefined;
  const key = `${id}\0${scope}\0${driver ?? ""}\0${tests ? 1 : 0}`;
  const [done, setDone] = useState<{ key: string; payload?: StagesPayload; error?: string } | null>(null);
  useEffect(() => {
    let cancelled = false;
    api.getStages(id, scope, { ...(driver !== undefined ? { driver } : {}), tests }).then(
      (payload) => {
        if (!cancelled) setDone({ key, payload });
      },
      (e: unknown) => {
        if (!cancelled) setDone({ key, error: e instanceof Error ? e.message : String(e) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [id, scope, driver, tests]);
  // An error belongs to the driver it was raised for: a newly picked driver shows the loading line until its own answer comes.
  if (done === null || (done.error !== undefined && done.key !== key)) return <p className="muted small">Loading stages</p>;
  if (done.error !== undefined) return <p className="error" role="alert">{done.error}</p>;
  const payload = done.payload;
  if (payload === undefined || payload.graph === undefined || payload.drivers.length === 0) return null;
  return (
    <StagesDiagram
      id={id}
      graph={payload.graph}
      drivers={payload.drivers}
      showAll={showAll}
      onShowAll={setShowAll}
      onDriver={(d) => setPick({ scope, driver: d })}
      tests={tests}
      onTests={onTests}
      stale={done.key !== key}
    />
  );
}

/** The header, the coverage notes and the pan-and-zoom stage of one stage graph. */
export function StagesDiagram({
  id,
  graph,
  drivers,
  showAll,
  onShowAll,
  onDriver,
  tests = false,
  onTests,
  stale = false,
}: {
  id: string;
  graph: StageGraph;
  drivers: StageDriver[];
  showAll: boolean;
  onShowAll: (on: boolean) => void;
  onDriver: (driverId: string) => void;
  tests?: boolean;
  onTests?: (on: boolean) => void;
  stale?: boolean;
}) {
  const [stageEl, setStageEl] = useState<HTMLDivElement | null>(null);
  const stageW = useElementWidth(stageEl);
  // The window's height, kept current as it resizes: the stage's height follows it.
  const [vh, setVh] = useState(() => (typeof window === "undefined" ? 900 : window.innerHeight));
  useEffect(() => {
    const onResize = () => setVh(window.innerHeight);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  // The arrowhead's id is unique to this diagram, so two diagrams on one page never share a marker.
  const markerId = `stg-head-${useId().replace(/:/g, "")}`;
  // Data edges are on by default. Off, the diagram is the call order alone.
  const [showData, setShowData] = useState(true);
  // The stage under the pointer: its data links that leave or enter it are drawn.
  const [hover, setHover] = useState<string | undefined>(undefined);
  // A frame or a branch under the pointer or focus: the data links that touch any card it draws are drawn.
  const [hoverGroup, setHoverGroup] = useState<string[] | undefined>(undefined);
  // One row when the whole driver fits at a legible scale; otherwise its spine wraps into rows as wide as the stage.
  const plan = useMemo(
    () => planStages(graph, { showAll, data: showData, stageW: stageW > 0 ? stageW : FALLBACK_W }),
    [graph, showAll, showData, stageW],
  );
  const layout = plan.layout;
  const stageH = Math.round(Math.min(Math.max(layout.height * plan.k + STAGE_PAD, STAGE_MIN_H), vh * STAGE_MAX_VH));
  const pz = usePanZoom(stageEl, { w: layout.width, h: layout.height }, { fitMinK: STAGE_MIN_K, maxK: 1, height: stageH });
  const { showCode } = useCodeTarget();
  const empty = graph.body.length === 0;
  const open = (site: Site | undefined) => {
    if (site === undefined || site.line <= 0 || pz.moved()) return;
    showCode(fileTarget(site.file, site.line));
  };
  const frames = layout.nodes.filter((n): n is FrameNode => n.kind === "frame");
  const others = layout.nodes.filter((n) => n.kind !== "frame");
  const hot = hover !== undefined ? [hover] : (hoverGroup ?? []);
  const links = hot.length > 0 ? layout.links.filter((l) => hot.includes(l.from) || hot.includes(l.to)) : [];
  const picked = drivers.some((d) => d.id === graph.driver.id) ? graph.driver.id : drivers[0]?.id;
  return (
    <div className="stg">
      <div className="sysv-bar">
        <span className="stg-title small">
          Stages · <span className="mono">{graph.driver.name}</span>
        </span>
        <label className="small stg-pick">
          Driver{" "}
          <select value={picked} onChange={(e) => onDriver(e.target.value)} aria-label="Pipeline driver">
            {drivers.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name} · {basename(d.file)}
              </option>
            ))}
          </select>
        </label>
        <label className="sysv-tests small">
          <input type="checkbox" checked={showAll} onChange={(e) => onShowAll(e.target.checked)} /> Show all
        </label>
        <label className="sysv-tests small">
          <input type="checkbox" checked={showData} onChange={(e) => setShowData(e.target.checked)} /> Data
        </label>
        {onTests !== undefined && (
          <label className="sysv-tests small">
            <input type="checkbox" checked={tests} onChange={(e) => onTests(e.target.checked)} /> Show tests
          </label>
        )}
        <span className="sysv-zoom" role="group" aria-label="Zoom">
          <button type="button" onClick={() => pz.zoomBy(1 / 1.25)} aria-label="Zoom out">
            −
          </button>
          <button type="button" onClick={() => pz.zoomBy(1.25)} aria-label="Zoom in">
            +
          </button>
          <button type="button" onClick={pz.fit}>
            Fit
          </button>
          <button type="button" onClick={() => pz.setExpanded(!pz.expanded)} aria-pressed={pz.expanded} title="Fill the window (Esc leaves)">
            {pz.expanded ? "Close" : "Expand"}
          </button>
        </span>
      </div>
      {graph.coverage.length > 0 && <p className="muted small stg-notes">{graph.coverage.join(" · ")}</p>}
      {empty ? (
        <p className="muted small">No stages in this driver.</p>
      ) : (
        <div
          className={`sysv-stage stg-stage${stale ? " stale" : ""}`}
          ref={setStageEl}
          style={pz.expanded ? undefined : { height: stageH }}
          onPointerDown={pz.pointer.onPointerDown}
          onPointerMove={pz.pointer.onPointerMove}
          onPointerUp={pz.pointer.onPointerUp}
          onPointerCancel={pz.pointer.onPointerCancel}
        >
          <svg className="sysv-svg" width="100%" height="100%" role="img" aria-label={`Stages of ${graph.driver.name}`}>
            <defs>
              <marker id={markerId} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path className="stg-head" d="M0 0 L10 5 L0 10 z" />
              </marker>
            </defs>
            <g transform={`translate(${pz.cam.x} ${pz.cam.y}) scale(${pz.cam.k})`}>
              {frames.map((f) => (
                <FrameShape key={f.key} n={f} onOpen={open} onGroup={setHoverGroup} />
              ))}
              {layout.paths.map((p) => (
                <PathShape key={p.key} p={p} marker={markerId} />
              ))}
              {others.map((n) => (
                <NodeShape key={n.key} id={id} n={n} onOpen={open} onHover={setHover} onGroup={setHoverGroup} />
              ))}
              {links.map((l) => (
                <LinkShape key={l.key} l={l} marker={markerId} />
              ))}
            </g>
          </svg>
        </div>
      )}
    </div>
  );
}

function FrameShape({
  n,
  onOpen,
  onGroup,
}: {
  n: FrameNode;
  onOpen: (site: Site | undefined) => void;
  onGroup: (ids: string[] | undefined) => void;
}) {
  // The label bar opens the frame's call site; the body is left to its cards. Hovering or focusing the bar reveals the data links
  // of the cards the frame draws.
  const clickable = n.site !== undefined;
  const reveal = (on: boolean) => onGroup(on ? n.members : undefined);
  return (
    <g className={`stg-frame ${n.tone}`}>
      <rect className="stg-frame-body" x={n.x} y={n.y} width={n.w} height={n.h} rx={8} />
      <g
        className={clickable ? "stg-clickable" : undefined}
        role={clickable ? "button" : undefined}
        tabIndex={0}
        onClick={clickable ? () => onOpen(n.site) : undefined}
        onKeyDown={(e) => {
          if (e.key === "Enter" && clickable) onOpen(n.site);
        }}
        onMouseEnter={() => reveal(true)}
        onMouseLeave={() => reveal(false)}
        onFocus={() => reveal(true)}
        onBlur={() => reveal(false)}
      >
        <title>{n.titleFull}</title>
        <rect className="stg-frame-bar" x={n.x} y={n.y} width={n.w} height={LABEL_H} rx={8} />
        <text className="stg-frame-label" x={n.x + 10} y={n.y + 14}>
          {n.label}
        </text>
      </g>
    </g>
  );
}

function PathShape({ p, marker }: { p: LayoutPath; marker: string }) {
  const points = p.points.map((pt: Point) => pt.join(",")).join(" ");
  return <polyline className={`stg-line ${p.tone}`} points={points} markerEnd={p.arrow ? `url(#${marker})` : undefined} />;
}

function NodeShape({
  id,
  n,
  onOpen,
  onHover,
  onGroup,
}: {
  id: string;
  n: Exclude<LayoutNode, { kind: "frame" }>;
  onOpen: (site: Site | undefined) => void;
  onHover: (stage: string | undefined) => void;
  onGroup: (ids: string[] | undefined) => void;
}) {
  switch (n.kind) {
    case "card":
      return (
        <g
          className={`stg-card ${n.tone} stg-clickable`}
          role="button"
          tabIndex={0}
          onClick={() => onOpen(n.site)}
          onMouseEnter={() => onHover(n.stage)}
          onMouseLeave={() => onHover(undefined)}
          onFocus={() => onHover(n.stage)}
          onBlur={() => onHover(undefined)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onOpen(n.site);
          }}
        >
          <title>{n.site !== undefined ? `${n.titleFull}\n${n.site.file}:${n.site.line}` : n.titleFull}</title>
          <rect className="stg-box" x={n.x} y={n.y} width={n.w} height={n.h} rx={8} />
          <text className="stg-name" x={n.x + 10} y={n.y + 20}>
            {n.title}
          </text>
          {n.sub !== undefined && (
            <text className="stg-sub" x={n.x + 10} y={n.y + 34}>
              {n.sub}
            </text>
          )}
          {n.chips.map((c) => (
            <ChipShape key={`${c.x}\0${c.y}\0${c.label}`} id={id} c={c} />
          ))}
        </g>
      );
    case "diamond": {
      const cx = n.x + n.w / 2;
      const cy = n.y + n.h / 2;
      const pts = `${n.x},${cy} ${cx},${n.y} ${n.x + n.w},${cy} ${cx},${n.y + n.h}`;
      return (
        <g
          className="stg-diamond-g stg-clickable"
          tabIndex={0}
          role="button"
          onClick={() => onOpen(n.site)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onOpen(n.site);
          }}
          onMouseEnter={() => onGroup(n.members)}
          onMouseLeave={() => onGroup(undefined)}
          onFocus={() => onGroup(n.members)}
          onBlur={() => onGroup(undefined)}
        >
          <title>{n.titleFull}</title>
          <polygon className="stg-diamond" points={pts} />
        </g>
      );
    }
    case "pill": {
      // An exit pill that opens a call site is a button from the keyboard too: Enter or Space, like a card.
      const clickable = n.site !== undefined;
      return (
        <g
          className={`stg-pill ${n.how} stg-clickable`}
          role={clickable ? "button" : undefined}
          tabIndex={clickable ? 0 : undefined}
          onClick={() => onOpen(n.site)}
          onKeyDown={(e) => {
            if (clickable && (e.key === "Enter" || e.key === " ")) {
              e.preventDefault();
              onOpen(n.site);
            }
          }}
        >
          <rect x={n.x} y={n.y} width={n.w} height={n.h} rx={n.h / 2} />
          <text x={n.x + n.w / 2} y={n.y + n.h / 2 + 4} textAnchor="middle">
            {n.text}
          </text>
        </g>
      );
    }
    case "text":
      return (
        <text className={`stg-text ${n.tone}`} x={n.x} y={n.y}>
          {n.titleFull !== undefined ? <title>{n.titleFull}</title> : null}
          {n.text}
        </text>
      );
    case "data":
      return <DataPill x={n.x} y={n.y} w={n.w} text={n.text} title={n.titleFull} />;
  }
}

/** A data edge's label: a small pill on a connector, or on a link's arc. Its title is the full name and type. */
function DataPill({ x, y, w, text, title }: { x: number; y: number; w: number; text: string; title: string }) {
  return (
    <g className="stg-data">
      <title>{title}</title>
      <rect x={x} y={y} width={w} height={DATA_H} rx={DATA_H / 2} />
      <text x={x + w / 2} y={y + DATA_H / 2 + 3.5} textAnchor="middle">
        {text}
      </text>
    </g>
  );
}

/** A data edge between stages that are not neighbours: a dashed arc with its label, drawn while one of its stages is under the pointer. */
function LinkShape({ l, marker }: { l: LayoutDataLink; marker: string }) {
  const points = l.points.map((pt: Point) => pt.join(",")).join(" ");
  return (
    <g className="stg-link-g">
      <polyline className="stg-link" points={points} markerEnd={`url(#${marker})`} />
      <DataPill x={l.x} y={l.y} w={l.w} text={l.text} title={l.titleFull} />
    </g>
  );
}

/** A component chip: a link to the component's System scope when it has a path, plain text otherwise. */
function ChipShape({ id, c }: { id: string; c: LayoutChip }) {
  const label = (
    <>
      <rect x={c.x} y={c.y} width={c.w} height={c.h} rx={c.h / 2} />
      <text x={c.x + 6} y={c.y + 11}>
        {c.label}
      </text>
      <title>{c.title}</title>
    </>
  );
  if (c.component === undefined) return <g className="stg-chip">{label}</g>;
  return (
    <a
      className="stg-chip"
      href={hrefView(id, "system", { scope: c.component })}
      onClick={(e) => e.stopPropagation()}
    >
      {label}
    </a>
  );
}
