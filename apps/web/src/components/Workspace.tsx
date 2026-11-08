import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { api, IS_DEMO, type FileEntry, type Overview, type ScopeLenses } from "../api";
import { hrefView, redirectFor } from "../router";
import { canonicalScope } from "../scopeKey";
import { lensTab, tabbedLenses } from "../scopeLenses";
import { ComparePage } from "../pages/Compare";
import { LensPage } from "../pages/LensPage";
import { ProjectOverview } from "../pages/ProjectOverview";
import { ReviewPage } from "../pages/Review";
import { StatusBadge } from "../pages/Projects";
import { useProjectEvents, type RunEvent } from "../useEvents";
import { Explorer } from "./Explorer";
import { ScopeNote, scopeKind } from "./ScopeNote";
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
}

interface Loaded {
  overview: Overview;
  files: FileEntry[];
}

/**
 * One project: the source explorer on the left, and on the right the view the tab names. The lens
 * tabs are the lenses of the explorer scope, from the scope listing.
 */
export function Workspace({ id, tab, scope, line, fn, roots = false, base, head }: WorkspaceProps) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [listing, setListing] = useState<ScopeLenses | null>(null);
  const [listingError, setListingError] = useState<string | null>(null);
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
  const lensTabs = listing ? tabbedLenses(listing.lenses).map((row) => lensTab(row, !IS_DEMO)) : [];
  // The banner's numbers belong to one scope. A listing for another scope is not shown while the new one loads.
  const stats = listing && listing.scope === canonicalScope(scope) ? listing.stats : null;
  // A project-wide tab has no source of its own, so picking a file in the explorer shows that file's source.
  const explorerTab = PROJECT_WIDE.has(tab) ? "source" : tab;
  // Views remount when the snapshot, view or scope changes, so no state from the last one carries over. The flow map
  // follows the scope and function in place, so a scope change animates the camera rather than remounting the map.
  const viewKey = `${overview.snapshot?.id ?? "none"}|${tab}|${tab === "flow" || tab === "arch" ? "" : scope}|${base ?? ""}|${head ?? ""}`;

  const tabLink = (t: string, label: string) => (
    <a key={t} href={hrefView(id, t, { scope })} className={t === tab ? "tab on" : "tab"} role="tab" aria-selected={t === tab}>
      {label}
    </a>
  );

  const renderView = (): ReactNode => {
    switch (tab) {
      case "overview":
        return <ProjectOverview id={id} />;
      case "source":
        return <SourceView id={id} files={files} scope={scope} line={line} />;
      case "flow":
        return <FlowView id={id} files={files} scope={scope} fn={fn} roots={roots} />;
      case "arch":
        return <ArchView id={id} />;
      case "findings":
        return <FindingsView id={id} scope={scope} />;
      case "compare":
        return <ComparePage id={id} base={base} head={head} />;
      case "review":
        return <ReviewPage id={id} />;
      default:
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
    }
  };

  return (
    <section>
      <div className="head">
        <div>
          <h1>{p.name}</h1>
          <div className="mono muted small">{sourceText}</div>
        </div>
        <StatusBadge project={p} />
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      <nav className="tabs" role="tablist" aria-label="Project views">
        {tabLink("overview", "Overview")}
        {tabLink("source", "Source")}
        {tabLink("flow", "Flow")}
        {tabLink("arch", "Arch")}
        {tabLink("findings", "Findings")}
        {lensTabs.length > 0 && <span className="tab-sep" aria-hidden="true" />}
        {lensTabs.map((t) => (
          <a
            key={t.id}
            href={hrefView(id, t.id, { scope })}
            className={`${t.id === tab ? "tab on" : "tab"}${t.dim ? " dim" : ""}`}
            role="tab"
            aria-selected={t.id === tab}
            title={t.reason}
          >
            {t.title}
          </a>
        ))}
        {listingError && (
          <span className="muted small" title={listingError}>
            Lenses unavailable
          </span>
        )}
        {!IS_DEMO && <span className="tab-sep" aria-hidden="true" />}
        {!IS_DEMO && tabLink("compare", "Compare")}
        {!IS_DEMO && tabLink("review", "Triage")}
      </nav>
      <div className="ws">
        <Explorer id={id} tab={explorerTab} scope={scope} files={files} />
        <div className="ws-main">
          {PROJECT_WIDE.has(tab) ? (
            <p className="muted small scope-note">
              This tab covers the whole project, so the explorer scope does not narrow it. Picking a file or folder in the explorer opens it in Source.
            </p>
          ) : (
            // The zoom map draws its own trail, so the flow tab leaves the explorer trail out.
            <ScopeNote id={id} tab={tab} scope={scope} kind={kind} files={files} trail={tab !== "flow"} />
          )}
          <div key={viewKey}>{renderView()}</div>
        </div>
      </div>
    </section>
  );
}
