// The reverse references of the function the Flow panel shows: what calls or references it, and what it calls, across the
// whole project. Each list groups its rows into the functions in this scope and the ones outside it. A function row links
// to that function: in this scope the link keeps the scope, outside it the link switches the scope to the function's file.
import type { RefRow, Refs } from "@insight/model";
import { hrefFlow, hrefView } from "../../router";

/** What every part of the lists needs: the project, the scope the map shows (its rows inside it, the scope a link keeps), and roots-only. */
interface Base {
  id: string;
  scope: string;
  roots: boolean;
}

export function RefLists({ id, scope, roots, refs }: Base & { refs: Refs }) {
  return (
    <div className="ref-lists">
      <RefList id={id} scope={scope} roots={roots} title="Called by" rows={refs.calledBy} empty="Nothing in the project calls or references it." />
      <RefList id={id} scope={scope} roots={roots} title="Calls" rows={refs.calls} empty="It calls nothing." />
    </div>
  );
}

function RefList({ id, scope, roots, title, rows, empty }: Base & { title: string; rows: RefRow[]; empty: string }) {
  const inside = rows.filter((r) => r.inScope);
  const outside = rows.filter((r) => !r.inScope);
  return (
    <details className="ref-list" open>
      <summary>
        {title} ({rows.length})
      </summary>
      {rows.length === 0 ? (
        <p className="muted small">{empty}</p>
      ) : (
        <>
          {inside.length > 0 && <RefGroup id={id} scope={scope} roots={roots} label="In this scope" rows={inside} />}
          {outside.length > 0 && <RefGroup id={id} scope={scope} roots={roots} label="Outside this scope" rows={outside} />}
        </>
      )}
    </details>
  );
}

function RefGroup({ id, scope, roots, label, rows }: Base & { label: string; rows: RefRow[] }) {
  return (
    <section className="ref-group">
      <h4>
        {label} ({rows.length})
      </h4>
      <ul className="call-list">
        {rows.map((r) => (
          <li key={`${r.id}\0${r.kind}`}>
            <RefItem id={id} scope={scope} roots={roots} row={r} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function RefItem({ id, scope, roots, row }: Base & { row: RefRow }) {
  // A function opens in its scope, or in its file's scope when it lies outside this one. Module-level code (a file row) opens the file's flow.
  const href = row.isFunction
    ? hrefView(id, "flow", { scope: row.inScope ? scope : row.file, fn: row.id, ...(roots ? { roots } : {}) })
    : hrefFlow(id, row.file);
  return (
    <>
      <a href={href}>{row.name}</a>{" "}
      <span className="mono muted small">{row.line > 0 ? `${row.file}:${row.line}` : row.file}</span>
      {row.kind !== "call" && (
        <>
          {" "}
          <span className={`kind ${row.kind}`}>{row.kind}</span>
        </>
      )}
      {row.count > 1 && <span className="muted small"> ×{row.count}</span>}
      {row.candidate && <span className="muted small"> candidate</span>}
    </>
  );
}
