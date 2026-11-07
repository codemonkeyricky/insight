import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { api, type Compare, type DiffEdge, type DiffFinding, type DiffNode, type Overview } from "../api";
import { hrefCompare, hrefReview } from "../router";

/** Rows shown per table. The rest are counted, not drawn. */
const LIST_LIMIT = 200;

export function ComparePage({ id, base, head }: { id: string; base?: string; head?: string }) {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [result, setResult] = useState<Compare | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [baseRef, setBaseRef] = useState(base ?? "");
  const [headRef, setHeadRef] = useState(head ?? "");

  useEffect(() => {
    let cancelled = false;
    api
      .overview(id)
      .then((o) => !cancelled && setOverview(o))
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [id]);

  // Each distinct commit that has an indexed snapshot, newest first.
  const commits = useMemo(() => {
    const seen = new Map<string, { commit: string; createdAt: string }>();
    for (const s of overview?.snapshots ?? []) {
      if (s.commit && !seen.has(s.commit)) seen.set(s.commit, { commit: s.commit, createdAt: s.createdAt });
    }
    return [...seen.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }, [overview]);

  // A ref from the address can name a commit that has no snapshot in this list. Add it, so the
  // select shows the commit being compared instead of the first option.
  const options = useMemo(() => {
    const list = [...commits];
    for (const ref of [baseRef, headRef]) {
      if (ref && !list.some((c) => c.commit === ref)) list.push({ commit: ref, createdAt: "" });
    }
    return list;
  }, [commits, baseRef, headRef]);

  // With nothing chosen yet, compare the latest snapshot's commit with the one indexed before it.
  useEffect(() => {
    if (base || head || commits.length === 0) return;
    const latest = overview?.snapshot?.commit ?? commits[0]?.commit ?? "";
    const previous = commits.find((c) => c.commit !== latest)?.commit ?? latest;
    setHeadRef(latest);
    setBaseRef(previous);
  }, [base, head, commits, overview]);

  // The result is loaded when the page is opened with both refs in the address.
  useEffect(() => {
    if (!base || !head) return;
    let cancelled = false;
    setRunning(true);
    setError(null);
    api
      .compare(id, base, head)
      .then((r) => !cancelled && setResult(r))
      .catch((e: Error) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setRunning(false));
    return () => {
      cancelled = true;
    };
  }, [id, base, head]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (baseRef && headRef) window.location.hash = hrefCompare(id, baseRef, headRef);
  };

  const diff = result?.diff;

  return (
    <section>
      <h2>Compare commits</h2>
      <p className="muted small">
        Each commit is indexed from its own committed files, so uncommitted edits are not part of either side. A commit that was
        indexed before is reused.
      </p>

      {commits.length === 0 ? (
        <p className="muted">No indexed commits yet. Compare needs a git checkout that has been indexed at least once.</p>
      ) : (
        <form className="row" onSubmit={submit} aria-label="Choose commits">
          <label className="field">
            <span>Base</span>
            <select value={baseRef} onChange={(e) => setBaseRef(e.target.value)}>
              {options.map((c) => (
                <option key={c.commit} value={c.commit}>
                  {commitLabel(c)}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Head</span>
            <select value={headRef} onChange={(e) => setHeadRef(e.target.value)}>
              {options.map((c) => (
                <option key={c.commit} value={c.commit}>
                  {commitLabel(c)}
                </option>
              ))}
            </select>
          </label>
          <div className="actions">
            <button type="submit" disabled={!baseRef || !headRef || running}>
              Compare
            </button>
          </div>
        </form>
      )}

      {error && <p className="error" role="alert">{error}</p>}
      {running && <p className="muted" role="status">Indexing both commits. This can take a while on a large project.</p>}

      {result && diff && (
        <>
          <p className="muted small">
            Base <span className="mono">{shortCommit(result.base.commit)}</span>{" "}
            {result.base.reused ? "(indexed earlier)" : "(indexed now)"} to head{" "}
            <span className="mono">{shortCommit(result.head.commit)}</span>{" "}
            {result.head.reused ? "(indexed earlier)" : "(indexed now)"}.
          </p>

          <div className="stats">
            <Stat label="Nodes added" value={diff.ir.nodes.added.length} />
            <Stat label="Nodes removed" value={diff.ir.nodes.removed.length} />
            <Stat label="Nodes changed" value={diff.ir.nodes.changed.length} />
            <Stat label="Edges added" value={diff.ir.edges.added.length} />
            <Stat label="Edges removed" value={diff.ir.edges.removed.length} />
            <Stat label="New findings" value={diff.lenses.reduce((n, l) => n + l.added.length, 0)} />
            <Stat label="Resolved findings" value={diff.lenses.reduce((n, l) => n + l.removed.length, 0)} />
          </div>

          <h2>Summary</h2>
          {diff.summary.length === 0 ? (
            <p className="muted">No semantic changes between these commits.</p>
          ) : (
            <ul className="findings">
              {diff.summary.map((line, i) => (
                <li key={i}>{line}</li>
              ))}
            </ul>
          )}
          <p className="small">
            <a href={hrefReview(id)}>Review findings</a> to accept or dismiss what is new.
          </p>

          <h2>Lenses</h2>
          <table className="grid">
            <thead>
              <tr>
                <th>Lens</th>
                <th>Base</th>
                <th>Head</th>
                <th>New</th>
                <th>Resolved</th>
                <th>Unchanged</th>
              </tr>
            </thead>
            <tbody>
              {diff.lenses.map((l) => (
                <tr key={l.id}>
                  <td className="mono">{l.id}</td>
                  <td>{l.base}</td>
                  <td>{l.head}</td>
                  <td>{l.comparable ? l.added.length : <span className="muted small">not comparable</span>}</td>
                  <td>{l.comparable ? l.removed.length : "-"}</td>
                  <td>{l.comparable ? l.unchanged : "-"}</td>
                </tr>
              ))}
              {diff.lenses.length === 0 && (
                <tr>
                  <td colSpan={6} className="muted">No lens ran on either side.</td>
                </tr>
              )}
            </tbody>
          </table>

          <FindingList title="New findings" rows={diff.lenses.flatMap((l) => l.added)} />
          <FindingList title="Resolved findings" rows={diff.lenses.flatMap((l) => l.removed)} />

          <NodeList title="Nodes added" rows={diff.ir.nodes.added} />
          <NodeList title="Nodes removed" rows={diff.ir.nodes.removed} />
          <NodeList title="Nodes changed" rows={diff.ir.nodes.changed} />

          <EdgeList title="Edges added" rows={diff.ir.edges.added} />
          <EdgeList title="Edges removed" rows={diff.ir.edges.removed} />
        </>
      )}
    </section>
  );
}

function shortCommit(sha: string): string {
  return sha.slice(0, 10);
}

/** A commit with its indexing date, or just the ref when it has no snapshot yet. */
function commitLabel(c: { commit: string; createdAt: string }): string {
  return c.createdAt ? `${shortCommit(c.commit)} (${new Date(c.createdAt).toLocaleDateString()})` : shortCommit(c.commit);
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="stat">
      <div className="muted small">{label}</div>
      <div className="value">{value}</div>
    </div>
  );
}

function Section({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  return (
    <>
      <h2>
        {title} <span className="muted small">({count})</span>
      </h2>
      {count === 0 ? <p className="muted">None.</p> : children}
      {count > LIST_LIMIT && <p className="muted small">Showing the first {LIST_LIMIT}.</p>}
    </>
  );
}

function where(n: { file?: string; line?: number }): string {
  return n.file ? `${n.file}${n.line !== undefined ? `:${n.line}` : ""}` : "";
}

function FindingList({ title, rows }: { title: string; rows: DiffFinding[] }) {
  return (
    <Section title={title} count={rows.length}>
      <ul className="findings">
        {rows.slice(0, LIST_LIMIT).map((f) => (
          <li key={f.key}>
            <span className={`sev ${f.severity}`}>{f.severity}</span> {f.message}{" "}
            <span className="mono muted small">
              {f.lens} {where(f)}
            </span>
          </li>
        ))}
      </ul>
    </Section>
  );
}

function NodeList({ title, rows }: { title: string; rows: DiffNode[] }) {
  return (
    <Section title={title} count={rows.length}>
      <table className="grid">
        <thead>
          <tr>
            <th>Kind</th>
            <th>Name</th>
            <th>Where</th>
            <th>Node</th>
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, LIST_LIMIT).map((n) => (
            <tr key={n.id}>
              <td className="mono">{n.kind}</td>
              <td>{n.name ?? ""}</td>
              <td className="mono small">{where(n)}</td>
              <td className="mono small">{n.id}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Section>
  );
}

function EdgeList({ title, rows }: { title: string; rows: DiffEdge[] }) {
  return (
    <Section title={title} count={rows.length}>
      <table className="grid">
        <thead>
          <tr>
            <th>From</th>
            <th>Kind</th>
            <th>To</th>
            <th>Count</th>
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, LIST_LIMIT).map((e, i) => (
            <tr key={`${e.from}>${e.kind}>${i}`}>
              <td className="mono small">{e.from}</td>
              <td className="mono">{e.kind}</td>
              <td className="mono small">{typeof e.to === "string" ? e.to : JSON.stringify(e.to)}</td>
              <td>{e.count}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Section>
  );
}
