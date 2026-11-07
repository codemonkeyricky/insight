import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError, IS_DEMO, type Project } from "../api";
import { hrefProject } from "../router";

export function ProjectsPage() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => api.projects().then(setProjects).catch((e: Error) => setError(e.message));

  useEffect(() => {
    void load();
    const timer = IS_DEMO ? undefined : setInterval(() => void load(), 4000);
    return () => clearInterval(timer);
  }, []);

  return (
    <section>
      <h1>Projects</h1>
      {IS_DEMO ? (
        <p className="panel muted">
          This demo shows one fixed project: Insight analysing its own latest commit. Run Insight locally to add your own projects.
        </p>
      ) : (
        <AddProject onAdded={() => void load()} />
      )}
      {error && <p className="error" role="alert">{error}</p>}
      {projects === null && !error && <p className="muted">Loading</p>}
      {projects?.length === 0 && <p className="muted">No projects yet. Add a folder or a git URL above.</p>}
      <ul className="cards">
        {projects?.map((p) => (
          <li key={p.id} className="card">
            <a href={hrefProject(p.id)}>
              <strong>{p.name}</strong>
            </a>
            <div className="mono muted small">{p.source.kind === "path" ? p.source.path : p.source.url}</div>
            <div className="row small">
              <StatusBadge project={p} />
              {p.last && (
                <span className="muted">
                  {p.last.nodes} nodes, {p.last.findings} findings{p.last.commit ? `, ${p.last.commit.slice(0, 7)}` : ""}
                </span>
              )}
            </div>
            {p.error && <div className="error small">{p.error}</div>}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function StatusBadge({ project }: { project: Project }) {
  const label = project.status === "indexing" ? (project.queued ? "indexing, one more queued" : "indexing") : project.status;
  return <span className={`badge ${project.status}`}>{label}</span>;
}

function AddProject({ onAdded }: { onAdded: () => void }) {
  const [mode, setMode] = useState<"path" | "url">("path");
  const [value, setValue] = useState("");
  const [name, setName] = useState("");
  const [allowBuildTools, setAllowBuildTools] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = {
        ...(mode === "path" ? { path: value.trim() } : { url: value.trim() }),
        ...(name.trim() ? { name: name.trim() } : {}),
        allowBuildTools,
      };
      const project = await api.add(body);
      setValue("");
      setName("");
      onAdded();
      window.location.hash = hrefProject(project.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="panel add" onSubmit={submit}>
      <h2>Add a project</h2>
      <div className="row" role="radiogroup" aria-label="Source type">
        <label>
          <input type="radio" name="mode" checked={mode === "path"} onChange={() => setMode("path")} /> Local folder
        </label>
        <label>
          <input type="radio" name="mode" checked={mode === "url"} onChange={() => setMode("url")} /> Git URL
        </label>
      </div>
      <label className="field">
        <span>{mode === "path" ? "Folder path" : "Git URL"}</span>
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={mode === "path" ? "/home/you/code/project" : "https://github.com/owner/repo.git"}
          required
        />
      </label>
      <label className="field">
        <span>Name (optional)</span>
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="check">
        <input type="checkbox" checked={allowBuildTools} onChange={(e) => setAllowBuildTools(e.target.checked)} />
        Allow build tools (bazel, cmake) to run. Off by default.
      </label>
      <div className="row">
        <button type="submit" disabled={busy || value.trim() === ""}>
          {busy ? "Adding" : "Add and index"}
        </button>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
    </form>
  );
}
