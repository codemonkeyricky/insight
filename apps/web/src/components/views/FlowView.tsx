import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { api, type FileEntry, type FileFlowSummary, type FindingRow } from "../../api";
import { hrefFlow, hrefView, inScope } from "../../router";
import { ExecStore } from "../../zoom/execStore";
import { findingCounts } from "../../zoom/findingsLayer";
import { ZoomStore } from "../../zoom/scene";
import type { MapBuild } from "../../zoom/source";
import { zoneOf } from "../../zoom/zones";
import { scopeKind } from "../ScopeNote";
import { LayersPanel, type LayerLink, type LayerState } from "../sheet/LayersPanel";
import { SidePanel } from "../sheet/SidePanel";
import { TitleBlock, type TitleFacts } from "../sheet/TitleBlock";
import { ExecContainerPanel } from "../zoom/ExecContainerPanel";
import { ExecFunctionPanel } from "../zoom/ExecFunctionPanel";
import { FunctionSource } from "../zoom/FunctionSource";
import { Stat } from "../zoom/FunctionDetail";
import { ZoomMap, type MapSelection } from "../zoom/ZoomMap";
import { SourceView } from "./SourceView";

type Loaded<T> = { status: "loading" } | { status: "ready"; data: T } | { status: "error"; message: string };

