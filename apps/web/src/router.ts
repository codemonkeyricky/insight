export type Route =
  | { name: "projects" }
  | { name: "project"; id: string }
  | { name: "lens"; id: string; lensId: string }
  | { name: "compare"; id: string; base?: string; head?: string }
  | { name: "review"; id: string }
  | { name: "unknown" };

/** Parses a hash route such as #/projects/abc123/lenses/lens-dependencies or #/projects/abc123/compare?base=a&head=b. */
export function parseRoute(hash: string): Route {
  const raw = hash.replace(/^#/, "");
  const at = raw.indexOf("?");
  const path = at === -1 ? raw : raw.slice(0, at);
  const query = new URLSearchParams(at === -1 ? "" : raw.slice(at + 1));
  const parts = path.split("/").filter((p) => p.length > 0).map((p) => decodeURIComponent(p));
  if (parts.length === 0 || parts[0] === "projects" && parts.length === 1) return { name: "projects" };
  if (parts[0] === "projects" && parts.length === 2) return { name: "project", id: parts[1] as string };
  if (parts[0] === "projects" && parts[2] === "lenses" && parts.length === 4) {
    return { name: "lens", id: parts[1] as string, lensId: parts[3] as string };
  }
  if (parts[0] === "projects" && parts[2] === "compare" && parts.length === 3) {
    return {
      name: "compare",
      id: parts[1] as string,
      ...(query.get("base") ? { base: query.get("base") as string } : {}),
      ...(query.get("head") ? { head: query.get("head") as string } : {}),
    };
  }
  if (parts[0] === "projects" && parts[2] === "review" && parts.length === 3) {
    return { name: "review", id: parts[1] as string };
  }
  return { name: "unknown" };
}

export const hrefProject = (id: string) => `#/projects/${encodeURIComponent(id)}`;
export const hrefLens = (id: string, lensId: string) => `#/projects/${encodeURIComponent(id)}/lenses/${encodeURIComponent(lensId)}`;
export const hrefReview = (id: string) => `#/projects/${encodeURIComponent(id)}/review`;

export function hrefCompare(id: string, base?: string, head?: string): string {
  const params = new URLSearchParams();
  if (base) params.set("base", base);
  if (head) params.set("head", head);
  const qs = params.toString();
  return `#/projects/${encodeURIComponent(id)}/compare${qs ? `?${qs}` : ""}`;
}
