import { useEffect, useState, type FormEvent } from "react";
import { recentIndexes, projectIdOf, storageRoot, type RecentIndex } from "../hostedApi";
import { hrefHosted, parseRepoInput, relativeTime } from "../hostedRepo";
import { hrefProject } from "../router";

/** The repositories the hosted build shows first. */
const FEATURED: { owner: string; repo: string; note: string }[] = [{ owner: "codemonkeyricky", repo: "insight", note: "Insight indexing its own source" }];

/** The hosted home: index a GitHub repository by name or link, the featured ones, and the recently indexed ones. */
export function HostedHome() {
  const [value, setValue] = useState("");
  const [inputError, setInputError] = useState<string | null>(null);
  const [recent, setRecent] = useState<RecentIndex[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    recentIndexes(storageRoot())
      .then((list) => live && setRecent(list))
      .catch(() => live && setLoadError("Could not load the recent indexes."));
    return () => {
      live = false;
    };
  }, []);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const parsed = parseRepoInput(value);
    if (!parsed.ok) {
      setInputError(parsed.error);
      return;
    }
    setInputError(null);
    window.location.hash = hrefHosted(parsed.owner, parsed.repo);
  };

  return (
    <section className="home hosted-home">
      <h1>Index a GitHub repo</h1>
      <p className="muted">
        Insight reads a public repository and shows its flow, architecture and findings. Indexes are read-only and stay online for anyone to open.
      </p>

      <form className="panel add add-panel" onSubmit={submit} noValidate>
        <label className="field">
          <span>Repository</span>
          <input
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setInputError(null);
            }}
            placeholder="owner/repo or https://github.com/owner/repo"
            aria-invalid={inputError !== null}
            aria-describedby={inputError ? "repo-input-error" : undefined}
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <div className="row">
          <button type="submit" className="add-submit" disabled={value.trim() === ""}>
            Index
          </button>
        </div>
        {inputError && (
          <p id="repo-input-error" className="error" role="alert">
            {inputError}
          </p>
        )}
      </form>

      <h2>Featured</h2>
      <ul className="cards">
        {FEATURED.map((f) => (
          <li key={`${f.owner}/${f.repo}`} className="card project-card">
            <a className="project-name" href={hrefHosted(f.owner, f.repo)}>
              {f.owner}/{f.repo}
            </a>
            <div className="muted small">{f.note}</div>
          </li>
        ))}
      </ul>

      <h2>Recent</h2>
      {loadError && (
        <p className="error" role="alert">
          {loadError}
        </p>
      )}
      {recent === null && !loadError && <p className="muted">Loading</p>}
      {recent?.length === 0 && <p className="muted">Nothing has been indexed yet. Index a repository above.</p>}
      <ul className="cards">
        {recent?.map((r) => {
          const [owner = "", repo = ""] = r.repo.split("/");
          return (
            <li key={`${r.repo}@${r.sha}`} className="card project-card">
              <a className="project-name" href={hrefProject(projectIdOf({ owner, repo, sha: r.sha }))}>
                {r.repo}
              </a>
              <div className="project-meta">
                <span className="muted project-stats">
                  {r.nodes.toLocaleString()} nodes, {r.files.toLocaleString()} files
                </span>
                <span className="muted">{relativeTime(r.indexedAt, Date.now())}</span>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
