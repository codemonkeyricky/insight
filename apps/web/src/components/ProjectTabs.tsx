import { useEffect, useState } from "react";
import { api, IS_DEMO, type LensSummary } from "../api";
import { hrefCompare, hrefFile, hrefLens, hrefProject, hrefReview } from "../router";

export type TabId = "overview" | "files" | "compare" | "review" | { lens: string };

/** Lenses that answer "what runs" come first; the rest keep the order the server gives. */
const FIRST = ["lens-execution"];
const lensOrder = (lenses: LensSummary[]) =>
  [...lenses].sort((a, b) => {
    const ia = FIRST.indexOf(a.id);
    const ib = FIRST.indexOf(b.id);
    return (ia === -1 ? FIRST.length : ia) - (ib === -1 ? FIRST.length : ib);
  });

const known = new Map<string, LensSummary[]>();

/** The tab bar shared by every project page: Overview, Files, then one tab per lens. */
export function ProjectTabs({ id, active }: { id: string; active: TabId }) {
  const [lenses, setLenses] = useState<LensSummary[]>(known.get(id) ?? []);
  useEffect(() => {
    let cancelled = false;
    api
      .overview(id)
      .then((o) => {
        known.set(id, o.lenses);
        if (!cancelled) setLenses(o.lenses);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [id]);

  const tab = (key: string, label: string, href: string, on: boolean, title?: string) => (
    <a key={key} href={href} className={on ? "tab on" : "tab"} role="tab" aria-selected={on} title={title}>
      {label}
    </a>
  );
  return (
    <nav className="tabs" role="tablist" aria-label="Project views">
      {tab("overview", "Overview", hrefProject(id), active === "overview")}
      {tab("files", "Files", hrefFile(id), active === "files")}
      {!IS_DEMO && tab("compare", "Compare", hrefCompare(id), active === "compare")}
      {!IS_DEMO && tab("review", "Review", hrefReview(id), active === "review")}
      <span className="tab-sep" aria-hidden="true" />
      {lensOrder(lenses)
        .filter((l) => l.status === "ok")
        .map((l) => tab(l.id, l.title, hrefLens(id, l.id), typeof active === "object" && active.lens === l.id))}
    </nav>
  );
}
