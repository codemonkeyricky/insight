import { useEffect } from "react";

/**
 * Tells the workspace that a tab is shown while the component using this hook is mounted. The workspace collapses its code
 * pane while such a tab is shown and no code is open, and restores it on leaving.
 */
export function useCodePaneCollapse(onSystemActive?: (on: boolean) => void): void {
  useEffect(() => {
    onSystemActive?.(true);
    return () => onSystemActive?.(false);
  }, [onSystemActive]);
}
