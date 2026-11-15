import type { PipelineSequence, PipelineStage } from "@insight/model";
import { hrefView } from "../../router";
import { SiteLinks } from "./SystemView";

const dirname = (file: string): string => (file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "");

/**
 * The sequence pipelines of the Pipeline view: each orchestrator's calls to the stages in other files, in call order, as a
 * strip of cards above the extension-point diagram. A stage name opens its function in Flow, as the other function links do.
 */
export function PipelineSequences({ id, sequences }: { id: string; sequences: PipelineSequence[] }) {
  if (sequences.length === 0) return null;
  return (
    <div className="pipe-seqs">
      {sequences.map((s) => (
        <section className="pipe-seq" key={s.id} aria-label={`Sequence ${s.name}`}>
          <div className="pipe-seq-head">
            <span className="small muted">
              Sequence · <span className="mono">{s.name}</span>
            </span>
            <span className="small muted mono">{s.file}</span>
          </div>
          <ol className="pipe-seq-strip">
            {[...s.stages].sort((a, b) => a.order - b.order).map((st) => (
              <StageCard key={st.fn} id={id} stage={st} />
            ))}
            {s.more > 0 && (
              <li className="pipe-seq-more small muted">+{s.more} more</li>
            )}
          </ol>
        </section>
      ))}
    </div>
  );
}

function StageCard({ id, stage }: { id: string; stage: PipelineStage }) {
  return (
    <li className="pipe-seq-card">
      <div className="pipe-seq-title">
        <span className="pipe-seq-n mono small muted">{stage.order + 1}</span>
        <a className="mono pipe-seq-name" href={hrefView(id, "flow", { scope: dirname(stage.file), fn: stage.fn, roots: true })} title={`Open ${stage.name} in Flow`}>
          {stage.name}
        </a>
      </div>
      <div className="small muted pipe-seq-where">{stage.component !== undefined ? `${stage.component} · ${stage.file}` : stage.file}</div>
      <SiteLinks id={id} sites={[stage.site]} />
    </li>
  );
}
