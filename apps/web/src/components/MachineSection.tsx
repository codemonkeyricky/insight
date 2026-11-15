import type { ReactElement } from "react";
import type { Span, StateMachineTransition, StateMachineView } from "../api";

/** Holder, then states and transitions: one button per machine, the selected one marked. */
export function MachineList({
  machines,
  selectedId,
  onSelect,
}: {
  machines: readonly StateMachineView[];
  selectedId: string;
  onSelect: (holderId: string) => void;
}): ReactElement {
  return (
    <ul className="sm-list" aria-label="State machines">
      {machines.map((m) => (
        <li key={m.id}>
          <button type="button" aria-current={m.holder.id === selectedId ? "true" : "false"} onClick={() => onSelect(m.holder.id)}>
            <span className="sm-holder mono">{m.holder.name}</span>
            <span className="muted small">
              {m.states.filter((s) => s.kind !== "initial" && s.kind !== "any").length} states · {m.transitions.length} transitions
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Every site of one transition: function, file:line link, guard and confidence. */
export function SiteList({
  view,
  transition,
  onShow,
}: {
  view: StateMachineView;
  transition: StateMachineTransition;
  onShow: (span: Span, label: string) => void;
}): ReactElement {
  const name = (id: string) => view.states.find((s) => s.id === id)?.label ?? id;
  const title = `${name(transition.from)} → ${name(transition.to)}${transition.label ? ` (${transition.label})` : ""}`;
  return (
    <div className="sm-site-block">
      <h4>{title}</h4>
      {transition.sites.length === 0 ? (
        <p className="muted small">No source line is recorded for this transition.</p>
      ) : (
        <ul className="sm-sites">
          {transition.sites.map((s, i) => (
            <li key={i}>
              <div>
                {s.fn && <span className="mono">{s.fn}</span>}
                {s.fn && s.span && " · "}
                {s.span && (
                  <button type="button" className="link" onClick={() => onShow(s.span as Span, `${title} in ${s.fn ?? s.span?.file}`)}>
                    {s.span.file}:{s.span.start[0] + 1}
                  </button>
                )}
              </div>
              <div className="muted small">
                {s.guard ? `guard: ${s.guard}` : "no guard"} · {s.confidence ?? transition.confidence}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
