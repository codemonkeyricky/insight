import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { api, IS_HOSTED, type FileEntry, type Overview } from "../api";
import { CodeTargetContext, opensCodePane, scopeCodeTarget, type CodeTarget, type CodeTargetValue } from "../codeTarget";
import { contentOf, layerLinks, type ShellContent } from "./sheet/shell";
import { hrefView, redirectFor } from "../router";
import { StatusBadge } from "../pages/Projects";
import { useIndexProgress } from "../useIndexProgress";
import { FirstIndex, IndexStrip } from "./IndexStrip";
import { HostedReindex } from "./HostedReindex";
import { scopeKind } from "./ScopeNote";
import { CodePane } from "./sheet/CodePane";
import { FileTree } from "./sheet/FileTree";
import { FindPalette } from "./sheet/FindPalette";
import { LayerTabs } from "./sheet/LayerTabs";
import { CODE_KEY, COMPACT_CODE_W, COMPACT_TREE_W, TREE_KEY, isNarrow, useCompactPanes, useNarrow, usePaneWidth } from "./sheet/panes";
import { Splitter } from "./sheet/Splitter";
import { TopBar, type Crumb } from "./sheet/TopBar";
import type { TitleFacts } from "./sheet/TitleBlock";
import { shortCommit } from "./sheet/TitleBlock";
import { ArchView } from "./views/ArchView";
import { PipelineTab } from "./views/PipelineTab";
import { FlowView } from "./views/FlowView";
import { SystemView } from "./views/SystemView";
import { ZoomStore } from "../zoom/scene";

/** The System tab. It asks the workspace to collapse the code pane while it is shown and no code is open, and restores it on leaving. */
function SystemTab({ id, scope, onSystemActive }: { id: string; scope: string; onSystemActive: (on: boolean) => void }) {
  useEffect(() => {
    onSystemActive(true);
    return () => onSystemActive(false);
  }, [onSystemActive]);
  return <SystemView id={id} scope={scope} />;
}

/** The default widths of the file tree and the code pane, in px, until the reader resizes them. */
const TREE_DEFAULT = 280;
const CODE_DEFAULT = 440;

export interface WorkspaceProps {
  id: string;
  tab: string;
  scope: string;
  line?: number;
  fn?: string;
  /** The function whose caller chain the Caller chain section shows; kept while the reader walks up the chain. */
  trace?: string;
  base?: string;
  head?: string;
  /** The flow tab's findings layer, drawing only the findings of this kind. */
  findingKind?: string;
}

interface Loaded {
  overview: Overview;
  files: FileEntry[];
}

const isEditable = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));

/**
 * One project in the workspace: a glass top bar over three panes. The file tree on the left and the code pane on the right
 * stay put on every tab; the center holds the layers as tabs over the view. On a phone the two side panes are drawers, opened
 * from the top bar. Find opens as an overlay.
 */
