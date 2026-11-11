import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { api, NO_SERVER, type FileEntry, type Overview, type ScopeLenses } from "../api";
import { CodeTargetContext, opensCodePane, scopeCodeTarget, type CodeTarget, type CodeTargetValue } from "../codeTarget";
import { contentOf, flowScopeOf, layerLinks, type ShellContent } from "./sheet/shell";
import { hrefView, redirectFor } from "../router";
import { canonicalScope } from "../scopeKey";
import { lensTab, tabbedLenses } from "../scopeLenses";
import { ComparePage } from "../pages/Compare";
import { LensPage } from "../pages/LensPage";
import { ProjectOverview } from "../pages/ProjectOverview";
import { ReviewPage } from "../pages/Review";
import { StatusBadge } from "../pages/Projects";
import { useIndexProgress } from "../useIndexProgress";
import { FirstIndex, IndexStrip } from "./IndexStrip";
import { ScopeNote, scopeKind } from "./ScopeNote";
import { CodePane } from "./sheet/CodePane";
import { FileTree } from "./sheet/FileTree";
import { FindPalette } from "./sheet/FindPalette";
import { LayerTabs } from "./sheet/LayerTabs";
import { CODE_KEY, COMPACT_CODE_W, COMPACT_TREE_W, TREE_KEY, isNarrow, useCompactPanes, useNarrow, usePaneWidth } from "./sheet/panes";
import { Splitter } from "./sheet/Splitter";
import { TopBar, type Crumb } from "./sheet/TopBar";
import type { TitleFacts } from "./sheet/TitleBlock";
import { shortCommit } from "./sheet/TitleBlock";
import { ArchTab } from "./views/ArchTab";
import { FlowView } from "./views/FlowView";
import { ZoomStore } from "../zoom/scene";

/** Tabs that cover the whole project. The explorer scope does not narrow them. */
const PROJECT_WIDE = new Set(["overview", "compare", "review"]);

/** The default widths of the file tree and the code pane, in px, until the reader resizes them. */
const TREE_DEFAULT = 280;
const CODE_DEFAULT = 440;

export interface WorkspaceProps {
  id: string;
  tab: string;
  scope: string;
  line?: number;
  fn?: string;
  /** The flow tab's canvas shows only the functions each thread starts in. */
  roots?: boolean;
  base?: string;
  head?: string;
  /** The overview tab with the full overview page, rather than the flow root. */
  full?: boolean;
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
export function Workspace({ id, tab, scope, line, fn, roots = true, base, head, full = false, findingKind }: WorkspaceProps) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [listing, setListing] = useState<ScopeLenses | null>(null);
  const [listingError, setListingError] = useState<string | null>(null);
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
  // Listings by snapshot and scope, so a scope the user has already opened is not asked for again.
  const listings = useRef(new Map<string, ScopeLenses>());

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

  // A retired tab is replaced by its new home: the execution lens by the flow tab, and Source and Findings by Overview.
  const redirect = redirectFor({ name: "workspace", id, tab, scope, ...(line !== undefined ? { line } : {}) });
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

  const snapshotId = loaded?.overview.snapshot?.id ?? null;
  const listingKey = snapshotId === null ? null : `${snapshotId}|${scope}`;

