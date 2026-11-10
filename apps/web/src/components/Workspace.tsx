import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { api, IS_DEMO, type FileEntry, type Overview, type ScopeLenses } from "../api";
import { CodeTargetContext, scopeCodeTarget, type CodeTarget, type CodeTargetValue } from "../codeTarget";
import { contentOf, flowScopeOf, type ShellContent } from "./sheet/shell";
import { hrefView, redirectFor } from "../router";
import { canonicalScope } from "../scopeKey";
import { lensTab, tabbedLenses } from "../scopeLenses";
import { ComparePage } from "../pages/Compare";
import { LensPage } from "../pages/LensPage";
import { ProjectOverview } from "../pages/ProjectOverview";
import { ReviewPage } from "../pages/Review";
import { StatusBadge } from "../pages/Projects";
import { useProjectEvents, type RunEvent } from "../useEvents";
import { ScopeNote, scopeKind } from "./ScopeNote";
import { CodePane } from "./sheet/CodePane";
import { FileTree } from "./sheet/FileTree";
import { FindPalette } from "./sheet/FindPalette";
import { LayerTabs, type LayerLink } from "./sheet/LayerTabs";
import { isNarrow, CODE_KEY, TREE_KEY, useNarrow, usePaneWidth } from "./sheet/panes";
import { Splitter } from "./sheet/Splitter";
import { TopBar, type Crumb } from "./sheet/TopBar";
import type { TitleFacts } from "./sheet/TitleBlock";
import { shortCommit } from "./sheet/TitleBlock";
import { ArchView } from "./views/ArchView";
import { FindingsView } from "./views/FindingsView";
import { FlowView } from "./views/FlowView";
import { SourceView } from "./views/SourceView";
import { ZoomStore } from "../zoom/scene";

/** Tabs that cover the whole project. The explorer scope does not narrow them. */
const PROJECT_WIDE = new Set(["overview", "arch", "compare", "review"]);

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

  // A retired lens tab (the execution lens) is the flow tab now, so its link is replaced by the flow tab's.
  const redirect = redirectFor({ name: "workspace", id, tab, scope });
  useEffect(() => {
    if (redirect !== undefined) window.location.replace(redirect);
  }, [redirect]);

  useProjectEvents(id, (event: RunEvent) => {
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
  // sets nothing, so the pane keeps the code it shows. The line rides along for a link to a line.
  const fileScope = loaded !== null && scopeKind(scope, loaded.files) === "file";
  useEffect(() => {
    const next = scopeCodeTarget(scope, fileScope, line);
    if (next !== undefined) setTarget(next);
  }, [scope, fileScope, line]);

  if (redirect !== undefined) return null;
  if (!loaded) return error ? <p className="error" role="alert">{error}</p> : <p className="muted">Loading</p>;

  const { overview, files } = loaded;
  const p = overview.project;
  const sourceText = p.source.kind === "path" ? p.source.path : p.source.url;
  const kind = scopeKind(scope, files);
  const content: ShellContent = contentOf(tab, kind, full);
  const lensTabs = listing ? tabbedLenses(listing.lenses).map((row) => lensTab(row, !IS_DEMO)) : [];
  // The banner's numbers belong to one scope. A listing for another scope is not shown while the new one loads.
  const stats = listing && listing.scope === canonicalScope(scope) ? listing.stats : null;
  // The tree picks flow for the flow view, and source for the project-wide pages, so a picked file opens its flow or source.
  const explorerTab = content === "flow" ? "flow" : PROJECT_WIDE.has(tab) ? "source" : tab;
  // Views remount when the snapshot, view or scope changes, so no state from the last one carries over. The flow map
  // follows the scope and function in place, so a scope change animates the camera rather than remounting the map.
  const viewKey = `${overview.snapshot?.id ?? "none"}|${content}|${content === "flow" || tab === "arch" ? "" : scope}|${base ?? ""}|${head ?? ""}|${full}`;

  const parts = scope ? scope.split("/") : [];
  const crumbTab = content === "flow" ? "flow" : content === "findings" || content === "arch" ? content : "source";
  const crumbs: Crumb[] = [
    { label: p.name, href: hrefView(id, "overview"), current: parts.length === 0 },
    ...parts.map((seg, i): Crumb => {
      const path = parts.slice(0, i + 1).join("/");
      return { label: seg, href: hrefView(id, crumbTab, { scope: path }), current: i === parts.length - 1 };
    }),
  ];

  const pageLink = (t: string, title: string, current: boolean, opts: { full?: boolean } = {}): LayerLink => ({
    id: t,
    title,
    href: hrefView(id, t, { scope, ...(opts.full ? { full: true } : {}) }),
    current,
    group: "page",
  });
  // The Overview tab is current on the overview route, whether it shows the flow root or the full page. Flow is the flow tab
  // on any other route.
  const layers: LayerLink[] = [
    pageLink("overview", "Overview", tab === "overview", { full: true }),
    pageLink("source", "Source", content === "source"),
    pageLink("flow", "Flow", content === "flow" && tab !== "overview"),
    pageLink("arch", "Arch", content === "arch"),
    { ...pageLink("findings", "Findings", content === "findings"), count: overview.findings.total },
    ...(IS_DEMO ? [] : [pageLink("compare", "Compare", content === "compare"), pageLink("review", "Triage", content === "triage")]),
    ...lensTabs.map((t): LayerLink => ({
      id: t.id,
      title: t.title,
      href: hrefView(id, t.id, { scope }),
      current: t.id === tab,
      group: "lens",
      ...(t.dim ? { dim: true } : {}),
      ...(t.reason ? { reason: t.reason } : {}),
    })),
  ];

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
  const bodyStyle = {
    "--tree-col": `${treeShown ? treeW : 0}px`,
    "--split-l": treeShown ? "1px" : "0px",
    "--code-col": `${codeShown ? codeW : 0}px`,
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
      setCodeCollapsed(!codeCollapsed);
    }
  };

  const renderPage = (): ReactNode => {
    switch (content) {
      case "overview":
        return <ProjectOverview id={id} />;
      case "source":
        return <SourceView id={id} files={files} scope={scope} line={line} />;
      case "arch":
        return <ArchView id={id} />;
      case "findings":
        return <FindingsView id={id} scope={scope} />;
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
        <Splitter side="left" label="Resize the files pane" width={treeW} shown={treeShown && !narrow} onResize={setTreeW} />
        <section className="sh-center">
          <LayerTabs links={layers} />
          {content === "flow" ? (
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
                <StatusBadge project={p} />
              </div>
              {error && <p className="error" role="alert">{error}</p>}
              {listingError && (
                <p className="muted small" title={listingError}>
                  Lenses unavailable
                </p>
              )}
              {PROJECT_WIDE.has(tab) ? (
                <p className="muted small scope-note">
                  This page covers the whole project, so the scope does not narrow it. Pick a file in the tree to open its source.
                </p>
              ) : (
                <ScopeNote id={id} tab={tab} scope={scope} kind={kind} files={files} trail />
              )}
              <div key={viewKey}>{renderPage()}</div>
            </div>
          )}
        </section>
        <Splitter side="right" label="Resize the code pane" width={codeW} shown={codeShown && !narrow} onResize={setCodeW} />
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
