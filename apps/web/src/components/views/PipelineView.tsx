import { useEffect, useMemo, useState } from "react";
import type { PipelineModel } from "@insight/model";
import { api } from "../../api";
import { pipelineSystem } from "../../arch/pipeline-layout";
import { SystemDiagram, plural } from "./SystemView";
import { PipelineSequences } from "./PipelineSequences";

/**
 * The Pipeline view of the explorer scope: the processing stages of its extension points, drawn with the System view's diagram.
 * The model is computed in the page from the project model (api.getPipeline), like the System view's. The Show tests setting is
 * owned by the parent (PipelineTab), which it shares with the Stages view.
 */
export function PipelineView({ id, scope, tests, onTests }: { id: string; scope: string; tests: boolean; onTests: (on: boolean) => void }) {
  const [done, setDone] = useState<{ key: string; pipeline?: PipelineModel; error?: string } | null>(null);
  const key = `${id}\0${scope}\0${tests}`;
  useEffect(() => {
    let cancelled = false;
    api.getPipeline(id, scope, { tests }).then(
      (pipeline) => {
        if (!cancelled) setDone({ key, pipeline });
      },
      (e: unknown) => {
        if (!cancelled) setDone({ key, error: e instanceof Error ? e.message : String(e) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [id, scope, tests, key]);
  if (done === null) return <p className="muted">Loading</p>;
  if (done.pipeline === undefined) return <p className="error" role="alert">{done.error}</p>;
  return <PipelineDiagram id={id} pipeline={done.pipeline} tests={tests} onTests={onTests} stale={done.key !== key} />;
}

/** The diagram of one Pipeline model: its System-shaped layout with the column titles, and the Pipeline side panel. */
export function PipelineDiagram({ id, pipeline, tests, onTests, stale = false }: { id: string; pipeline: PipelineModel; tests: boolean; onTests: (on: boolean) => void; stale?: boolean }) {
  const { sys, layout } = useMemo(() => pipelineSystem(pipeline), [pipeline]);
  // Sequences without extension points: the strip is the whole view (no "no extension points" empty state), under the same
  // scope label and Show tests toggle as the diagram's toolbar, so tests can be turned off again from here.
  if (pipeline.points.length === 0 && pipeline.sequences.length > 0)
    return (
      <div className="sysv">
        <div className="sysv-bar">
          <span className="muted small sysv-counts">{plural(pipeline.sequences.length, "sequence")}</span>
          <span className="muted small sysv-scope">
            Scope <span className="mono">{sys.scope === "" ? "(project)" : sys.scope}</span>
          </span>
          <label className="sysv-tests small">
            <input type="checkbox" checked={tests} onChange={(e) => onTests(e.target.checked)} /> Show tests
          </label>
        </div>
        <PipelineSequences id={id} sequences={pipeline.sequences} stale={stale} />
      </div>
    );
  return (
    <>
      <PipelineSequences id={id} sequences={pipeline.sequences} capped stale={stale} />
      <SystemDiagram id={id} sys={sys} layoutOptions={layout} pipeline={pipeline} tests={tests} onTests={onTests} stale={stale} />
    </>
  );
}
