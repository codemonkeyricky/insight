// The code the right pane shows. Any tab can set it: a file picked in the tree (or reached by a link, such as a finding), or a
// function picked on the flow map. Workspace holds it, so the pane keeps what it shows when the tab changes.
import { createContext, useContext } from "react";
import type { MapSelection } from "./components/zoom/ZoomMap";

export type CodeTarget =
  | { kind: "file"; path: string; line?: number }
  | { kind: "function"; sel: MapSelection };

export interface CodeTargetValue {
  /** What the pane shows, or undefined before anything was picked. */
  target: CodeTarget | undefined;
  /** Shows `t` in the pane and opens the pane (or the Code drawer on a phone). */
  showCode: (t: CodeTarget) => void;
}

export const CodeTargetContext = createContext<CodeTargetValue>({ target: undefined, showCode: () => {} });

export const useCodeTarget = (): CodeTargetValue => useContext(CodeTargetContext);

/** A file target. A `line` of 0 or less is no line. */
export function fileTarget(path: string, line?: number): CodeTarget {
  return line !== undefined && line > 0 ? { kind: "file", path, line } : { kind: "file", path };
}

/** The file a target shows: the file itself, or the file of a function's definition ("" when the IR has none). */
export function targetPath(t: CodeTarget): string {
  return t.kind === "file" ? t.path : (t.sel.selected.file ?? "");
}

/**
 * The target a file scope sets on its own, so a file reached by a link or the Find palette shows its code too. A folder or
 * the project sets none, and the pane keeps what it shows.
 */
export function scopeCodeTarget(scope: string, isFile: boolean, line?: number): CodeTarget | undefined {
  return isFile && scope !== "" ? fileTarget(scope, line) : undefined;
}
