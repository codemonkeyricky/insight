// The reverse references of the function the Flow panel shows: what calls or references it, and what it calls, across the
// whole project. Each list groups its rows into the functions in this scope and the ones outside it. A function row links
// to that function: in this scope the link keeps the scope, outside it the link switches the scope to the function's file.
// The side panel pins these lists above the scrolling source, so they stay in view while the source scrolls.
import { useEffect, useState } from "react";
import type { RefRow, Refs } from "@insight/model";
import { api } from "../../api";
import { hrefFlow, hrefView } from "../../router";
import type { MapSelection } from "./ZoomMap";

/** What every part of the lists needs: the project, the scope the map shows (its rows inside it, the scope a link keeps), and roots-only. */
interface Base {
  id: string;
  scope: string;
  roots: boolean;
}

/** The references of the selected function, fetched for its scope, with the loading and error states the panel shows. */
export function FunctionRefs({ id, sel, roots }: { id: string; sel: MapSelection; roots: boolean }) {
  const { selected } = sel;
  const scope = sel.build.path;
  const [refState, setRefState] = useState<{ key: string; refs?: Refs; error?: string }>();
  const refKey = `${id}\0${scope}\0${selected.ref}`;
  useEffect(() => {
    let cancelled = false;
    const key = `${id}\0${scope}\0${selected.ref}`;
    api.getRefs(id, scope, selected.ref).then(
      (refs) => {
        if (!cancelled) setRefState({ key, refs });
      },
      (e: unknown) => {
        if (!cancelled) setRefState({ key, error: e instanceof Error ? e.message : String(e) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [id, scope, selected.ref]);
  const shown = refState?.key === refKey ? refState : undefined;
  if (shown === undefined) return <p className="muted small">Loading the references</p>;
  if (shown.refs === undefined) return <p className="muted small">The references of this function are not available: {shown.error}</p>;
  return <RefLists id={id} scope={scope} roots={roots} refs={shown.refs} />;
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
  // The whole row is the link: a click or Enter on any part of it opens the function.
  return (
    <a className="ref-row" href={href}>
      <span className="ref-name">{row.name}</span>{" "}
      <span className="mono muted small">{row.line > 0 ? `${row.file}:${row.line}` : row.file}</span>
      {row.kind !== "call" && (
        <>
          {" "}
          <span className={`kind ${row.kind}`}>{row.kind}</span>
        </>
      )}
      {row.count > 1 && <span className="muted small"> ×{row.count}</span>}
      {row.candidate && <span className="muted small"> candidate</span>}
    </a>
  );
}
