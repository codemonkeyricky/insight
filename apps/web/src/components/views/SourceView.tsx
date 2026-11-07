import type { FileEntry } from "../../api";
import { hrefView } from "../../router";
import { FileViewer, humanSize } from "../FileViewer";
import { scopeKind } from "../ScopeNote";

interface FolderRow {
  name: string;
  path: string;
  files: number;
  functions: number;
  findings: number;
}

/** The folders and files directly under a scope. */
function listing(files: FileEntry[], scope: string): { folders: FolderRow[]; direct: FileEntry[] } {
  const prefix = scope === "" ? "" : `${scope}/`;
  const folders = new Map<string, FolderRow>();
  const direct: FileEntry[] = [];
  for (const f of files) {
    if (!f.path.startsWith(prefix)) continue;
    const rest = f.path.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash === -1) {
      direct.push(f);
      continue;
    }
    const name = rest.slice(0, slash);
    const row = folders.get(name) ?? { name, path: `${prefix}${name}`, files: 0, functions: 0, findings: 0 };
    row.files += 1;
    row.functions += f.functions;
    row.findings += f.findings;
    folders.set(name, row);
  }
  return {
    folders: [...folders.values()].sort((a, b) => a.name.localeCompare(b.name)),
    direct: direct.sort((a, b) => a.path.localeCompare(b.path)),
  };
}

/** The source tab: one file's lines, or the listing of a folder (or the whole project). */
export function SourceView({ id, files, scope, line }: { id: string; files: FileEntry[]; scope: string; line?: number }) {
  const kind = scopeKind(scope, files);
  if (kind === "file") return <FileViewer id={id} path={scope} line={line} />;
  if (kind === "missing") return <p className="muted">Nothing at this path. Pick a file or folder in the explorer.</p>;
  const { folders, direct } = listing(files, scope);
  return (
    <section>
      {folders.length > 0 && (
        <>
          <h2>Folders</h2>
          <table className="grid">
            <thead>
              <tr>
                <th>Folder</th>
                <th>Files</th>
                <th>Functions</th>
                <th>Findings</th>
              </tr>
            </thead>
            <tbody>
              {folders.map((d) => (
                <tr key={d.path}>
                  <td>
                    <a href={hrefView(id, "source", { scope: d.path })}>{d.name}/</a>
                  </td>
                  <td>{d.files}</td>
                  <td>{d.functions}</td>
                  <td>{d.findings}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      <h2>Files</h2>
      {direct.length === 0 ? (
        <p className="muted">No files directly here.</p>
      ) : (
        <table className="grid">
          <thead>
            <tr>
              <th>File</th>
              <th>Language</th>
              <th>Size</th>
              <th>Functions</th>
              <th>Types</th>
              <th>Findings</th>
            </tr>
          </thead>
          <tbody>
            {direct.map((f) => (
              <tr key={f.path}>
                <td>
                  <a className="mono small" href={hrefView(id, "source", { scope: f.path })}>
                    {f.path.slice(f.path.lastIndexOf("/") + 1)}
                  </a>
                </td>
                <td>{f.language ?? <span className="muted">none</span>}</td>
                <td>{humanSize(f.size)}</td>
                <td>{f.functions}</td>
                <td>{f.types}</td>
                <td>{f.findings}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
