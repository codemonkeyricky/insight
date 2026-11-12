import { RETIRED_LENSES } from "./scopeLenses";
import { isRefName, isRepoName } from "./hostedRepo";

/**
 * The tabs every project has. Any other tab id is a lens id. The Source and Findings tabs are gone: their old URLs
 * redirect to Overview (see redirectFor), and their links open the code pane instead.
 */
export const BUILTIN_TABS = ["overview", "flow", "arch", "compare", "review"] as const;

/** The views that were tabs once and now redirect to Overview, keeping the scope and line of the link. */
const RETIRED_VIEWS: readonly string[] = ["source", "findings"];

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
      /** The flow tab's canvas shows only the functions each thread starts in. */
      roots?: boolean;
      /** The overview tab's full page (`full=1`), rather than the flow sheet with its title block. */
      full?: boolean;
      /** The flow tab with the findings layer on, drawing only the findings of this kind (`kind=`). */
      kind?: string;
      base?: string;
      head?: string;
    }
  /** A hosted repository: its latest index (no sha), or the index at one commit. Only the hosted build opens it. */
  | { name: "hosted"; owner: string; repo: string; sha?: string; ref?: string }
  | { name: "unknown" };

export interface ViewOptions {
  scope?: string;
  line?: number;
  fn?: string;
  /** The flow tab's roots-only canvas, on by default. Written as `roots=0` when false, and left out when true. */
  roots?: boolean;
  /** The overview tab's full page. Written as `full=1`, and only when true. */
  full?: boolean;
  /** The findings layer of the flow tab, for one kind of finding. Written as `kind=`. */
  kind?: string;
  base?: string;
  head?: string;
}

/**
 * Parses a hash route. The canonical form is
 * #/projects/<id>/view/<tab>?scope=<folder or file>&line=<n>&fn=<function>.
 * Older links are still understood: #/projects/<id>, .../lenses/<lens>, .../compare, .../review
 * and .../files/<path>?line=<n>. A `mode` parameter from the retired flow modes is ignored.
 */
export function parseRoute(hash: string): Route {
  const raw = hash.replace(/^#/, "");
  const at = raw.indexOf("?");
  const path = at === -1 ? raw : raw.slice(0, at);
  const query = new URLSearchParams(at === -1 ? "" : raw.slice(at + 1));
  const parts = path.split("/").filter((p) => p.length > 0).map((p) => decodeURIComponent(p));
  if (parts.length === 0 || (parts[0] === "projects" && parts.length === 1)) return { name: "projects" };
  if (parts[0] === "gh") return parseHostedRoute(parts);
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
      // The flow tab's map is roots-only unless the link says roots=0.
      ...(parts[3] === "flow" ? { roots: query.get("roots") !== "0" } : {}),
      ...(query.get("full") === "1" ? { full: true } : {}),
      ...opt("kind", query.get("kind")),
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

/**
 * #/gh/<owner>/<repo>, #/gh/<owner>/<repo>@<sha> (40 hex) or #/gh/<owner>/<repo>@<ref>: the latest index of a branch or tag.
 * A ref with a slash is written `@build%2Fx`; a raw slash (`@build/x`) is read as part of the ref too, since nothing else
 * follows the repository in this route. Names are read in lowercase, as the storage holds them; a ref keeps its case.
 */
function parseHostedRoute(parts: string[]): Route {
  if (parts.length < 3) return { name: "unknown" };
  const owner = (parts[1] ?? "").toLowerCase();
  const last = parts.slice(2).join("/");
  const at = last.indexOf("@");
  if (at === -1 && parts.length !== 3) return { name: "unknown" };
  const repo = (at === -1 ? last : last.slice(0, at)).toLowerCase();
  if (!isRepoName(owner, repo)) return { name: "unknown" };
  if (at === -1) return { name: "hosted", owner, repo };
  const tail = last.slice(at + 1);
  if (/^[0-9a-f]{40}$/i.test(tail)) return { name: "hosted", owner, repo, sha: tail.toLowerCase() };
  if (tail === "" || !isRefName(tail)) return { name: "unknown" };
  return { name: "hosted", owner, repo, ref: tail };
}

const enc = encodeURIComponent;

/** A link to one view of a project. The scope, line and function ride in the query. */
export function hrefView(id: string, tab: string, opts: ViewOptions = {}): string {
  const params = new URLSearchParams();
  if (opts.scope) params.set("scope", opts.scope);
  if (opts.line) params.set("line", String(opts.line));
  if (opts.fn) params.set("fn", opts.fn);
  if (opts.roots === true) params.set("roots", "1");
  if (opts.roots === false) params.set("roots", "0");
  if (opts.full) params.set("full", "1");
  if (opts.kind) params.set("kind", opts.kind);
  if (opts.base) params.set("base", opts.base);
  if (opts.head) params.set("head", opts.head);
  const qs = params.toString();
  return `#/projects/${enc(id)}/view/${enc(tab)}${qs ? `?${qs}` : ""}`;
}

/**
 * Where a route must be sent instead of shown, or undefined when it is shown as it is. A retired lens tab (the
 * execution lens) goes to the flow tab, whose canvas draws the same threads, coroutines and functions, for the same scope.
 * The retired Source and Findings views go to Overview. The scope and line ride along, so a link to a file's line still
 * opens that file in the code pane.
 */
export function redirectFor(route: Route): string | undefined {
  if (route.name !== "workspace") return undefined;
  if (RETIRED_LENSES.includes(route.tab)) return hrefView(route.id, "flow", { scope: route.scope });
  if (RETIRED_VIEWS.includes(route.tab)) return hrefView(route.id, "overview", { scope: route.scope, ...(route.line ? { line: route.line } : {}) });
  return undefined;
}

export const hrefProject = (id: string) => `#/projects/${enc(id)}`;
export const hrefLens = (id: string, lensId: string, scope?: string) => hrefView(id, lensId, { ...(scope ? { scope } : {}) });
export const hrefReview = (id: string) => hrefView(id, "review");
export const hrefCompare = (id: string, base?: string, head?: string) => hrefView(id, "compare", { ...(base ? { base } : {}), ...(head ? { head } : {}) });

/**
 * A link to a file, optionally at a line (1-based). It opens the file in the code pane on the given tab, which is the flow
 * tab unless a page (such as Arch) passes its own, so the link keeps that tab. The file is the scope, as it was for the old
 * Source tab, and the line opens the code pane there.
 */
export const hrefFile = (id: string, path?: string, line?: number, tab = "flow") =>
  hrefView(id, tab, { ...(path ? { scope: path } : {}), ...(path && line ? { line } : {}) });

/** A link to the flow chart of a file, optionally opened on one function. */
export const hrefFlow = (id: string, path: string, fn?: string) => hrefView(id, "flow", { scope: path, ...(fn ? { fn } : {}) });

/** True when `path` is `scope` itself or lies under it. The empty scope holds everything. */
export const inScope = (path: string, scope: string) => scope === "" || path === scope || path.startsWith(`${scope}/`);
