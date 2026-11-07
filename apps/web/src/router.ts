export type Route =
  | { name: "projects" }
  | { name: "project"; id: string }
  | { name: "lens"; id: string; lensId: string }
  | { name: "files"; id: string; path?: string; line?: number }
  | { name: "unknown" };

/**
 * Parses a hash route such as #/projects/abc123/lenses/lens-dependencies or
 * #/projects/abc123/files/src/index.ts?line=12.
 */
export function parseRoute(hash: string): Route {
  const [pathPart = "", query = ""] = hash.replace(/^#/, "").split("?");
  const parts = pathPart.split("/").filter((p) => p.length > 0).map((p) => decodeURIComponent(p));
  if (parts.length === 0 || (parts[0] === "projects" && parts.length === 1)) return { name: "projects" };
  if (parts[0] === "projects" && parts.length === 2) return { name: "project", id: parts[1] as string };
  if (parts[0] === "projects" && parts[2] === "lenses" && parts.length === 4) {
    return { name: "lens", id: parts[1] as string, lensId: parts[3] as string };
  }
  if (parts[0] === "projects" && parts[2] === "files") {
    const path = parts.slice(3).join("/");
    const line = Number(new URLSearchParams(query).get("line"));
    return {
      name: "files",
      id: parts[1] as string,
      ...(path ? { path } : {}),
      ...(path && Number.isInteger(line) && line > 0 ? { line } : {}),
    };
  }
  return { name: "unknown" };
}

export const hrefProject = (id: string) => `#/projects/${encodeURIComponent(id)}`;
export const hrefLens = (id: string, lensId: string) => `#/projects/${encodeURIComponent(id)}/lenses/${encodeURIComponent(lensId)}`;
/** A link to the file browser, optionally opened on one file and line (1-based). */
export const hrefFile = (id: string, path?: string, line?: number) =>
  `#/projects/${encodeURIComponent(id)}/files${path ? `/${path.split("/").map(encodeURIComponent).join("/")}` : ""}${path && line ? `?line=${line}` : ""}`;
