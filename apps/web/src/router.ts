/** The tabs every project has. Any other tab id is a lens id. */
export const BUILTIN_TABS = ["overview", "source", "flow", "findings", "compare", "review"] as const;

export type Route =
  | { name: "projects" }
  | {
      name: "workspace";
      id: string;
      /** The view: overview, source, flow, findings, compare, review, or a lens id. */
      tab: string;
      /** What the tabs show: "" for the whole project, otherwise a folder or file path. */
      scope: string;
      line?: number;
      /** The function open in the flow tab (its IR id). */
      fn?: string;
      base?: string;
      head?: string;
    }
  | { name: "unknown" };

export interface ViewOptions {
  scope?: string;
  line?: number;
  fn?: string;
  base?: string;
  head?: string;
}

/**
 * Parses a hash route. The canonical form is
 * #/projects/<id>/view/<tab>?scope=<folder or file>&line=<n>&fn=<function>.
 * Older links are still understood: #/projects/<id>, .../lenses/<lens>, .../compare, .../review
 * and .../files/<path>?line=<n>.
 */
export function parseRoute(hash: string): Route {
  const raw = hash.replace(/^#/, "");
  const at = raw.indexOf("?");
  const path = at === -1 ? raw : raw.slice(0, at);
  const query = new URLSearchParams(at === -1 ? "" : raw.slice(at + 1));
  const parts = path.split("/").filter((p) => p.length > 0).map((p) => decodeURIComponent(p));
  if (parts.length === 0 || (parts[0] === "projects" && parts.length === 1)) return { name: "projects" };
  if (parts[0] !== "projects") return { name: "unknown" };
  const id = parts[1] as string;
  const lineOf = () => {
    const n = Number(query.get("line"));
    return Number.isInteger(n) && n > 0 ? n : undefined;
  };
  const opt = <K extends string>(key: K, value: string | null | undefined) => (value ? ({ [key]: value } as Record<K, string>) : {});

  if (parts.length === 2) return { name: "workspace", id, tab: "overview", scope: "" };
  if (parts[2] === "view" && parts.length <= 4) {
    const line = lineOf();
    return {
      name: "workspace",
      id,
      tab: parts[3] ?? "overview",
      scope: query.get("scope") ?? "",
      ...(line ? { line } : {}),
      ...opt("fn", query.get("fn")),
      ...opt("base", query.get("base")),
      ...opt("head", query.get("head")),
    };
  }
  if (parts[2] === "lenses" && parts.length === 4) return { name: "workspace", id, tab: parts[3] as string, scope: "" };
  if (parts[2] === "compare" && parts.length === 3) {
    return { name: "workspace", id, tab: "compare", scope: "", ...opt("base", query.get("base")), ...opt("head", query.get("head")) };
  }
  if (parts[2] === "review" && parts.length === 3) return { name: "workspace", id, tab: "review", scope: "" };
  if (parts[2] === "files") {
    const file = parts.slice(3).join("/");
    const line = lineOf();
    return { name: "workspace", id, tab: "source", scope: file, ...(file && line ? { line } : {}) };
  }
  return { name: "unknown" };
}

const enc = encodeURIComponent;

/** A link to one view of a project. The scope, line and function ride in the query. */
export function hrefView(id: string, tab: string, opts: ViewOptions = {}): string {
  const params = new URLSearchParams();
  if (opts.scope) params.set("scope", opts.scope);
  if (opts.line) params.set("line", String(opts.line));
  if (opts.fn) params.set("fn", opts.fn);
  if (opts.base) params.set("base", opts.base);
  if (opts.head) params.set("head", opts.head);
  const qs = params.toString();
  return `#/projects/${enc(id)}/view/${enc(tab)}${qs ? `?${qs}` : ""}`;
}

export const hrefProject = (id: string) => `#/projects/${enc(id)}`;
export const hrefLens = (id: string, lensId: string, scope?: string) => hrefView(id, lensId, { ...(scope ? { scope } : {}) });
export const hrefReview = (id: string) => hrefView(id, "review");
export const hrefCompare = (id: string, base?: string, head?: string) => hrefView(id, "compare", { ...(base ? { base } : {}), ...(head ? { head } : {}) });

/** A link to the source of a file, optionally at a line (1-based). */
export const hrefFile = (id: string, path?: string, line?: number) =>
  hrefView(id, "source", { ...(path ? { scope: path } : {}), ...(path && line ? { line } : {}) });

/** A link to the flow chart of a file, optionally opened on one function. */
export const hrefFlow = (id: string, path: string, fn?: string) => hrefView(id, "flow", { scope: path, ...(fn ? { fn } : {}) });

/** True when `path` is `scope` itself or lies under it. The empty scope holds everything. */
export const inScope = (path: string, scope: string) => scope === "" || path === scope || path.startsWith(`${scope}/`);
