// The reverse references of the function the Flow panel shows: what calls or references it, and what it calls, across the
// whole project. Each list groups its rows into the functions in this scope and the ones outside it. A function row links
// to that function: in this scope the link keeps the scope, outside it the link switches the scope to the function's file.
// The side panel pins these lists above the scrolling source, so they stay in view while the source scrolls.
import { readLambdas } from "../../zoom/lambdaPref";
import { useEffect, useState } from "react";
import type { RefRow, Refs } from "@insight/model";
import { api } from "../../api";
import type { MapSelection } from "./ZoomMap";
import { CallerChain } from "./CallerChain";
import { KindTag, refHref } from "./refLink";

/** What every part of the lists needs: the project, and the scope the map shows (its rows inside it, the scope a link keeps). */
interface Base {
  id: string;
  scope: string;
}

/** The references of the selected function, fetched for its scope, with the loading and error states the panel shows. */
export function FunctionRefs({ id, sel, trace }: { id: string; sel: MapSelection; trace?: string }) {
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
  // The chain is always mounted, whatever the refs state: walking to another function must not unmount it and lose its state.
  return (
    <>
      {shown === undefined ? (
        <p className="muted small">Loading the references</p>
      ) : shown.refs === undefined ? (
        <p className="muted small">The references of this function are not available: {shown.error}</p>
      ) : (
        <RefLists id={id} scope={scope} refs={shown.refs} />
      )}
      <CallerChain id={id} sel={sel} {...(trace !== undefined ? { trace } : {})} />
    </>
  );
}

export function RefLists({ id, scope, refs }: Base & { refs: Refs }) {
  return (
    <div className="ref-lists">
      <RefList id={id} scope={scope} title="Called by" rows={refs.calledBy} empty="Nothing in the project calls or references it." />
      <RefList id={id} scope={scope} title="Calls" rows={refs.calls} empty="It calls nothing." />
    </div>
  );
}

function RefList({ id, scope, title, rows: all, empty }: Base & { title: string; rows: RefRow[]; empty: string }) {
  // With lambdas folded, an anonymous function is not a row: its calls belong to its owner, so its rows are dropped.
  const lambdas = readLambdas();
  const rows = lambdas ? all : all.filter((r) => !r.name.startsWith("λ"));
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
          {inside.length > 0 && <RefGroup id={id} scope={scope} label="In this scope" rows={inside} />}
          {outside.length > 0 && <RefGroup id={id} scope={scope} label="Outside this scope" rows={outside} />}
        </>
      )}
    </details>
  );
}

function RefGroup({ id, scope, label, rows }: Base & { label: string; rows: RefRow[] }) {
  return (
    <section className="ref-group">
      <h4>
        {label} ({rows.length})
      </h4>
      <ul className="call-list">
        {rows.map((r) => (
          <li key={`${r.id}\0${r.kind}`}>
            <RefItem id={id} scope={scope} row={r} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function RefItem({ id, scope, row }: Base & { row: RefRow }) {
  // The whole row is the link: a click or Enter on any part of it opens the function.
  return (
    <a className="ref-row" href={refHref(id, scope, row)}>
      <span className="ref-name">{row.name}</span>{" "}
      <span className="mono muted small">{row.line > 0 ? `${row.file}:${row.line}` : row.file}</span>
      <KindTag kind={row.kind} how={row.how} />
      {row.count > 1 && <span className="muted small"> ×{row.count}</span>}
      {row.candidate && <span className="muted small"> candidate</span>}
    </a>
  );
}
