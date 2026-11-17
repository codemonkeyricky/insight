// Which content a workspace route shows and which tabs the tab bar lists. Pure, so the router tests can check the tab bar and
// the old URL forms without rendering anything.
import { hrefView } from "../../router";
import type { LayerLink } from "./LayerTabs";

/** What the stage shows: the flow sheet, the Symbols chain, System, the Pipeline page or the Packages page. */
export type ShellContent = "flow" | "symbols" | "system" | "pipeline" | "packages";

/** The content a tab shows. Only the five tabs have content; any other id is redirected before it gets here (see redirectFor). */
export function contentOf(tab: string): ShellContent {
  switch (tab) {
    case "symbols":
    case "system":
    case "pipeline":
    case "packages":
      return tab;
    default:
      return "flow";
  }
}

/** The tabs of the tab bar, in order: Flow, Symbols, System, Pipeline, Packages. Each keeps the scope, so the tabs stay on the same folder or file. */
export function layerLinks({ id, tab, scope }: { id: string; tab: string; scope: string }): LayerLink[] {
  const page = (t: string, title: string): LayerLink => ({
    id: t,
    title,
    href: hrefView(id, t, { scope }),
    current: tab === t,
  });
  return [
    page("flow", "Flow"),
    page("symbols", "Symbols"),
    page("system", "System"),
    page("pipeline", "Pipeline"),
    page("packages", "Packages"),
  ];
}
