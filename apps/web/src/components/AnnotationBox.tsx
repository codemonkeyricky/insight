import { useEffect, useState } from "react";
import { api, ApiError, type Annotation, type TargetType } from "../api";

/** Notes on one node, edge or finding. The list is loaded when the target changes. */
export function AnnotationBox({
  projectId,
  type,
  targetKey,
  title,
}: {
  projectId: string;
  type: TargetType;
  targetKey: string;
  title: string;
}) {
  const [items, setItems] = useState<Annotation[] | null>(null);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setItems(null);
    setEditing(null);
    api
      .annotations(projectId, { type, key: targetKey })
      .then((list) => !cancelled && setItems(list))
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [projectId, type, targetKey]);

  const fail = (e: unknown) => setError(e instanceof ApiError || e instanceof Error ? e.message : String(e));

  const add = async () => {
    try {
      const created = await api.addAnnotation(projectId, { type, key: targetKey, text: draft.trim() });
      setItems((prev) => [...(prev ?? []), created]);
      setDraft("");
      setError(null);
    } catch (e) {
      fail(e);
    }
  };

  const save = async () => {
    if (!editing) return;
    try {
      const updated = await api.editAnnotation(projectId, editing.id, editing.text.trim());
      setItems((prev) => (prev ?? []).map((a) => (a.id === updated.id ? updated : a)));
      setEditing(null);
      setError(null);
    } catch (e) {
      fail(e);
    }
  };

  const remove = async (annId: string) => {
    try {
      await api.removeAnnotation(projectId, annId);
      setItems((prev) => (prev ?? []).filter((a) => a.id !== annId));
      setError(null);
    } catch (e) {
      fail(e);
    }
  };

  return (
    <section className="annotations panel" aria-label={`Notes on ${title}`}>
      <h3>Notes</h3>
      <p className="muted small mono">{title}</p>
      {error && <p className="error" role="alert">{error}</p>}
      {items === null && !error && <p className="muted small">Loading</p>}
      {items?.length === 0 && <p className="muted small">No notes yet.</p>}
      <ul className="notes">
        {items?.map((a) => (
          <li key={a.id}>
            {editing?.id === a.id ? (
              <div className="field">
                <textarea
                  aria-label="Edit note"
                  value={editing.text}
                  maxLength={4000}
                  onChange={(e) => setEditing({ id: a.id, text: e.target.value })}
                />
                <div className="actions">
                  <button type="button" onClick={() => void save()} disabled={editing.text.trim() === ""}>
                    Save
                  </button>
                  <button type="button" className="link" onClick={() => setEditing(null)}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <>
                <div className="note-text">{a.text}</div>
                <div className="muted small">
                  {new Date(a.updatedAt).toLocaleString()}{" "}
                  <button type="button" className="link" onClick={() => setEditing({ id: a.id, text: a.text })}>
                    Edit
                  </button>{" "}
                  <button type="button" className="link" onClick={() => void remove(a.id)}>
                    Delete
                  </button>
                </div>
              </>
            )}
          </li>
        ))}
      </ul>
      <div className="field">
        <textarea
          aria-label="New note"
          placeholder="Add a note"
          value={draft}
          maxLength={4000}
          onChange={(e) => setDraft(e.target.value)}
        />
        <div>
          <button type="button" onClick={() => void add()} disabled={draft.trim() === ""}>
            Add note
          </button>
        </div>
      </div>
    </section>
  );
}
