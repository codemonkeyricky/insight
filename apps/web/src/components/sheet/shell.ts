// Which content a workspace route shows. Pure, so the router tests can check every old URL form lands on the right content
// without rendering anything.
import type { ScopeKind } from "../ScopeNote";

/** What the stage shows: the flow sheet, a page, or a lens page. */
export type ShellContent = "flow" | "overview" | "source" | "arch" | "findings" | "compare" | "triage" | "lens";

/** The content a tab shows. `overview` and `source` on a file are the flow sheet; `source` on a folder is its listing page. */
export function contentOf(tab: string, kind: ScopeKind, full = false): ShellContent {
  switch (tab) {
    case "overview":
      return full ? "overview" : "flow";
    case "flow":
      return "flow";
    case "source":
      return kind === "file" ? "flow" : "source";
    case "arch":
    case "findings":
    case "compare":
      return tab;
    case "review":
      return "triage";
    default:
      return "lens";
  }
}

/** The overview tab is the flow root, so it always charts the whole project. Other tabs keep their scope. */
export const flowScopeOf = (tab: string, scope: string): string => (tab === "overview" ? "" : scope);

