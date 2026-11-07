import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type Review, type ReviewItem } from "../api";
import { AnnotationBox } from "../components/AnnotationBox";
import { ProjectTabs } from "../components/ProjectTabs";
import { hrefCompare, hrefProject } from "../router";

type Filter = "open" | "accepted" | "dismissed" | "all";

export function ReviewPage({ id }: { id: string }) {
  const [review, setReview] = useState<Review | null>(null);
  const [name, setName] = useState<string>(id);
  const [filter, setFilter] = useState<Filter>("open");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setReview(await api.review(id));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [id]);

  useEffect(() => {
    void load();
    api
      .project(id)
      .then((p) => setName(p.name))
      .catch(() => undefined);
  }, [id, load]);

  // Runs one change, then reloads the checklist so every count and list agrees with the server.
  const change = async (run: () => Promise<unknown>) => {
    try {
      await run();
      setError(null);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const counts = useMemo(() => {
    const c = { open: 0, accepted: 0, dismissed: 0 };
    for (const i of review?.items ?? []) c[i.status] += 1;
    return c;
  }, [review]);

  const shown = useMemo(() => {
    const items = (review?.items ?? []).filter((i) => filter === "all" || i.status === filter);
    const byLens = new Map<string, ReviewItem[]>();
    for (const i of items) {
      const list = byLens.get(i.lens) ?? [];
      list.push(i);
      byLens.set(i.lens, list);
    }
    return [...byLens.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [review, filter]);

  if (error && !review) return <p className="error" role="alert">{error}</p>;
  if (!review) return <p className="muted">Loading</p>;

  return (
    <section>
      <nav className="crumbs small">
        <a href={hrefProject(id)}>{name}</a> / <span>Review</span>
      </nav>
      <ProjectTabs id={id} active="review" />
      <h1>Review findings</h1>
      <p className="muted small">
        Each finding is decided by its key, the lens and the finding id. A dismissal needs a note saying why. A finding whose id
        includes a line number gets a new key when its line moves, so its old decision is listed under stale.{" "}
        <a href={hrefCompare(id)}>Compare commits</a> to see what is new since an earlier commit.
      </p>
      {error && <p className="error" role="alert">{error}</p>}

      {review.snapshot === null ? (
        <p className="muted">This project has no snapshot yet. Re-index it first.</p>
      ) : (
        <>
          <div className="stats">
            <Stat label="Open" value={counts.open} />
            <Stat label="Accepted" value={counts.accepted} />
            <Stat label="Dismissed" value={counts.dismissed} />
            <Stat label="Stale decisions" value={review.stale.length} />
          </div>

          <div className="row small">
            <label className="field">
              <span>Show</span>
              <select value={filter} onChange={(e) => setFilter(e.target.value as Filter)}>
                <option value="open">open</option>
                <option value="dismissed">dismissed</option>
                <option value="accepted">accepted</option>
                <option value="all">all</option>
              </select>
            </label>
          </div>

          {shown.length === 0 && <p className="muted">No findings to show.</p>}
          {shown.map(([lens, rows]) => (
            <div key={lens} className="group">
              <h2>
                {lens} <span className="muted small">({rows.length})</span>
              </h2>
              <ul className="review-list">
                {rows.map((item) => (
                  <ReviewRow key={item.key} projectId={id} item={item} onChange={change} />
                ))}
              </ul>
            </div>
          ))}
        </>
      )}

      {review.stale.length > 0 && (
        <>
          <h2>Stale decisions</h2>
          <p className="muted small">These decisions have no matching finding in the current snapshot. Reopen to remove them.</p>
          <ul className="findings">
            {review.stale.map((s) => (
              <li key={s.key}>
                <span className="mono small">{s.key}</span> <span className="badge">{s.status}</span>
                {s.note && <div className="small">{s.note}</div>}
                <button type="button" className="link" onClick={() => void change(() => api.reopen(id, s.key))}>
                  Reopen
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function ReviewRow({
  projectId,
  item,
  onChange,
}: {
  projectId: string;
  item: ReviewItem;
  onChange: (run: () => Promise<unknown>) => Promise<void>;
}) {
  const [draft, setDraft] = useState("");
  const [showNotes, setShowNotes] = useState(false);
  const where = item.file ? `${item.file}${item.line !== undefined ? `:${item.line}` : ""}` : "";

  return (
    <li className="review-item">
      <div>
        <span className={`sev ${item.severity}`}>{item.severity}</span> {item.message}{" "}
        {where && <span className="mono muted small">{where}</span>}{" "}
        <span className={`badge ${item.status === "open" ? "" : item.status}`}>{item.status}</span>
      </div>
      <div className="mono muted small">{item.key}</div>
      {item.status !== "open" && item.note && <div className="small">Note: {item.note}</div>}

      {item.status === "open" ? (
        <div className="review-actions">
          <textarea
            aria-label={`Note for ${item.key}`}
            placeholder="Note. Required to dismiss."
            value={draft}
            maxLength={4000}
            onChange={(e) => setDraft(e.target.value)}
          />
          <div className="actions">
            <button type="button" onClick={() => void onChange(() => api.decide(projectId, item.key, "accepted", draft.trim()))}>
              Accept
            </button>
            <button
              type="button"
              disabled={draft.trim() === ""}
              onClick={() => void onChange(() => api.decide(projectId, item.key, "dismissed", draft.trim()))}
            >
              Dismiss
            </button>
            <button type="button" className="link" onClick={() => setShowNotes((v) => !v)}>
              {showNotes ? "Hide notes" : "Notes"}
            </button>
          </div>
        </div>
      ) : (
        <div className="actions">
          <button type="button" className="link" onClick={() => void onChange(() => api.reopen(projectId, item.key))}>
            Reopen
          </button>
          <button type="button" className="link" onClick={() => setShowNotes((v) => !v)}>
            {showNotes ? "Hide notes" : "Notes"}
          </button>
        </div>
      )}

      {showNotes && <AnnotationBox projectId={projectId} type="finding" targetKey={item.key} title={item.key} />}
    </li>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="stat">
      <div className="muted small">{label}</div>
      <div className="value">{value}</div>
    </div>
  );
}