  useEffect(() => {
    if (listingKey === null) return;
    const hit = listings.current.get(listingKey);
    if (hit) {
      setListing(hit);
      setListingError(null);
      return;
    }
    let cancelled = false;
    api.scopeLenses(id, scope).then(
      (next) => {
        if (cancelled) return;
        listings.current.set(listingKey, next);
        setListing(next);
        setListingError(null);
      },
      (e: Error) => {
        if (cancelled) return;
        setListing(null);
        setListingError(e.message);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [id, scope, listingKey]);

  // Running a lens can store a new result, which changes the tabs. The listing is fetched again once a lens page has loaded.
  const refreshListing = useCallback(() => {
    if (listingKey === null) return;
    api.scopeLenses(id, scope).then(
      (next) => {
        listings.current.set(listingKey, next);
        setListing(next);
        setListingError(null);
      },
      (e: Error) => setListingError(e.message),
    );
  }, [id, scope, listingKey]);

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
  const kind = scopeKind(scope, files);
  const content: ShellContent = contentOf(tab, kind, full);
  // A project with no snapshot yet has nothing to chart, so its views give way to the first index's progress.
  const noSnapshot = overview.snapshot === null;
  const lensTabs = listing ? tabbedLenses(listing.lenses).map((row) => lensTab(row, !NO_SERVER)) : [];
  // The banner's numbers belong to one scope. A listing for another scope is not shown while the new one loads.
  const stats = listing && listing.scope === canonicalScope(scope) ? listing.stats : null;
  // The tree picks flow for the flow view and the project-wide pages (a picked file opens its flow, with its code in the pane),
  // and the lens's own tab for a lens.
  const explorerTab = content === "flow" || (PROJECT_WIDE.has(tab) && tab !== "arch") ? "flow" : tab;
  // Views remount when the snapshot, view or scope changes, so no state from the last one carries over. The flow map
  // follows the scope and function in place, so a scope change animates the camera rather than remounting the map.
  const viewKey = `${overview.snapshot?.id ?? "none"}|${content}|${content === "flow" || tab === "arch" ? "" : scope}|${base ?? ""}|${head ?? ""}|${full}`;

  const parts = scope ? scope.split("/") : [];
  // A crumb keeps the tab the reader is on (Arch, a lens) and otherwise goes to Flow, so a folder crumb always has a view.
  const crumbTab = content === "flow" ? "flow" : content === "arch" || content === "lens" ? tab : "flow";
  const crumbs: Crumb[] = [
    { label: p.name, href: hrefView(id, "overview"), current: parts.length === 0 },
    ...parts.map((seg, i): Crumb => {
      const path = parts.slice(0, i + 1).join("/");
      return { label: seg, href: hrefView(id, crumbTab, { scope: path }), current: i === parts.length - 1 };
    }),
  ];

  const layers = layerLinks({ id, tab, scope, content, noServer: NO_SERVER, lenses: lensTabs });

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
      case "overview":
        return <ProjectOverview id={id} />;
      case "arch":
        return <ArchTab id={id} scope={scope} onSystemActive={onSystemActive} />;
      case "compare":
        return <ComparePage id={id} base={base} head={head} />;
      case "triage":
        return <ReviewPage id={id} />;
      case "lens":
        return (
          <LensPage
            id={id}
            lensId={tab}
            scope={scope}
            projectName={p.name}
            stats={stats}
            onLoaded={refreshListing}
          />
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
          <IndexStrip id={id} project={p} snapshot={overview.snapshot} run={run} onRequested={() => void load()} />
          {noSnapshot && content !== "overview" ? (
            <FirstIndex name={p.name} run={run} running={run.running || p.status === "indexing"} />
          ) : content === "flow" ? (
            <div className="sh-stage sh-stage-flow">
              {error && <p className="error" role="alert">{error}</p>}
              <FlowView
                id={id}
                files={files}
                scope={flowScopeOf(tab, scope)}
                fn={fn}
                roots={roots}
                store={store}
                slot={slot}
                facts={facts}
                emphasis={tab === "overview"}
                findingKind={findingKind}
                codeOpen={codeShown}
              />
            </div>
          ) : (
            <div className="sh-stage sh-page">
              <div className="sh-page-head">
                <h1>{p.name}</h1>
                {content !== "overview" && <StatusBadge project={p} />}
              </div>
              {error && <p className="error" role="alert">{error}</p>}
              {listingError && (
                <p className="muted small" title={listingError}>
                  Lenses unavailable
                </p>
              )}
              {tab === "arch" ? null : PROJECT_WIDE.has(tab) ? (
                <p className="muted small scope-note">
                  This page covers the whole project, so the scope does not narrow it. Pick a file in the tree to see its flow and code.
                </p>
              ) : (
                <ScopeNote id={id} tab={tab} scope={scope} kind={kind} files={files} trail />
              )}
              <div key={viewKey}>{renderPage()}</div>
            </div>
          )}
        </section>
        <Splitter side="right" label="Resize the code pane" width={codeEff} shown={codeShown && !narrow} onResize={setCodeW} />
        <CodePane
          id={id}
          roots={roots}
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
