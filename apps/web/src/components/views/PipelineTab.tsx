import { useState } from "react";
import { PipelineView } from "./PipelineView";
import { StagesView } from "./StagesView";

/**
 * The Pipeline tab: the processing stages of the scope's extension points (Stages), then the pipeline view. The Show tests setting
 * is shared by both, so they draw the same test folders or neither does. The workspace collapses its code pane while this tab is
 * shown and no code is open (see Workspace).
 */
export function PipelineTab({ id, scope }: { id: string; scope: string }) {
  const [tests, setTests] = useState(false);
  return (
    <div className="pipeline-tab">
      <StagesView id={id} scope={scope} tests={tests} onTests={setTests} />
      <PipelineView id={id} scope={scope} tests={tests} onTests={setTests} />
    </div>
  );
}
