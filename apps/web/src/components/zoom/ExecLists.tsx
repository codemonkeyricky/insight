// The lists the execution panels share: a function's name as a link to the placement it opens, a function's trail, its
// Calls and Called by lists, a container's pills, and the table of its functions. Each link calls `onOpen` with the
// placement's node id, so the map moves there; the href is the same URL for a middle click or a copy.
import { useMemo, useState, type ReactNode } from "react";
import { EXEC_PROJECT_ROOT } from "@insight/flow";
import { hrefView } from "../../router";
import {
  RUNTIME_WORD,
  sortExecRows,
  type ExecCallLists,
  type ExecChip,
  type ExecLink,
  type ExecLinkList,
  type ExecRow,
  type ExecSortKey,
} from "../../zoom/execMap";

/** What every list needs to link: the project, the scope the map shows, whether it is roots-only, and the opener. */
export interface ListBase {
  id: string;
  scope: string;
  roots: boolean;
  onOpen: (nodeId: string) => void;
}

/** A function's name as a link to the placement it opens. Without a placement, the text alone. */
function FnLink({
  base,
  fn,
  nodeId,
  className,
  children,
}: {
  base: ListBase;
  /** The function the link names. Undefined for a link to the project, which names no function. */
  fn?: string;
  nodeId?: string;
  className?: string;
  children: ReactNode;
}) {
  if (nodeId === undefined) return <span className={className}>{children}</span>;
  return (
    <a
      className={className}
      href={hrefView(base.id, "flow", { scope: base.scope, ...(fn !== undefined ? { fn } : {}), roots: base.roots })}
      onClick={(e) => {
        e.preventDefault();
        base.onOpen(nodeId);
      }}
    >
      {children}
    </a>
  );
}

/** The call path to the focused function: each step a link, the focused function last and in bold. */
export function ExecTrail({ base, steps }: { base: ListBase; steps: ExecLink[] }) {
  const last = steps.length - 1;
  return (
    <nav className="trail small" aria-label="Call path">
      {steps.map((s, i) => (
        <span key={`${i}:${s.id}`}>
          {i > 0 && <span className="sep"> › </span>}
          {i === last ? (
            <strong>{s.name}</strong>
          ) : (
            <FnLink base={base} fn={s.id === EXEC_PROJECT_ROOT ? undefined : s.id} nodeId={s.nodeId}>
              {s.name}
            </FnLink>
          )}
        </span>
      ))}
    </nav>
  );
}

/** The Calls and Called by lists of a function, side by side. */
export function CallLists({ base, lists }: { base: ListBase; lists: ExecCallLists }) {
  return (
    <section className="calls-grid" aria-label="Calls">
      <div>
        <h3>Calls</h3>
        <LinkList base={base} list={lists.calls} empty="Calls nothing in this scope." />
      </div>
      <div>
        <h3>Called by</h3>
        <LinkList base={base} list={lists.calledBy} empty="Nothing in this scope calls it." />
      </div>
    </section>
  );
}

function LinkList({ base, list, empty }: { base: ListBase; list: ExecLinkList; empty: string }) {
  if (list.items.length === 0) return <p className="muted small">{empty}</p>;
  return (
    <>
      <ul className="call-list">
        {list.items.map((l) => (
          <li key={l.id}>
            <FnLink base={base} fn={l.id} nodeId={l.nodeId}>
              {l.name}
            </FnLink>
            {l.nodeId === undefined && l.file !== "" && (
              <span className="muted small">
                {" "}
                in <span className="mono">{l.file}:{l.line}</span>
              </span>
            )}
          </li>
        ))}
      </ul>
      {list.more > 0 && <p className="muted small">and {list.more} more</p>}
    </>
  );
}

/** The pills of a container's functions, each a link to its placement in the container. */
export function ExecChips({ base, label, chips, more }: { base: ListBase; label: string; chips: ExecChip[]; more: number }) {
  return (
    <>
      <nav className="chips" aria-label={label}>
        {chips.map((c) => (
          <FnLink key={c.nodeId} base={base} className="chip" fn={c.id} nodeId={c.nodeId}>
            {c.name}
          </FnLink>
        ))}
      </nav>
      {more > 0 && <p className="muted small">and {more} more</p>}
    </>
  );
}

const COLUMNS: { key: ExecSortKey; label: string; flow: boolean }[] = [
  { key: "name", label: "Name", flow: false },
  { key: "location", label: "File:line", flow: false },
  { key: "runtime", label: "Runtime", flow: false },
  { key: "calls", label: "Calls", flow: false },
  { key: "calledBy", label: "Called by", flow: false },
  { key: "steps", label: "Steps", flow: true },
  { key: "decisions", label: "Decisions", flow: true },
  { key: "loops", label: "Loops", flow: true },
];

/**
 * The table of a container's functions. A header click sorts by its column (ascending first, then descending). The flow
 * columns show only when `flow` is set, which the panel does when the scope's flow lists the functions' counts.
 */
export function ExecTable({ base, rows, flow }: { base: ListBase; rows: ExecRow[]; flow: boolean }) {
  const [sort, setSort] = useState<{ key: ExecSortKey; dir: 1 | -1 }>();
  const shown = useMemo(() => (sort === undefined ? rows : sortExecRows(rows, sort.key, sort.dir)), [rows, sort]);
  const cols = COLUMNS.filter((c) => flow || !c.flow);
  return (
    <div className="exec-table-wrap">
      <table className="grid exec-table">
        <thead>
          <tr>
            {cols.map((c) => {
              const active = sort?.key === c.key ? sort : undefined;
              return (
                <th key={c.key} aria-sort={active === undefined ? undefined : active.dir === 1 ? "ascending" : "descending"}>
                  <button
                    type="button"
                    className="sort"
                    onClick={() => setSort(active === undefined ? { key: c.key, dir: 1 } : { key: c.key, dir: active.dir === 1 ? -1 : 1 })}
                  >
                    {c.label}
                    {active !== undefined && <span aria-hidden="true">{active.dir === 1 ? " ▲" : " ▼"}</span>}
                  </button>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {shown.map((r) => (
            <tr key={r.nodeId}>
              <td>
                <FnLink base={base} fn={r.id} nodeId={r.nodeId}>
                  {r.name}
                </FnLink>
              </td>
              <td className="break-any mono small">{r.file !== "" ? `${r.file}:${r.line}` : <span className="muted">no source</span>}</td>
              <td>{RUNTIME_WORD[r.runtime]}</td>
              <td>{r.calls}</td>
              <td>{r.calledBy}</td>
              {flow && <td>{r.steps ?? "—"}</td>}
              {flow && <td>{r.decisions ?? "—"}</td>}
              {flow && <td>{r.loops ?? "—"}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
