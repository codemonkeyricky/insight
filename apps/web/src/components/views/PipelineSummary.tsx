import type { PipelineModel } from "@insight/model";
import { pipelineRows } from "../../arch/pipeline-layout";

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/**
 * The summary under the Pipeline diagram when nothing is selected: the driver, the points in order with their members and
 * components, and what is not drawn. It sits below the stage, so it never covers a column.
 */
export function PipelineSummary({ pipeline }: { pipeline: PipelineModel }) {
  const rows = pipelineRows(pipeline);
  return (
    <section className="pipe-summary" aria-label="Pipeline">
      <div className="pipe-head">
        <h2>Pipeline</h2>
        {pipeline.driver !== undefined && (
          <span className="small muted">
            Driven by <span className="mono">{pipeline.driver.name}</span>
          </span>
        )}
        <span className="small muted">
          {plural(pipeline.omitted, "component")} not in the pipeline · {plural(pipeline.dropped, "extension point")} of other hosts
        </span>
      </div>
      {rows.length === 0 ? (
        <p className="small muted">No extension points.</p>
      ) : (
        <ol className="pipe-points">
          {rows.map((r) => (
            <li key={r.id}>
              <span className="mono small">{r.label}</span> <span className="muted small">{r.role}</span>
              <div className="small">
                {r.members !== "" && <span className="mono">{r.members}</span>}
                {r.members !== "" && " · "}
                {plural(r.components.length, "component")}
                {r.components.length > 0 && <span className="muted"> ({r.components.join(", ")})</span>}
              </div>
              {r.shownUnder !== undefined && <div className="small muted">shown under {r.shownUnder}</div>}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
