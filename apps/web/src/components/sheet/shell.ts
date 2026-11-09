// Which content a workspace route shows, and which sheet mode it belongs to. Pure, so the router tests can check every
// old URL form lands on the right content without rendering anything.
import type { ScopeKind } from "../ScopeNote";

/** The three modes in the top bar's segmented control. A route with none of them (a lens page, Compare, Triage) has no mode. */
export type ShellMode = "flow" | "arch" | "findings";

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

/** The mode a content belongs to, for the mode switch. */
export function modeOf(content: ShellContent): ShellMode | undefined {
  if (content === "flow") return "flow";
  if (content === "arch") return "arch";
  if (content === "findings") return "findings";
  return undefined;
}

/** The overview tab is the flow root, so it always charts the whole project. Other tabs keep their scope. */
export const flowScopeOf = (tab: string, scope: string): string => (tab === "overview" ? "" : scope);

/** True when the side panel shows the source of the scope file (the source tab on a file, with nothing picked on the map). */
export const showsFileSource = (tab: string, kind: ScopeKind): boolean => tab === "source" && kind === "file";
