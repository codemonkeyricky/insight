import type { PipelineSequence, PipelineStage } from "@insight/model";
import { hrefView } from "../../router";
import { SiteLinks, dirname } from "./SystemView";

/**
 * The sequence pipelines of the Pipeline view: each orchestrator's calls to the stages in other files, in call order, as a
 * strip of cards. The orchestrator and each stage name open their function in Flow, as the other function links do; a card's
 * call site opens the orchestrator's code at that call. `capped` bounds the strip's height when the diagram follows it, and
 * `stale` dims it while the next scope loads.
 */
export function PipelineSequences({ id, sequences, capped = false, stale = false }: { id: string; sequences: PipelineSequence[]; capped?: boolean; stale?: boolean }) {
  if (sequences.length === 0) return null;
  return (
    <div className={`pipe-seqs${capped ? " capped" : ""}${stale ? " stale" : ""}`}>
      {sequences.map((s) => {
        const head = `pipe-seq-${s.id}`;
        return (
          <div className="pipe-seq" key={s.id} role="group" aria-labelledby={head}>
            <div className="pipe-seq-head">
              <h3 className="pipe-seq-h small muted" id={head}>
                Sequence ·{" "}
                <a className="mono" href={hrefView(id, "flow", { scope: dirname(s.file), fn: s.id })} title={`Open ${s.name} in Flow`}>
                  {s.name}
                </a>
              </h3>
              <span className="small muted mono">{s.file}</span>
            </div>
            {/* role="list": list-style:none drops the list semantics in Safari. Stages come from the model in order. */}
            <ol className="pipe-seq-strip" role="list">
              {s.stages.map((st) => (
                <StageCard key={st.fn} id={id} stage={st} />
              ))}
              {s.more > 0 && <li className="pipe-seq-more small muted">+{s.more} more</li>}
            </ol>
          </div>
        );
      })}
    </div>
  );
}

function StageCard({ id, stage }: { id: string; stage: PipelineStage }) {
  return (
    <li className="pipe-seq-card">
      <div className="pipe-seq-title">
        <span className="pipe-seq-n mono small muted">{stage.order + 1}</span>
        <a className="mono pipe-seq-name" href={hrefView(id, "flow", { scope: dirname(stage.file), fn: stage.fn })} title={`Open ${stage.name} in Flow`}>
          {stage.name}
        </a>
      </div>
      <div className="small muted pipe-seq-where">{stage.component !== undefined ? `${stage.component} · ${stage.file}` : stage.file}</div>
      {/* The call site only: its function is the orchestrator, linked once in the header. */}
      {stage.site.line > 0 && <SiteLinks id={id} sites={[{ file: stage.site.file, line: stage.site.line }]} />}
    </li>
  );
}
