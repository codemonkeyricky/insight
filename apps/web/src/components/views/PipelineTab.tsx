import { useState } from "react";
import { PipelineView } from "./PipelineView";
import { StagesView } from "./StagesView";
import { useCodePaneCollapse } from "./useCodePaneCollapse";

/**
 * The Pipeline tab: the processing stages of the scope's extension points (Stages), then the pipeline view. The Show tests setting
 * is shared by both, so they draw the same test folders or neither does. The workspace collapses its code pane while this tab is
 * shown and no code is open, and restores it on leaving (the same as the System tab).
 */
export function PipelineTab({ id, scope, onSystemActive }: { id: string; scope: string; onSystemActive?: (on: boolean) => void }) {
  useCodePaneCollapse(onSystemActive);
  const [tests, setTests] = useState(false);
  return (
    <div className="pipeline-tab">
      <StagesView id={id} scope={scope} tests={tests} onTests={setTests} />
      <PipelineView id={id} scope={scope} tests={tests} onTests={setTests} />
    </div>
  );
}
