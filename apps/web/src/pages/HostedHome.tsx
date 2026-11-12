import { useEffect, useState, type FormEvent } from "react";
import {
  authMe,
  privateRepos,
  projectIdOf,
  recentIndexes,
  storageRoot,
  type AuthState,
  type PrivateRepo,
  type RecentIndex,
} from "../hostedApi";
import { authErrorOf, hrefHosted, parseRepoInput, relativeTime } from "../hostedRepo";
import { hrefProject } from "../router";

/** The repositories the hosted build shows first. */
const FEATURED: { owner: string; repo: string; note: string }[] = [{ owner: "codemonkeyricky", repo: "insight", note: "Insight indexing its own source" }];

const INSTALL_TEXT = "Install the Insight app on a repository to index it";

/** The hosted home's intro: the public-only copy when sign-in is off, the private-aware copy when it is on. */
export function homeIntroText(signInEnabled: boolean): string {
  return signInEnabled
    ? "Insight reads a GitHub repository and shows its flow, architecture and findings. Public indexes stay online for anyone to open; private ones only for people who can read the repository on GitHub."
    : "Insight reads a public repository and shows its flow, architecture and findings. Indexes are read-only and stay online for anyone to open.";
}

/** A sign-in that failed: the callback's code, with a button that hides the line. */
export function AuthErrorLine({ code, onDismiss }: { code: string; onDismiss: () => void }) {
  return (
    <p className="error auth-error" role="alert">
      Sign-in failed ({code}).{" "}
      <button type="button" className="auth-dismiss" onClick={onDismiss} aria-label="Dismiss the sign-in error">
        Dismiss
      </button>
    </p>
  );
}

/** The signed-in user's repositories: each one opens its index, private ones carry a lock. */
export function YourRepos({ repos, installUrl, error }: { repos: PrivateRepo[] | null; installUrl?: string; error?: string | null }) {
  return (
    <section className="your-repos" aria-labelledby="your-repos-title">
      <div className="your-repos-head">
        <h2 id="your-repos-title">Your repositories</h2>
        {installUrl && repos !== null && repos.length > 0 && (
          <a className="small" href={installUrl}>
            Add repositories
          </a>
        )}
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {!error && repos === null && <p className="muted">Loading</p>}
      {repos?.length === 0 && (
        <p className="muted">{installUrl ? <a href={installUrl}>{INSTALL_TEXT}</a> : INSTALL_TEXT}</p>
      )}
      {repos && repos.length > 0 && (
        <ul className="repo-list">
          {repos.map((r) => {
            const [owner = "", repo = ""] = r.repo.split("/");
            return (
              <li key={r.repo}>
                <a href={hrefHosted(owner, repo)}>
                  {r.private && (
                    <svg className="repo-lock" viewBox="0 0 16 16" width="12" height="12" role="img" aria-label="Private">
                      <rect x="3" y="7" width="10" height="7" rx="1.5" fill="currentColor" />
                      <path d="M5 7V5a3 3 0 0 1 6 0v2" fill="none" stroke="currentColor" strokeWidth="1.6" />
                    </svg>
                  )}
                  <span className="repo-name">{r.repo}</span>
                </a>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** The hosted home: index a GitHub repository by name or link, the signed-in user's repositories, the featured ones, and the recently indexed ones. */
export function HostedHome() {
  const [value, setValue] = useState("");
  const [inputError, setInputError] = useState<string | null>(null);
  const [recent, setRecent] = useState<RecentIndex[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [repos, setRepos] = useState<PrivateRepo[] | null>(null);
  const [installUrl, setInstallUrl] = useState<string | undefined>(undefined);
  const [reposError, setReposError] = useState<string | null>(null);
  const [authError, setAuthError] = useState<string | undefined>(() => authErrorOf(window.location.hash));

  useEffect(() => {
    let live = true;
    recentIndexes(storageRoot())
      .then((list) => live && setRecent(list))
      .catch(() => live && setLoadError("Could not load the recent indexes."));
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    let live = true;
    void authMe().then(async (me) => {
      if (!live) return;
      setAuth(me);
      if (!me.signedIn) return;
      try {
        const list = await privateRepos();
        if (!live) return;
        setRepos(list.repos);
        setInstallUrl(list.installUrl ?? me.installUrl);
      } catch {
        if (live) setReposError("Could not load your repositories.");
      }
    });
    return () => {
      live = false;
    };
  }, []);

  const dismissAuthError = () => {
    setAuthError(undefined);
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#/`);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const parsed = parseRepoInput(value);
    if (!parsed.ok) {
      setInputError(parsed.error);
      return;
    }
    setInputError(null);
    window.location.hash = hrefHosted(parsed.owner, parsed.repo, undefined, parsed.ref);
  };

  return (
    <section className="home hosted-home">
      <h1>Index a GitHub repo</h1>
      {authError && <AuthErrorLine code={authError} onDismiss={dismissAuthError} />}
      <p className="muted">
        {homeIntroText(auth?.enabled === true)}
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
            placeholder="owner/repo[@branch] or a github.com link"
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

      <p className="muted small">
        Tip: open {window.location.host}/&lt;owner&gt;/&lt;repo&gt; directly, e.g. /facebook/zstd, or /facebook/zstd/tree/dev for a branch
      </p>

      {auth?.signedIn && <YourRepos repos={repos} installUrl={installUrl ?? auth.installUrl} error={reposError} />}

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
