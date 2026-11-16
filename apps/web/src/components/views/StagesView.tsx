import { useEffect, useMemo, useState } from "react";
import type { StageGraph, StageDriver } from "@insight/model";
import { api } from "../../api";
import { layoutStages, LABEL_H, type LayoutChip, type LayoutNode, type LayoutPath, type Point } from "../../arch/stages-layout";
import { fileTarget, useCodeTarget } from "../../codeTarget";
import { hrefView } from "../../router";
import type { StagesPayload } from "../../model/payloads";
import { usePanZoom } from "./usePanZoom";

type Site = { file: string; line: number };
/** The smallest scale Fit settles on: the labels are 11 to 13 px, and a wider diagram is panned rather than shrunk. */
const STAGES_FIT_MIN_K = 0.9;
type FrameNode = Extract<LayoutNode, { kind: "frame" }>;

const base = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

/**
 * The Stages section of the Pipeline view: the call order of one pipeline driver as a static-analysis diagram. Loops, branches,
 * try/catch and exits are drawn as the code has them; a fanout card lists the components its candidates live in. The
 * payload is computed in the page from the project model (api.getStages). A card or a frame opens the Code pane at its call
 * line; a component chip opens that component's System scope.
 */
export function StagesView({ id, scope }: { id: string; scope: string }) {
  const [showAll, setShowAll] = useState(false);
  const [pick, setPick] = useState<{ scope: string; driver: string } | null>(null);
  // The picked driver is kept for the scope it was picked in; a new scope starts with its first driver.
  const driver = pick !== null && pick.scope === scope ? pick.driver : undefined;
  const key = `${id}\0${scope}\0${driver ?? ""}`;
  const [done, setDone] = useState<{ key: string; payload?: StagesPayload; error?: string } | null>(null);
  useEffect(() => {
    let cancelled = false;
    api.getStages(id, scope, driver !== undefined ? { driver } : {}).then(
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
  }, [id, scope, driver, key]);
  if (done === null) return <p className="muted small">Loading stages</p>;
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
  stale = false,
}: {
  id: string;
  graph: StageGraph;
  drivers: StageDriver[];
  showAll: boolean;
  onShowAll: (on: boolean) => void;
  onDriver: (driverId: string) => void;
  stale?: boolean;
}) {
  const layout = useMemo(() => layoutStages(graph, { showAll }), [graph, showAll]);
  const [stageEl, setStageEl] = useState<HTMLDivElement | null>(null);
  // Fit never shrinks the diagram below 0.9: a wide driver is panned, and its labels stay readable.
  const pz = usePanZoom(stageEl, { w: layout.width, h: layout.height }, STAGES_FIT_MIN_K);
  const { showCode } = useCodeTarget();
  const empty = graph.body.length === 0;
  const open = (site: Site | undefined) => {
    if (site === undefined || site.line <= 0 || pz.moved()) return;
    showCode(fileTarget(site.file, site.line));
  };
  const frames = layout.nodes.filter((n): n is FrameNode => n.kind === "frame");
  const others = layout.nodes.filter((n) => n.kind !== "frame");
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
                {d.name} · {base(d.file)}
              </option>
            ))}
          </select>
        </label>
        <label className="sysv-tests small">
          <input type="checkbox" checked={showAll} onChange={(e) => onShowAll(e.target.checked)} /> Show all
        </label>
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
          style={pz.stageH === null ? undefined : { height: pz.stageH }}
          onPointerDown={pz.pointer.onPointerDown}
          onPointerMove={pz.pointer.onPointerMove}
          onPointerUp={pz.pointer.onPointerUp}
          onPointerCancel={pz.pointer.onPointerCancel}
        >
          <svg className="sysv-svg" width="100%" height="100%" role="img" aria-label={`Stages of ${graph.driver.name}`}>
            <defs>
              <marker id="stg-head" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path className="stg-head" d="M0 0 L10 5 L0 10 z" />
              </marker>
            </defs>
            <g transform={`translate(${pz.cam.x} ${pz.cam.y}) scale(${pz.cam.k})`}>
              {frames.map((f) => (
                <FrameShape key={f.key} n={f} onOpen={open} />
              ))}
              {layout.paths.map((p) => (
                <PathShape key={p.key} p={p} />
              ))}
              {others.map((n) => (
                <NodeShape key={n.key} id={id} n={n} onOpen={open} />
              ))}
            </g>
          </svg>
        </div>
      )}
    </div>
  );
}

function FrameShape({ n, onOpen }: { n: FrameNode; onOpen: (site: Site | undefined) => void }) {
  // The label bar opens the frame's call site; the body is left to its cards.
  const clickable = n.site !== undefined;
  return (
    <g className={`stg-frame ${n.tone}`}>
      <rect className="stg-frame-body" x={n.x} y={n.y} width={n.w} height={n.h} rx={8} />
      <g className={clickable ? "stg-clickable" : undefined} onClick={clickable ? () => onOpen(n.site) : undefined}>
        <title>{n.titleFull}</title>
        <rect className="stg-frame-bar" x={n.x} y={n.y} width={n.w} height={LABEL_H} rx={8} />
        <text className="stg-frame-label" x={n.x + 10} y={n.y + 14}>
          {n.label}
        </text>
      </g>
    </g>
  );
}

function PathShape({ p }: { p: LayoutPath }) {
  const points = p.points.map((pt: Point) => pt.join(",")).join(" ");
  return <polyline className={`stg-line ${p.tone}`} points={points} markerEnd={p.arrow ? "url(#stg-head)" : undefined} />;
}

function NodeShape({ id, n, onOpen }: { id: string; n: Exclude<LayoutNode, { kind: "frame" }>; onOpen: (site: Site | undefined) => void }) {
  switch (n.kind) {
    case "card":
      return (
        <g
          className={`stg-card ${n.tone} stg-clickable`}
          role="button"
          tabIndex={0}
          onClick={() => onOpen(n.site)}
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
        <g className="stg-diamond-g stg-clickable" onClick={() => onOpen(n.site)}>
          <title>{n.titleFull}</title>
          <polygon className="stg-diamond" points={pts} />
        </g>
      );
    }
    case "pill":
      return (
        <g className={`stg-pill ${n.how} stg-clickable`} onClick={() => onOpen(n.site)}>
          <rect x={n.x} y={n.y} width={n.w} height={n.h} rx={n.h / 2} />
          <text x={n.x + n.w / 2} y={n.y + n.h / 2 + 4} textAnchor="middle">
            {n.text}
          </text>
        </g>
      );
    case "text":
      return (
        <text className={`stg-text ${n.tone}`} x={n.x} y={n.y}>
          {n.titleFull !== undefined ? <title>{n.titleFull}</title> : null}
          {n.text}
        </text>
      );
  }
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
