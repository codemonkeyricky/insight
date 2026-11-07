export type Route =
  | { name: "projects" }
  | { name: "project"; id: string }
  | { name: "lens"; id: string; lensId: string }
  | { name: "unknown" };

/** Parses a hash route such as #/projects/abc123/lenses/lens-dependencies. */
export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#/, "").split("/").filter((p) => p.length > 0).map((p) => decodeURIComponent(p));
  if (parts.length === 0 || parts[0] === "projects" && parts.length === 1) return { name: "projects" };
  if (parts[0] === "projects" && parts.length === 2) return { name: "project", id: parts[1] as string };
  if (parts[0] === "projects" && parts[2] === "lenses" && parts.length === 4) {
    return { name: "lens", id: parts[1] as string, lensId: parts[3] as string };
  }
  return { name: "unknown" };
}

export const hrefProject = (id: string) => `#/projects/${encodeURIComponent(id)}`;
export const hrefLens = (id: string, lensId: string) => `#/projects/${encodeURIComponent(id)}/lenses/${encodeURIComponent(lensId)}`;