export function Workspace({ id, tab, scope, line, fn, trace, base, head, findingKind }: WorkspaceProps) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  /** The desktop panes: shown or collapsed. */
  const [treeCollapsed, setTreeCollapsed] = useState(false);
  const [codeCollapsed, setCodeCollapsed] = useState(false);
  /** The phone drawers: open or closed. Only one of the two is open at a time. */
  const [filesOpen, setFilesOpen] = useState(false);
  const [codeDrawer, setCodeDrawer] = useState(false);
  const [treeW, setTreeW] = usePaneWidth(TREE_KEY, TREE_DEFAULT);
  const [codeW, setCodeW] = usePaneWidth(CODE_KEY, CODE_DEFAULT);
  const narrow = useNarrow();
  const compact = useCompactPanes();
  /** What the code pane shows, and the element the flow map draws its exec panel into. */
  const [target, setTarget] = useState<CodeTarget>();
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  /** The flow charts, shared by the map and the code pane, so both read one cache. */
  const store = useMemo(() => new ZoomStore(id), [id]);

  // Picking code shows it: the pane opens (the Code drawer on a phone). A file scope set by a link shows silently, below.
  const showCode = useCallback((t: CodeTarget) => {
    setTarget(t);
    if (isNarrow()) {
      setCodeDrawer(true);
      setFilesOpen(false);
    } else {
      autoCodeCollapse.current = false;
      setCodeCollapsed(false);
    }
  }, []);
  // The System view wants the width: while it is shown and no code is open, the code pane starts collapsed. Opening code (a
  // file:line link) or the Code button brings it back, and leaving System restores it.
  const autoCodeCollapse = useRef(false);
  const codeCollapsedNow = useRef(codeCollapsed);
  codeCollapsedNow.current = codeCollapsed;
  const targetNow = useRef(target);
  targetNow.current = target;
  const onSystemActive = useCallback((on: boolean) => {
    if (on) {
      if (!isNarrow() && !codeCollapsedNow.current && targetNow.current === undefined) {
        autoCodeCollapse.current = true;
        setCodeCollapsed(true);
      }
    } else if (autoCodeCollapse.current) {
      autoCodeCollapse.current = false;
      setCodeCollapsed(false);
    }
  }, []);
  const codeCtx = useMemo<CodeTargetValue>(() => ({ target, showCode }), [target, showCode]);

  const load = useCallback(async () => {
    try {
      const [overview, files] = await Promise.all([api.overview(id), api.files(id)]);
      setLoaded({ overview, files });
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  // An old view (Overview, Arch, Compare, Triage, a lens) has no tab any more, so its link goes to the tab that replaces it.
  const redirect = redirectFor({ name: "workspace", id, tab, scope, line, fn, trace, base, head, kind: findingKind });
  useEffect(() => {
    if (redirect !== undefined) window.location.replace(redirect);
  }, [redirect]);

  // The run's progress, for the strip and the first-index state. The overview reloads when a run starts, ends or fails.
  const run = useIndexProgress(id, loaded?.overview.project.progress, (event) => {
    if (event.type === "done" || event.type === "failed" || event.type === "status") void load();
  });

  // Ctrl/Cmd+K toggles Find, "/" opens it outside a text field, and Escape closes the phone's file drawer.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setFindOpen((o) => !o);
      } else if (e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey && !isEditable(e.target)) {
        e.preventDefault();
        setFindOpen(true);
      } else if (e.key === "Escape" && !e.defaultPrevented) {
        setFilesOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // A file scope (a link, a finding, the Find palette, a tree click) shows that file in the code pane. A folder or the project
  // sets nothing, so the pane keeps the code it shows. A link to a line opens the code pane at that line; a file scope with no
  // line shows its code without opening a closed pane.
  const fileScope = loaded !== null && scopeKind(scope, loaded.files) === "file";
  useEffect(() => {
    const next = scopeCodeTarget(scope, fileScope, line);
    if (next === undefined) return;
    if (opensCodePane(line)) showCode(next);
    else setTarget(next);
  }, [scope, fileScope, line, showCode]);

  if (redirect !== undefined) return null;
  if (!loaded) return error ? <p className="error" role="alert">{error}</p> : <p className="muted">Loading</p>;

  const { overview, files } = loaded;
  const p = overview.project;
  const sourceText = p.source.kind === "path" ? p.source.path : p.source.url;
  const content: ShellContent = contentOf(tab);
  // A project with no snapshot yet has nothing to chart, so its views give way to the first index's progress.
  const noSnapshot = overview.snapshot === null;
  // The tree picks flow for the flow tab; the other tabs keep their own tab, so a picked file opens its flow with its code in the pane.
  const explorerTab = content === "flow" ? "flow" : tab;
  // Views remount when the snapshot or view changes, so no state from the last one carries over. The flow map follows the scope and
  // function in place, so a scope change animates the camera rather than remounting the map. The other tabs follow the scope in place.
  const viewKey = `${overview.snapshot?.id ?? "none"}|${content}`;

  const parts = scope ? scope.split("/") : [];
  // A crumb keeps the tab the reader is on (Arch, a lens) and otherwise goes to Flow, so a folder crumb always has a view.
  const crumbTab = content === "flow" ? "flow" : tab;
  const crumbs: Crumb[] = [
    { label: p.name, href: hrefView(id, "flow"), current: parts.length === 0 },
    ...parts.map((seg, i): Crumb => {
      const path = parts.slice(0, i + 1).join("/");
      return { label: seg, href: hrefView(id, crumbTab, { scope: path }), current: i === parts.length - 1 };
    }),
  ];

  const layers = layerLinks({ id, tab, scope });

  const facts: Omit<TitleFacts, "selected"> = {
    project: p.name,
    scope: scope || "Project",
    source: sourceText,
    commit: shortCommit(overview.snapshot?.commit),
    indexed: overview.snapshot ? overview.snapshot.createdAt.replace("T", " ").slice(0, 16) : "—",
    files: String(files.length),
  };

  // The panes: on a desktop each is a column (its width, or none when collapsed); on a phone the grid is one column and the
  // side panes are drawers, so the widths do not apply.
  const treeShown = narrow ? filesOpen : !treeCollapsed;
  const codeShown = narrow ? codeDrawer : !codeCollapsed;
  // Below 1200px the side panes narrow (Files 220px, Code 300px), so the tab strip has room in the centre column.
  const treeEff = compact ? Math.min(treeW, COMPACT_TREE_W) : treeW;
  const codeEff = compact ? Math.min(codeW, COMPACT_CODE_W) : codeW;
  const bodyStyle = {
    "--tree-col": `${treeShown ? treeEff : 0}px`,
    "--split-l": treeShown ? "1px" : "0px",
    "--code-col": `${codeShown ? codeEff : 0}px`,
    "--split-r": codeShown ? "1px" : "0px",
  } as CSSProperties;

  const toggleFiles = () => {
    if (narrow) {
      setFilesOpen(!filesOpen);
      setCodeDrawer(false);
    } else {
      setTreeCollapsed(!treeCollapsed);
    }
  };
  const toggleCode = () => {
    if (narrow) {
      setCodeDrawer(!codeDrawer);
      setFilesOpen(false);
    } else {
      autoCodeCollapse.current = false;
      setCodeCollapsed(!codeCollapsed);
    }
  };

  const renderPage = (): ReactNode => {
    switch (content) {
      case "system":
        return <SystemTab id={id} scope={scope} onSystemActive={onSystemActive} />;
      case "pipeline":
        return <PipelineTab id={id} scope={scope} onSystemActive={onSystemActive} />;
      case "packages":
        return (
          <div className="packages-tab">
            <ArchView id={id} scope={scope} />
          </div>
        );
      default:
        return null;
    }
  };

  return (
    <CodeTargetContext.Provider value={codeCtx}>
      <TopBar
        crumbs={crumbs}
        filesOpen={treeShown}
        codeOpen={codeShown}
        onFiles={toggleFiles}
        onCode={toggleCode}
        onFind={() => setFindOpen(true)}
      />
      <div className="sh-body" style={bodyStyle}>
        <FileTree
          id={id}
          tab={explorerTab}
          fileTab={explorerTab}
          scope={scope}
          files={files}
          open={treeShown}
          onClose={toggleFiles}
        />
        <Splitter side="left" label="Resize the files pane" width={treeEff} shown={treeShown && !narrow} onResize={setTreeW} />
        <section className="sh-center">
          <LayerTabs links={layers} />
          {IS_HOSTED ? (
            <HostedReindex id={id} />
          ) : (
            <IndexStrip id={id} project={p} snapshot={overview.snapshot} run={run} onRequested={() => void load()} />
          )}
          {noSnapshot ? (
            <FirstIndex name={p.name} run={run} running={run.running || p.status === "indexing"} />
          ) : content === "flow" ? (
            <div className="sh-stage sh-stage-flow">
              {error && <p className="error" role="alert">{error}</p>}
              <FlowView
                id={id}
                files={files}
                scope={scope}
                fn={fn}
                store={store}
                slot={slot}
                facts={facts}
                emphasis={scope === ""}
                findingKind={findingKind}
                codeOpen={codeShown}
              />
            </div>
          ) : (
            <div className="sh-stage sh-page">
              <div className="sh-page-head">
                <h1>{p.name}</h1>
                <StatusBadge project={p} />
              </div>
              {error && <p className="error" role="alert">{error}</p>}
              <div key={viewKey}>{renderPage()}</div>
            </div>
          )}
        </section>
        <Splitter side="right" label="Resize the code pane" width={codeEff} shown={codeShown && !narrow} onResize={setCodeW} />
        <CodePane
          id={id}
          trace={trace}
          store={store}
          target={target}
          open={codeShown}
          docked={!narrow}
          onClose={toggleCode}
          onSlot={setSlot}
        />
      </div>
      {findOpen && <FindPalette id={id} files={files} onClose={() => setFindOpen(false)} />}
    </CodeTargetContext.Provider>
  );
}
