import { useEffect, useState } from "react";
import { ARCH_MODES, ARCH_MODE_LABELS, readArchMode, writeArchMode, type ArchMode } from "../../arch/mode";
import { ArchView } from "./ArchView";
import { PipelineView } from "./PipelineView";
import { SystemView } from "./SystemView";

/** The views of the Arch tab, as a segmented control. */
export function ArchModeToggle({ mode, onChange }: { mode: ArchMode; onChange: (m: ArchMode) => void }) {
  return (
    <div className="seg arch-mode" role="group" aria-label="Arch view">
      {ARCH_MODES.map((m) => (
        <button key={m} type="button" aria-pressed={mode === m} onClick={() => onChange(m)}>
          {ARCH_MODE_LABELS[m]}
        </button>
      ))}
    </div>
  );
}

/**
 * The Arch tab: System (the explorer scope's components, routes and outside systems), Pipeline (the processing stages of the scope's
 * extension points) or Packages (the package graph, which follows the explorer scope). System is the default, and the reader's
 * choice is kept in localStorage.
 */
export function ArchTab({ id, scope, initial, onSystemActive }: { id: string; scope: string; initial?: ArchMode; onSystemActive?: (on: boolean) => void }) {
  const [mode, setMode] = useState<ArchMode>(() => initial ?? readArchMode());
  // The workspace collapses its code pane while System is shown and no code is open.
  useEffect(() => {
    onSystemActive?.(mode !== "packages");
    return () => onSystemActive?.(false);
  }, [mode, onSystemActive]);
  const pick = (m: ArchMode) => {
    setMode(m);
    writeArchMode(m);
  };
  return (
    <div className="arch-tab">
      <ArchModeToggle mode={mode} onChange={pick} />
      {mode === "system" && <SystemView id={id} scope={scope} />}
      {mode === "pipeline" && <PipelineView id={id} scope={scope} />}
      {mode === "packages" && <ArchView id={id} scope={scope} />}
    </div>
  );
}
