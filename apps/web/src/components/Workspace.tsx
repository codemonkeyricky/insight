import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { api, IS_DEMO, type FileEntry, type Overview, type ScopeLenses } from "../api";
import { contentOf, flowScopeOf, modeOf, showsFileSource, type ShellContent } from "./sheet/shell";
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
import { FilesDrawer } from "./sheet/FilesDrawer";
import { FindPalette } from "./sheet/FindPalette";
import type { LayerLink } from "./sheet/LayersPanel";
import { TopBar, type Crumb } from "./sheet/TopBar";
import type { TitleFacts } from "./sheet/TitleBlock";
import { shortCommit } from "./sheet/TitleBlock";
import { ArchView } from "./views/ArchView";
import { FindingsView } from "./views/FindingsView";
import { FlowView } from "./views/FlowView";
import { SourceView } from "./views/SourceView";

/** Tabs that cover the whole project. The explorer scope does not narrow them. */
const PROJECT_WIDE = new Set(["overview", "arch", "compare", "review"]);

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
}

interface Loaded {
  overview: Overview;
  files: FileEntry[];
}

const isEditable = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));

/**
 * One project in the sheet shell: a glass top bar over a full-height stage. The flow tabs and the overview's flow root draw the
 * sheet; the other tabs draw their page in the stage. Files and Find open as overlays, and the Layers list reaches every page.
 */
export function Workspace({ id, tab, scope, line, fn, roots = false, base, head, full = false }: WorkspaceProps) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [listing, setListing] = useState<ScopeLenses | null>(null);
  const [listingError, setListingError] = useState<string | null>(null);
  const [filesOpen, setFilesOpen] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  // Listings by snapshot and scope, so a scope the user has already opened is not asked for again.
  const listings = useRef(new Map<string, ScopeLenses>());

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

  // Ctrl/Cmd+K toggles Find, "/" opens it outside a text field, and Escape closes the Files drawer.
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

  if (redirect !== undefined) return null;
  if (!loaded) return error ? <p className="error" role="alert">{error}</p> : <p className="muted">Loading</p>;

  const { overview, files } = loaded;
  const p = overview.project;
  const sourceText = p.source.kind === "path" ? p.source.path : p.source.url;
  const kind = scopeKind(scope, files);
  const content: ShellContent = contentOf(tab, kind, full);
  const mode = modeOf(content);
  const lensTabs = listing ? tabbedLenses(listing.lenses).map((row) => lensTab(row, !IS_DEMO)) : [];
  // The banner's numbers belong to one scope. A listing for another scope is not shown while the new one loads.
  const stats = listing && listing.scope === canonicalScope(scope) ? listing.stats : null;
  // The explorer picks flow for the flow sheet, and source for the project-wide pages, so a picked file opens its flow or source.
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

  const modeLinks = {
    flow: hrefView(id, "flow", { scope: flowScopeOf(tab, scope) }),
    arch: hrefView(id, "arch"),
    findings: hrefView(id, "findings", { scope }),
  };

  const pageLink = (t: string, title: string, current: boolean, opts: { full?: boolean } = {}): LayerLink => ({
    id: t,
    title,
    href: hrefView(id, t, { scope, ...(opts.full ? { full: true } : {}) }),
    current,
    group: "page",
  });
  const layers: LayerLink[] = [
    pageLink("overview", "Overview", content === "overview", { full: true }),
    pageLink("source", "Source", content === "source"),
    pageLink("flow", "Flow", content === "flow" && tab !== "overview"),
    pageLink("arch", "Arch", content === "arch"),
    pageLink("findings", "Findings", content === "findings"),
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
    <>
      <TopBar
        crumbs={crumbs}
        mode={mode}
        modeLinks={modeLinks}
        findings={overview.findings.total}
        filesOpen={filesOpen}
        onFiles={() => setFilesOpen((o) => !o)}
        onFind={() => setFindOpen(true)}
      />
      {content === "flow" ? (
        <div className="sh-stage">
          {error && <p className="error" role="alert">{error}</p>}
          <FlowView
            id={id}
            files={files}
            scope={flowScopeOf(tab, scope)}
            fn={fn}
            roots={roots}
            line={line}
            layers={layers}
            facts={facts}
            emphasis={tab === "overview"}
            fileSource={showsFileSource(tab, kind)}
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
              This page covers the whole project, so the scope does not narrow it. Pick a file in the Files drawer to open its source.
            </p>
          ) : (
            <ScopeNote id={id} tab={tab} scope={scope} kind={kind} files={files} trail />
          )}
          <div key={viewKey}>{renderPage()}</div>
        </div>
      )}
      {filesOpen && (
        <FilesDrawer
          id={id}
          tab={explorerTab}
          fileTab={explorerTab}
          scope={scope}
          files={files}
          onClose={() => setFilesOpen(false)}
        />
      )}
      {findOpen && <FindPalette id={id} files={files} onClose={() => setFindOpen(false)} />}
    </>
  );
}
