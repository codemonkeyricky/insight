import type { FunctionFlow } from "@insight/flow";
import { outsideSteps, type OutsideStep } from "../../flowTargets";
import { hrefFile, hrefView } from "../../router";

/**
 * The stats of a function's chart, the calls in it that leave the scope, and the chart's legend. The chart is drawn
 * in the function's expansion beside the map (Expansion.tsx), and the function's name and source line are the heading of the
 * panel that holds this.
 */
export function FunctionDetail({ id, fn, scope }: { id: string; fn: FunctionFlow; scope: string }) {
  const s = fn.stats;
  const steps = outsideSteps(fn, scope);
  return (
    <div className="exec-chart-detail">
      <div className="stats">
        <Stat label="Steps" value={s.steps} />
        <Stat label="Decisions" value={s.decisions} />
        <Stat label="Loops" value={s.loops} />
        <Stat label="Try blocks" value={s.tries} />
        <Stat label="Exits" value={s.exits} />
        <Stat label="Depth" value={s.depth} />
      </div>
      {fn.tooLarge ? (
        <p className="muted">This function has too many steps to chart. Its source is still one click away.</p>
      ) : fn.nodes.length === 0 ? (
        <p className="muted">No steps to chart.</p>
      ) : null}
      {steps.length > 0 && <OutsideList id={id} steps={steps} />}
      <ChartLegend />
    </div>
  );
}

/** The calls in a chart that name a function outside this scope, each with the scope that resolves it. */
function OutsideList({ id, steps }: { id: string; steps: OutsideStep[] }) {
  return (
    <section className="outside-list" aria-label="Calls outside this scope">
      <h3>Calls outside this scope</h3>
      <ul>
        {steps.map((s) => (
          <li key={s.node.id}>
            calls <code>{s.name}</code> in <span className="mono">{s.file}</span> — outside this scope.{" "}
            <a href={hrefView(id, "flow", { scope: s.scope, fn: s.target })} title={`Resolved in ${s.scope || "the project"}`}>
              Select a parent folder to resolve it.
            </a>
            {s.node.span && (
              <>
                {" "}
                <a className="small" href={hrefFile(id, s.node.span.file, s.node.span.start[0] + 1)}>
                  Line {s.node.span.start[0] + 1}
                </a>
              </>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function ChartLegend() {
  return (
    <div className="legend">
      <p className="muted small">
        Rounded: start or end. Box: step. Diamond: decision. Hexagon: loop. Dot: join. Red outline: return, throw, break or continue.
        Dashed box: await or spawn. Green arrow: true. Amber arrow: false. Dashed arrow: loop back. A call into this scope opens the
        function it calls. Click any other step to see its line.
      </p>
      <ul className="legend-keys small" aria-label="Legend">
        <li>
          <span className="key key-resolves" aria-hidden="true" />
          Call into this scope
        </li>
        <li>
          <span className="key key-unresolved" aria-hidden="true" />
          ↗ Unresolved: calls a function outside this scope
        </li>
      </ul>
    </div>
  );
}

export function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="stat">
      <div className="muted small">{label}</div>
      <div className="value">{value}</div>
    </div>
  );
}
