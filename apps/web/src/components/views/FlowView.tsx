import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { api, type FileEntry, type FileFlowSummary, type FindingRow } from "../../api";
import { useCodeTarget } from "../../codeTarget";
import { hrefFlow, hrefView, inScope } from "../../router";
import { ExecStore } from "../../zoom/execStore";
import { kindOf } from "../../findingGroups";
import { findingCounts } from "../../zoom/findingsLayer";
import type { ZoomStore } from "../../zoom/scene";
import type { MapBuild } from "../../zoom/source";
import { zoneOf } from "../../zoom/zones";
import { scopeKind } from "../ScopeNote";
import { LayersPanel, type LayerState } from "../sheet/LayersPanel";
import { SHEET_MID, SHEET_MAX_WIDTH } from "../sheet/bottomSheet";
import { TitleBlock, type TitleFacts } from "../sheet/TitleBlock";
import { ExecContainerPanel } from "../zoom/ExecContainerPanel";
import { ExecFunctionPanel } from "../zoom/ExecFunctionPanel";
import { Stat } from "../zoom/FunctionDetail";
import { ZoomMap, type MapSelection } from "../zoom/ZoomMap";

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
  /** The workspace's flow store: the charts the map and the code pane read. */
  store: ZoomStore;
  /** The code pane's exec slot: the element the focused function's or container's panel is drawn into. */
  slot: HTMLElement | null;
  /** The title block's facts, without the selection, which this view works out. */
  facts: Omit<TitleFacts, "selected">;
  /** The overview is the flow root with the title block emphasised. */
  emphasis: boolean;
  /** Set by "Show in Flow": the findings layer is on, drawing only the findings of this kind. */
  findingKind?: string;
  /** Whether the code pane is open. On a phone it is a bottom sheet over the map, so the map fits a focus above it. */
  codeOpen: boolean;
}

/** The Show-on-the-map card (200 px at 16 px from the left edge) and a 16 px gap: the map's left inset while it is open. */
const LAYERS_INSET = 200 + 16 + 16;

/**
 * The flow view: the execution map fills the center, with the Show-on-the-map card and the title block over it. The selected
 * function's source, and its calls, are in the code pane beside the workspace (see CodePane). Below the map, a folder or the
 * project lists its files with their flows.
 */
export function FlowView({ id, files, scope, fn, roots, store, slot, facts, emphasis, findingKind, codeOpen }: Props) {
  const exec = useMemo(() => new ExecStore(id, roots), [id, roots]);
  const { showCode } = useCodeTarget();
  const kind = scopeKind(scope, files);
  /** What the map shows: frames and calls on by default, findings off until the reader turns the layer on. */
  const [shown, setShown] = useState<LayerState>(() => ({ frames: true, calls: true, findings: findingKind !== undefined }));
  // A "Show in Flow" link for a kind turns the findings layer on, even when the flow is already open.
  useEffect(() => {
    if (findingKind !== undefined) setShown((s) => (s.findings ? s : { ...s, findings: true }));
  }, [findingKind]);
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
  const findingRows = useMemo(
    () => (found?.id === id ? (findingKind === undefined ? found.rows : found.rows.filter((f) => kindOf(f) === findingKind)) : undefined),
    [found, id, findingKind],
  );
  const counts = useMemo(() => (findingRows ? findingCounts(findingRows) : undefined), [findingRows]);
  const mapLayers = useMemo(() => ({ frames: shown.frames, calls: shown.calls }), [shown.frames, shown.calls]);
  /** The function the map selects, with its construct. A new selection shows its code in the code pane. */
  const [sel, setSel] = useState<MapSelection>();
  useEffect(() => {
    if (sel) showCode({ kind: "function", sel });
  }, [sel, showCode]);
  /** The build the map is focused on. */
  const [focus, setFocus] = useState<MapBuild>();
  /** The title block's full table, when the reader opened it. */
  const [titleFull, setTitleFull] = useState(false);
  // The Show-on-the-map card starts collapsed on desktop and phone alike: it is a small button until the reader opens it.
  const [layersOpen, setLayersOpen] = useState(false);
  if (kind === "missing") return <p className="muted">Nothing at this path in the snapshot, so there is no flow to chart.</p>;

  const selectedName = fn ? fn.slice(fn.indexOf("#") + 1) : "none";
  // The zone the focused node sits in, by the centre of its box (zones.ts). A focus with no box has no zone.
  const focusRect = focus?.placed.rects.get(focus.nodeId);
  const zone = focusRect ? zoneOf(focusRect).label : undefined;
  // On a phone the code pane is a bottom sheet. Its middle rest hides the lower part of the map, so the focus is fitted above it
  // (once, when the sheet opens: see ZoomMap's bottomInset). On a desktop the pane is a column, so the map is already clear of it.
  const narrow = typeof window !== "undefined" && window.innerWidth <= SHEET_MAX_WIDTH;
  const bottomInset = codeOpen && narrow ? Math.round(window.innerHeight * SHEET_MID) : 0;
  // The Show-on-the-map card sits over the map's left edge on a desktop: the fit and the rulers keep clear of it.
  const leftInset = layersOpen && !narrow ? LAYERS_INSET : 0;

  return (
    <>
      <div className="sh-sheet">
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
            bottomInset={bottomInset}
            leftInset={leftInset}
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
            shown={shown}
            findingCount={findingRows?.length}
            onChange={(key, on) => setShown((s) => ({ ...s, [key]: on }))}
            onClose={() => setLayersOpen(false)}
            roots={<RootsOnly id={id} scope={scope} fn={fn} roots={roots} className="sh-check" />}
          />
        ) : (
          <button type="button" className="sh-card sh-layers-open" onClick={() => setLayersOpen(true)}>
            Show
          </button>
        )}
        <TitleBlock
          facts={{ ...facts, selected: selectedName, zone: zone ?? "—" }}
          emphasis={emphasis}
          expanded={titleFull}
          onToggle={() => setTitleFull((v) => !v)}
        />
      </div>
      {kind !== "file" && <FlowFolders id={id} scope={scope} />}
    </>
  );
}

/** The roots-only switch on the canvas. Turning it on or off changes the URL, and the canvas follows the URL. */
function RootsOnly({ id, scope, fn, roots, className = "sh-roots" }: { id: string; scope: string; fn?: string; roots: boolean; className?: string }) {
  return (
    <label className={className}>
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
      <p className="muted small">Pick a file in the tree on the left, or a row below, to draw its control flow.</p>
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
