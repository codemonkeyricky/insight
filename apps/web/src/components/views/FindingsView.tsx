import { useEffect, useMemo, useState } from "react";
import { api, type FindingRow } from "../../api";
import { groupFindings, type FindingExample, type FindingGroup } from "../../findingGroups";
import { hrefFile, hrefView, inScope } from "../../router";

/** The Findings page: one revision-table row per kind of finding, with its count, top files, examples and a Show in Flow link. */
export function FindingsView({ id, scope }: { id: string; scope: string }) {
  const [rows, setRows] = useState<FindingRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .findings(id)
      .then((r) => !cancelled && setRows(r))
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [id]);

  const shown = useMemo(
    () => (rows ?? []).filter((f) => scope === "" || (f.span !== undefined && inScope(f.span.file, scope))),
    [rows, scope],
  );
  const groups = useMemo(() => groupFindings(shown), [shown]);

  if (error) return <p className="error" role="alert">{error}</p>;
  if (!rows) return <p className="muted">Loading</p>;
  return (
    <section className="rv-page">
      <p className="muted small">
        {shown.length} of {rows.length} findings {scope === "" ? "in the project" : "in this scope"}, in {groups.length} {groups.length === 1 ? "kind" : "kinds"}.
      </p>
      {groups.length === 0 ? (
        <p className="muted">No findings here.</p>
      ) : (
        <div className="revtable" role="table" aria-label="Findings by kind">
          <div className="revhead" role="row">
            <span role="columnheader">Count</span>
            <span role="columnheader">Finding</span>
            <span role="columnheader">Top files</span>
            <span role="columnheader">Examples</span>
            <span role="columnheader">Flow</span>
          </div>
          {groups.map((g) => (
            <RevRow key={g.kind} id={id} group={g} />
          ))}
        </div>
      )}
    </section>
  );
}

const lensTitle = (lens: string): string => lens.replace(/^lens-/, "");

/** A path split at its last slash: the directory (with its slash) and the basename, which the table never truncates. */
export function splitFile(file: string): { dir: string; base: string } {
  const slash = file.lastIndexOf("/");
  return slash === -1 ? { dir: "", base: file } : { dir: file.slice(0, slash + 1), base: file.slice(slash + 1) };
}

/** Where an example points: its function in Flow when it names one, else its line in the source. */
function exampleHref(id: string, kind: string, e: FindingExample): string | undefined {
  if (e.fn !== undefined && e.file !== undefined) return hrefView(id, "flow", { scope: e.file, fn: e.fn, kind });
  if (e.file !== undefined) return hrefFile(id, e.file, e.line);
  return undefined;
}

export function RevRow({ id, group: g }: { id: string; group: FindingGroup }) {
  const max = Math.max(1, ...g.topFiles.map((t) => t.count));
  const flowHref = hrefView(id, "flow", {
    ...(g.flowFile !== undefined ? { scope: g.flowFile } : {}),
    ...(g.flowFn !== undefined ? { fn: g.flowFn } : {}),
    kind: g.kind,
  });
  return (
    <div className="revrow" role="row">
      <div className="rv-cell rv-count" role="cell" data-label="Count">
        <span className="rv-num">{g.count}</span>
      </div>
      <div className="rv-cell rv-finding" role="cell" data-label="Finding">
        <p className="rv-msg">{g.message}</p>
        <p className="muted small">
          <span className={`sev ${g.severity}`}>{g.severity}</span> {lensTitle(g.lens)} · <span className="mono">{g.kind}</span>
        </p>
      </div>
      <div className="rv-cell rv-files" role="cell" data-label="Top files">
        {g.topFiles.length === 0 ? (
          <span className="muted small">project</span>
        ) : (
          <ul className="rv-bars">
            {g.topFiles.map((t) => (
              <li key={t.file} className="rv-bar">
                <span className="rv-bar-file mono" title={t.file}>
                  {(() => {
                    const { dir, base } = splitFile(t.file);
                    return (
                      <>
                        {dir !== "" && <span className="rv-dir">{dir}</span>}
                        <span className="rv-base">{base}</span>
                      </>
                    );
                  })()}
                </span>
                <span className="rv-bar-track" aria-hidden="true">
                  <i style={{ width: `${(t.count / max) * 100}%` }} />
                </span>
                <span className="rv-bar-n">{t.count}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="rv-examples" role="cell" data-label="Examples">
        <ul className="rv-ex-list">
          {g.examples.map((e, i) => {
            const href = exampleHref(id, g.kind, e);
            const where = e.file === undefined ? "project" : e.line === undefined ? e.file : `${e.file}:${e.line}`;
            return (
              <li key={`${e.file ?? ""}\0${e.fn ?? ""}\0${i}`}>
                {href === undefined ? (
                  <span className="mono small rv-ex" title={where}>
                    {where}
                  </span>
                ) : (
                  <a className="mono small rv-ex" href={href} title={`${where} · ${e.message}`}>
                    {where}
                  </a>
                )}
              </li>
            );
          })}
        </ul>
      </div>
      <div className="rv-cell rv-act" role="cell" data-label="Flow">
        <a className="btn rv-show" href={flowHref}>
          Show in Flow
        </a>
      </div>
    </div>
  );
}
