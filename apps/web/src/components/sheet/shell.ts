// Which content a workspace route shows. Pure, so the router tests can check every old URL form lands on the right content
// without rendering anything.
import type { ScopeKind } from "../ScopeNote";
import type { LensTab } from "../../scopeLenses";
import { hrefView } from "../../router";
import type { LayerLink } from "./LayerTabs";

/** What the stage shows: the flow sheet, a page, or a lens page. */
export type ShellContent = "flow" | "overview" | "arch" | "compare" | "triage" | "lens";

/** The content a tab shows. Overview is the flow sheet unless `full`. Any tab id that is not a page is a lens. */
export function contentOf(tab: string, _kind: ScopeKind, full = false): ShellContent {
  switch (tab) {
    case "overview":
      return full ? "overview" : "flow";
    case "flow":
      return "flow";
    case "arch":
    case "compare":
      return tab;
    case "review":
      return "triage";
    default:
      return "lens";
  }
}

export interface LayersInput {
  id: string;
  tab: string;
  scope: string;
  content: ShellContent;
  /** The static demo and the hosted build have no server: no Compare or Triage tab. */
  noServer: boolean;
  lenses: LensTab[];
}

/**
 * The tabs of the centre pane, in order: Overview, Flow, Arch, then (with a server) Compare and Triage, then one tab per lens
 * in the order given. A lens's tab is its id, so `view/<lens id>` opens it and a link to it round-trips.
 */
export function layerLinks({ id, tab, scope, content, noServer, lenses }: LayersInput): LayerLink[] {
  const page = (t: string, title: string, current: boolean, full = false): LayerLink => ({
    id: t,
    title,
    href: hrefView(id, t, { scope, ...(full ? { full: true } : {}) }),
    current,
    group: "page",
  });
  return [
    // Overview is current on the overview route, whether it shows the flow root or the full page. Flow is the flow tab otherwise.
    page("overview", "Overview", tab === "overview", true),
    page("flow", "Flow", content === "flow" && tab !== "overview"),
    page("arch", "Arch", content === "arch"),
    ...(noServer ? [] : [page("compare", "Compare", content === "compare"), page("review", "Triage", content === "triage")]),
    ...lenses.map(
      (t): LayerLink => ({
        id: t.id,
        title: t.title,
        href: hrefView(id, t.id, { scope }),
        current: t.id === tab,
        group: "lens",
        ...(t.dim ? { dim: true } : {}),
        ...(t.reason ? { reason: t.reason } : {}),
      }),
    ),
  ];
}

/** The overview tab is the flow root, so it always charts the whole project. Other tabs keep their scope. */
export const flowScopeOf = (tab: string, scope: string): string => (tab === "overview" ? "" : scope);