/** Runs `load` when `key` changes. An answer that arrives for a key no longer shown is dropped. */
function useLoaded<T>(key: string, load: () => Promise<T>): Loaded<T> {
  const [done, setDone] = useState<{ key: string; state: Loaded<T> } | null>(null);
  useEffect(() => {
    let cancelled = false;
    load().then(
      (data) => {
        if (!cancelled) setDone({ key, state: { status: "ready", data } });
      },
      (e: unknown) => {
        if (!cancelled) setDone({ key, state: { status: "error", message: e instanceof Error ? e.message : String(e) } });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [key]);
  return done?.key === key ? done.state : { status: "loading" };
}

interface Props {
  id: string;
  files: FileEntry[];
  scope: string;
  fn?: string;
  /** The canvas shows only the functions each thread starts in. */
  roots: boolean;
  line?: number;
  /** The Layers card's rows: the project's pages and the scope's lenses. */
  layers: LayerLink[];
  /** The title block's facts, without the selection, which this view works out. */
  facts: Omit<TitleFacts, "selected">;
  /** The overview is the flow root with the title block emphasised. */
  emphasis: boolean;
  /** The source tab on a file: the side panel shows the file's source. */
  fileSource: boolean;
}

/**
 * The flow sheet: the execution map fills the stage, with the Layers card, the title block and the side panel over it. The
 * side panel shows the selected function's source and its exec panel (a function's trail, chart and call lists, or a
 * container's functions), and a file's source on the source tab. Below the sheet, a folder or project lists its files.
 */
/** The width the side panel takes over the map, with its gap on each side. */
const SIDE_INSET = 380 + 2 * 16;

export function FlowView({ id, files, scope, fn, roots, line, layers, facts, emphasis, fileSource }: Props) {
  const store = useMemo(() => new ZoomStore(id), [id]);
  const exec = useMemo(() => new ExecStore(id, roots), [id, roots]);
  const kind = scopeKind(scope, files);
  /** What the map shows: frames and calls on by default, findings off until the reader turns the layer on. */
  const [shown, setShown] = useState<LayerState>({ frames: true, calls: true, findings: false });
  const findingsOn = shown.findings;
  /** The findings of the project, loaded the first time the findings layer is on. */
  const [found, setFound] = useState<{ id: string; rows: FindingRow[] } | undefined>();
  useEffect(() => {
    if (!findingsOn || found?.id === id) return;
    let cancelled = false;
    // A failed load shows no findings rather than breaking the map; the layer stays on and the count reads zero.
    api.findings(id).then(
      (rows) => {
        if (!cancelled) setFound({ id, rows });
      },
      () => {
        if (!cancelled) setFound({ id, rows: [] });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [id, findingsOn, found?.id]);
  const findingRows = found?.id === id ? found.rows : undefined;
  const counts = useMemo(() => (findingRows ? findingCounts(findingRows) : undefined), [findingRows]);
  const mapLayers = useMemo(() => ({ frames: shown.frames, calls: shown.calls }), [shown.frames, shown.calls]);
  /** The function the map selects, with its construct. */
  const [sel, setSel] = useState<MapSelection>();
  /** The build the map is focused on. */
  const [focus, setFocus] = useState<MapBuild>();
  /** The build the reader closed the panel on, and the scope and function it was closed under. */
  const [closed, setClosed] = useState<{ build: MapBuild | undefined; at: string }>();
  /** The title block's full table, when the reader opened it. It stays compact while a chart is open. */
  const [titleFull, setTitleFull] = useState(false);
  // The Layers card covers the map on a phone, so it starts closed on narrow screens.
  const [layersOpen, setLayersOpen] = useState(() => typeof window === "undefined" || window.innerWidth > 720);
  /** The element the side panel hands the exec panel to. A portal draws the panel there from the map's detail hook. */
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  if (kind === "missing") return <p className="muted">Nothing at this path in the snapshot, so there is no flow to chart.</p>;

  const at = `${scope}\0${fn ?? ""}`;
  const focusNested = focus !== undefined && (focus.selected !== undefined || focus.path !== scope);
  const dismissed = closed !== undefined && closed.at === at && closed.build === focus;
  const open = (fileSource || focusNested) && !dismissed;
  const selectedName = fn ? fn.slice(fn.indexOf("#") + 1) : "none";
  // The zone the focused node sits in, by the centre of its box (zones.ts). A focus with no box has no zone.
  const focusRect = focus?.placed.rects.get(focus.nodeId);
  const zone = focusRect ? zoneOf(focusRect).label : undefined;
  // The side panel (380px) sits 16px in from the right edge with a 16px gap: on a wide screen the map keeps clear of it.
  const inset = open && (typeof window === "undefined" || window.innerWidth > 720) ? SIDE_INSET : 0;

  return (
    <>
      <div className="sh-sheet" data-panel={open ? "open" : "closed"}>
        <div className="sh-canvas">
          <RootsOnly id={id} scope={scope} fn={fn} roots={roots} />
          <ZoomMap
            key={roots ? "roots" : "all"}
            id={id}
            source={exec}
            scope={scope}
            fn={fn}
            charts={{ id, scope, store }}
            onSelect={setSel}
            onFocus={setFocus}
            hint={false}
            inset={inset}
            layers={mapLayers}
            findings={findingsOn ? counts ?? new Map<string, number>() : undefined}
            detail={(build, openNode) => {
              const view = exec.viewOf(build);
              if (view === undefined || slot === null) return null;
              const panel = { id, scope: build.path, roots, store, index: view.index, nodeId: build.nodeId, onOpen: openNode };
              return createPortal(
                build.selected ? (
                  <ExecFunctionPanel {...panel} selected={build.selected} />
                ) : (
                  <ExecContainerPanel {...panel} rootKind={kind} />
                ),
                slot,
              );
            }}
          />
        </div>
        {layersOpen ? (
          <LayersPanel
            links={layers}
            shown={shown}
            findingCount={findingRows?.length}
            onChange={(key, on) => setShown((s) => ({ ...s, [key]: on }))}
            onClose={() => setLayersOpen(false)}
          />
        ) : (
          <button type="button" className="sh-card sh-layers-open" onClick={() => setLayersOpen(true)}>
            Layers
          </button>
        )}
        <TitleBlock
          facts={{ ...facts, selected: selectedName, zone: zone ?? "—" }}
          emphasis={emphasis}
          expanded={titleFull}
          locked={open}
          onToggle={() => setTitleFull((v) => !v)}
        />
        <SidePanel
          open={open}
          label="Detail"
          onClose={() => setClosed({ build: focus, at })}
        >
          {fileSource && !sel && <SourceView id={id} files={files} scope={scope} line={line} />}
          {sel && <FunctionSource id={id} store={store} sel={sel} />}
          <div className="sh-slot" ref={setSlot} />
        </SidePanel>
      </div>
      {kind !== "file" && <FlowFolders id={id} scope={scope} />}
    </>
  );
}

/** The roots-only switch on the canvas. Turning it on or off changes the URL, and the canvas follows the URL. */
function RootsOnly({ id, scope, fn, roots }: { id: string; scope: string; fn?: string; roots: boolean }) {
  return (
    <label className="sh-roots">
      <input
        type="checkbox"
        checked={roots}
        onChange={(e) => {
          window.location.hash = hrefView(id, "flow", { scope, ...(fn ? { fn } : {}), roots: e.target.checked });
        }}
      />{" "}
      Roots only
    </label>
  );
}

function FlowFolders({ id, scope }: { id: string; scope: string }) {
  const rows = useLoaded(`${id}\0summary`, () => api.flowSummary(id));
  if (rows.status === "error") return <p className="error" role="alert">{rows.message}</p>;
  if (rows.status === "loading") return <p className="muted">Loading</p>;
  const shown = rows.data.filter((r) => inScope(r.file, scope));
  const sum = (k: "functions" | "decisions" | "loops" | "exits") => shown.reduce((n, r) => n + r[k], 0);
  return (
    <section className="sh-below">
      <p className="muted small">Pick a file in the Files drawer, or a row below, to draw its control flow.</p>
      {shown.length === 0 ? (
        <p className="muted">No function in this scope has a flow to chart.</p>
      ) : (
        <>
          <div className="stats">
            <Stat label="Files with functions" value={shown.length} />
            <Stat label="Functions" value={sum("functions")} />
            <Stat label="Decisions" value={sum("decisions")} />
            <Stat label="Loops" value={sum("loops")} />
            <Stat label="Exits" value={sum("exits")} />
          </div>
          <div className="flow-table">
            <FileTable id={id} rows={shown} />
          </div>
        </>
      )}
    </section>
  );
}

function FileTable({ id, rows }: { id: string; rows: FileFlowSummary[] }) {
  return (
    <table className="grid">
      <thead>
        <tr>
          <th>File</th>
          <th>Functions</th>
          <th>Steps</th>
          <th>Decisions</th>
          <th>Loops</th>
          <th>Exits</th>
          <th>Busiest function</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.file}>
            <td>
              <a className="mono small" href={hrefFlow(id, r.file)}>
                {r.file}
              </a>
            </td>
            <td>{r.functions}</td>
            <td>{r.steps}</td>
            <td>{r.decisions}</td>
            <td>{r.loops}</td>
            <td>{r.exits}</td>
            <td>
              {r.busiest ? (
                <>
                  <a href={hrefView(id, "flow", { scope: r.file, fn: r.busiest.id })}>{r.busiest.name}</a>{" "}
                  <span className="muted small">{r.busiest.branches} branches</span>
                </>
              ) : (
                <span className="muted">none</span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

