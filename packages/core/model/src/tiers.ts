// The Tiers view's model: the System model folded into left-to-right columns, Frontend → Backend → Storage, plus External.
// Static facts only. A deployable (a browser app, a client program, a server, a Vercel function, a Cloudflare Worker) is a
// node. A library a deployable calls is folded into it: the edges that reach the outside through a library are inferred and
// name the library in `via`. Stores are the storage column; outside services are the external column.
import { edgeTargets } from "@insight/sdk";
import type { ProjectModel } from "./model.js";
import type { Site, SystemEdge, SystemExternal, SystemModel, SystemRoute } from "./system.js";

export type Tier = "frontend" | "backend" | "storage" | "external";

/** One box of the diagram: a deployable unit (frontend or backend), or an outside store or service (storage or external). */
export interface TierNode {
  id: string;
  label: string;
  tier: Tier;
  role?: "spa" | "client" | "server" | "function" | "worker";
  platform?: "browser" | "node" | "vercel" | "cloudflare";
  component?: string;
  path?: string;
  routes: number;
  /** The libraries folded into this deployable: every library its calls reach, sorted. */
  libraries: string[];
  /** The file and function counts of the System component the unit is, when it is one. The card's line shows them. */
  files?: number;
  functions?: number;
  /** Human-readable facts behind the classification, e.g. "route framework=worker", "wrangler.toml". */
  signals: string[];
  external?: SystemExternal;
}

/** One API or syscall of a tier edge (e.g. "fs.readFileSync", "fetch"), and how many of the edge's facts went through it. */
export interface TierApi {
  api: string;
  count: number;
}

export interface TierEdge {
  id: string;
  from: string;
  to: string;
  verb: "requests" | "reads" | "writes" | "opens" | "spawns";
  /** The short text on the edge, without its verb: the route labels of a request (two, then "+N"), the op of a store ("read",
   * "write", or the driver name), or the outside service's own label. */
  label: string;
  count: number;
  sites: Site[];
  confidence: "exact" | "inferred";
  /** The APIs and syscalls the edge's facts went through, sorted by API, each with the facts that went through it. For the panel:
   * the counts sum to the edge's count when every fact names its API. */
  apis: TierApi[];
  /** The libraries a folded edge came through, sorted. Absent for a direct edge. */
  via?: string[];
}

export interface TierModel {
  scope: string;
  columns: Array<{ tier: Tier; title: string; nodes: string[] }>;
  nodes: TierNode[];
  edges: TierEdge[];
  hidden: { libraries: string[]; unmatchedApi: number; dev: number };
  /** Set when the scope is not worth the Tiers view (fewer than two deployable units). The view falls back to Runtime. */
  reason?: string;
}

export interface TierOptions {
  tests?: boolean; // include the dev folders (scripts, tools, dev, bench, examples)
}

/** Folders of developer tooling: not part of the running system, hidden unless `tests` is set. */
const DEV_DIRS = /(^|\/)(scripts|tools|dev|bench|examples)(\/|$)/;
/** A dev-only edge is dropped when every site is in a dev folder and it has at most this many facts. */
const DEV_EDGE_MAX = 20;
const SITE_CAP = 20;
const TIER_ORDER: Tier[] = ["frontend", "backend", "storage", "external"];
const TIER_TITLE: Record<Tier, string> = { frontend: "Frontend", backend: "Backend", storage: "Storage", external: "External" };
const ROLE_RANK: Record<string, number> = { spa: 0, client: 1, server: 2, function: 3, worker: 4 };
/** Words that name no service: an env name or a Worker name made of only these says nothing about which Worker it means. */
const STOP_WORDS = new Set(["vite", "base", "url", "api", "public", "root", "origin", "host", "endpoint", "app"]);
const WRANGLER_FILES = ["wrangler.toml", "wrangler.json", "wrangler.jsonc"];
/** Build and tool config files, and a CRA dev proxy (setupProxy.js): an env read, a listen or a route there belongs to the build or dev tooling, not the app (vite.config.ts reads INSIGHT_API at build time). */
const CONFIG_FILE = /(^|\/)([^/]*\.config\.(c|m)?[jt]sx?|(vite|webpack|rollup|rspack|esbuild|tsup|babel|postcss|tailwind|jest|vitest|playwright|karma|next|nuxt|astro|svelte|setupProxy)\.[^/]*)$/;
/** Distinct route labels a request edge shows before "+N". Other edges show every distinct label of their merged facts (or one). */
const REQUEST_LABELS = 2;
const OTHER_LABELS = 3;
/** A UI framework's package. A UI import is only a signal: it makes a browser app only with a browser entry (see classification). */
const UI_IMPORT = /^(react-dom|vue|svelte|preact|solid-js)(\/|$)/;
/** A UI package's server subpath (react-dom/server, vue/server-renderer): rendering on the server, not a browser import. */
const SERVER_SUBPATH = /\/server(-renderer)?(\/|$)/;
const VERCEL_IMPORT = /^@vercel\//;
/** The page a browser app's folder holds: the project's own (Vite), or the public and src folders of CRA and webpack apps. */
const BROWSER_PAGES = ["index.html", "public/index.html", "src/index.html"] as const;
const ROUTE_PREFIX = "route:";
/** A server component's static folders: the pages and assets it serves itself. */
const STATIC_DIRS = ["public", "static", "www"];
const inStaticFolder = (file: string, compPath: string): boolean => {
  const prefix = compPath === "" ? "" : `${compPath}/`;
  return STATIC_DIRS.some((d) => file.startsWith(`${prefix}${d}/`));
};

type Role = NonNullable<TierNode["role"]>;
type Verb = TierEdge["verb"];
/** Where an env var is read: the file, and the function that reads it. */
interface EnvLoc {
  file: string;
  fn?: string;
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The words of a name, lower-cased, without stop-words: `VITE_STORAGE_BASE` → storage, `fixture-storage` → fixture, storage. */
function tokens(text: string): string[] {
  return text
    .split(/[^A-Za-z0-9]+/)
    .map((t) => t.toLowerCase())
    .filter((t) => t !== "" && !STOP_WORDS.has(t));
}

/** Sites sorted by file and line, without duplicates. */
function dedupeSites(sites: Site[]): Site[] {
  const seen = new Set<string>();
  const out: Site[] = [];
  for (const s of [...sites].sort((x, y) => cmp(x.file, y.file) || x.line - y.line || cmp(x.fn ?? "", y.fn ?? ""))) {
    const key = `${s.file}\0${s.line}\0${s.fn ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

/** The label of a merged edge: up to `cap` distinct labels, then how many more. */
function mergedLabel(parts: string[], cap: number): string {
  const sorted = [...new Set(parts)].sort(cmp);
  if (sorted.length <= cap) return sorted.join(", ");
  return `${sorted.slice(0, cap).join(", ")}, +${sorted.length - cap}`;
}

/**
 * Labels of a System edge, with their " ×n" counts removed and its verb dropped: "GET ×2, POST" → ["GET", "POST"], and
 * "spawns child_process.spawn" → ["child_process.spawn"]. A route that takes any method is labelled by its path alone
 * ("* /api/index" → "/api/index"): the request's own method is not in the System model.
 */
function labelParts(label: string, verb: string): string[] {
  return label
    .split(", ")
    .map((part) => part.replace(/ ×\d+$/, "").replace(/^\* /, "").replace(`${verb} `, ""))
    .filter((part) => part !== "");
}

/** The APIs and syscalls a System edge's facts went through, sorted, each with its fact count (evidence rows of one API add up). */
const apisOf = (e: SystemEdge): TierApi[] => {
  const counts = new Map<string, number>();
  for (const ev of e.evidence ?? []) counts.set(ev.api, (counts.get(ev.api) ?? 0) + ev.count);
  return [...counts].map(([api, count]) => ({ api, count })).sort((x, y) => cmp(x.api, y.api));
};

/**
 * The Tiers model of one System model. Pure and deterministic: the same inputs always give the same output. `sys` is the
 * System model of the scope (`systemModel(model, scope, { tests })`); pass the same `tests` value to both.
 */
export function tierModel(model: ProjectModel, sys: SystemModel, opts: TierOptions = {}): TierModel {
  const tests = opts.tests === true;
  const comps = new Map(sys.components.map((c) => [c.id, c] as const));
  const exts = new Map(sys.externals.map((x) => [x.id, x] as const));
  const files = new Set(model.files);
  // The component that owns a file or a label path: the longest component path that is a prefix of it, on a "/" boundary.
  // A map from each component path (the lowest id when two share one) is read at each "/" of the path, and memoized per path.
  const compAtPath = new Map<string, string>();
  for (const c of sys.components) {
    if (c.path === "") continue;
    const cur = compAtPath.get(c.path);
    if (cur === undefined || cmp(c.id, cur) < 0) compAtPath.set(c.path, c.id);
  }
  const ownerMemo = new Map<string, string | undefined>();
  const ownerOfPath = (path: string | undefined): string | undefined => {
    if (path === undefined) return undefined;
    if (ownerMemo.has(path)) return ownerMemo.get(path);
    let owner: string | undefined;
    let cur: string | undefined = path;
    while (cur !== undefined && cur !== "") {
      const hit = compAtPath.get(cur);
      if (hit !== undefined) {
        owner = hit;
        break;
      }
      const slash = cur.lastIndexOf("/");
      cur = slash < 0 ? undefined : cur.slice(0, slash);
    }
    ownerMemo.set(path, owner);
    return owner;
  };

  // Runtime facts: which slices run in a browser program, and which program runtime sits under which component.
  const runtimeById = new Map((sys.runtimes ?? []).map((r) => [r.id, r] as const));
  const sliceComponent = new Map((sys.slices ?? []).map((s) => [s.id, s.component] as const));
  const programComponent = new Map<string, string>();
  for (const rt of runtimeById.values()) {
    if (rt.kind !== "program") continue;
    const owner = ownerOfPath(rt.label);
    if (owner !== undefined) programComponent.set(rt.id, owner);
  }
  const isBrowserRuntime = (id: string): boolean => {
    let cur: string | undefined = id;
    for (let depth = 0; depth < 8 && cur !== undefined; depth++) {
      const rt = runtimeById.get(cur);
      if (rt === undefined) return false;
      if (rt.programKind === "browser") return true;
      cur = rt.parent;
    }
    return false;
  };
  // Collapse runtimes and slices to their component. A target that is neither a component nor an external is a resource.
  const resolveComponent = (id: string): string | undefined => {
    if (comps.has(id)) return id;
    const sliced = sliceComponent.get(id);
    if (sliced !== undefined) return comps.has(sliced) ? sliced : undefined;
    return programComponent.get(id);
  };
  const isImportOnly = (e: SystemEdge): boolean => /^imports( ×\d+)?$/.test(e.label);
  interface Link {
    e: SystemEdge;
    from: string;
    to: string;
  }
  const links: Link[] = [];
  for (const e of sys.edges) {
    const from = resolveComponent(e.from);
    const to = exts.has(e.to) ? e.to : resolveComponent(e.to);
    if (from === undefined || to === undefined || from === to) continue;
    links.push({ e, from, to });
  }

  // Facts the IR attaches to components: import specifiers, routes (with the wrangler name), listens, and env reads.
  const importsOf = new Map<string, Set<string>>();
  for (const edge of model.doc.edges) {
    // A type-only import is not code the component runs: it does not make a browser app or a Vercel function.
    if (edge.kind !== "packaging.import" || (edge.attrs as { typeOnly?: unknown } | undefined)?.typeOnly === true) continue;
    const text = edgeTargets(edge).unresolved?.text;
    const owner = ownerOfPath(model.fileOf(edge.from));
    if (text === undefined || owner === undefined) continue;
    const set = importsOf.get(owner) ?? new Set<string>();
    set.add(text);
    importsOf.set(owner, set);
  }
  const routesOf = new Map<string, SystemRoute[]>();
  for (const r of sys.routes) {
    const list = routesOf.get(r.component) ?? [];
    list.push(r);
    routesOf.set(r.component, list);
  }
  const routeAttrs = (r: SystemRoute): Record<string, unknown> => (model.byId.get(r.id.slice(ROUTE_PREFIX.length))?.attrs ?? {}) as Record<string, unknown>;
  const workerName = new Map<string, string>();
  const workerPlatform = new Set<string>();
  for (const r of sys.routes) {
    if (r.framework !== "worker") continue;
    const attrs = routeAttrs(r);
    if (typeof attrs.name === "string" && attrs.name !== "" && !workerName.has(r.component)) workerName.set(r.component, attrs.name);
    if (attrs.platform === "cloudflare") workerPlatform.add(r.component);
  }
  // A site set that is the app's own: no sites (unknown), or one site outside a build or tool config file.
  const appSite = (sites: Site[]): boolean => sites.length === 0 || sites.some((s) => !CONFIG_FILE.test(s.file));
  const listens = new Set(links.filter((l) => l.e.verb === "listens" && appSite(l.e.sites)).map((l) => l.from));
  // The routes that are the app's own: a route in a build or tool config file (a mock server in vite.config) is not one the
  // component serves. Every role below is decided on these, never on the routes of all sites.
  const appRoutesOf = new Map<string, SystemRoute[]>();
  for (const [id, list] of routesOf) appRoutesOf.set(id, list.filter((r) => appSite([r.site])));
  // A component that listens, or has a server route that is not an exported or dispatched handler, is a server of its own.
  // A listen or route in a config file does not count.
  const ownsServer = (id: string, rs: SystemRoute[]): boolean =>
    listens.has(id) || rs.some((r) => r.framework !== "export" && r.framework !== "dispatch" && appSite([r.site]));
  // A browser program's own components: the ones that own a file its runtime runs (the roots are "file#fn"). A slice of a
  // browser runtime in a component the browser only calls into (a backend, a library) does not make that component a frontend.
  // A root in the component's static folder (public, static, www) is a page the component serves itself: it makes a frontend
  // only for a component that owns no server. Any other root makes one.
  const browserComponents = new Set<string>();
  for (const s of sys.slices ?? []) {
    if (!isBrowserRuntime(s.runtime)) continue;
    const roots = (runtimeById.get(s.runtime)?.roots ?? []).map((root) => root.split("#")[0] ?? root).filter((file) => ownerOfPath(file) === s.component);
    if (roots.length === 0) continue;
    const served = roots.every((file) => inStaticFolder(file, comps.get(s.component)?.path ?? ""));
    if (!served || !ownsServer(s.component, appRoutesOf.get(s.component) ?? [])) browserComponents.add(s.component);
  }
  // Env reads by owner: each name with the places it is read (its file and its function). A build or tool config file's reads
  // are not the app's own, so they are dropped.
  const envLocsOf = new Map<string, Map<string, EnvLoc[]>>();
  for (const node of model.doc.nodes) {
    if (node.kind !== "effects.env.read") continue;
    const name = (node.attrs as { name?: unknown }).name;
    const file = model.fileOf(node.id);
    const owner = ownerOfPath(file);
    if (typeof name !== "string" || name === "" || owner === undefined || file === undefined || CONFIG_FILE.test(file)) continue;
    const byName = envLocsOf.get(owner) ?? new Map<string, EnvLoc[]>();
    const locs = byName.get(name) ?? [];
    locs.push({ file, fn: node.parent });
    byName.set(name, locs);
    envLocsOf.set(owner, byName);
  }
  // The functions each function calls (one hop of the call graph), for the env reads near a fetch.
  const callees = new Map<string, string[]>();
  for (const e of model.doc.edges) {
    if (e.kind !== "calls.call") continue;
    const list = callees.get(e.from) ?? [];
    list.push(...edgeTargets(e).nodes);
    callees.set(e.from, list);
  }

  // Components shown: dev folders are dropped unless `tests`. A dev component counts as hidden.
  let devCount = 0;
  const shown = new Set<string>();
  for (const c of sys.components) {
    if (!tests && DEV_DIRS.test(c.path)) {
      devCount++;
      continue;
    }
    shown.add(c.id);
  }

  // Classification, by priority: spa (a browser entry: a browser program, or an index.html), worker, function, server. A UI
  // import alone never makes a browser app: it is a signal that counts only with a browser entry, and a component with server
  // routes or listens is a backend whatever it imports. A client is a program entry that serves nothing and calls a backend.
  const role = new Map<string, Role>();
  const platform = new Map<string, NonNullable<TierNode["platform"]>>();
  const signals = new Map<string, string[]>();
  for (const c of sys.components) {
    if (!shown.has(c.id)) continue;
    const rs = appRoutesOf.get(c.id) ?? [];
    const imports = [...(importsOf.get(c.id) ?? [])].sort(cmp);
    const sig: string[] = [];
    const ui = imports.filter((t) => UI_IMPORT.test(t) && !SERVER_SUBPATH.test(t));
    const page = BROWSER_PAGES.find((p) => files.has(`${c.path}/${p}`));
    // Server evidence beats a page: a component that owns a server (a route of its own, or a listen) is not a browser app for
    // the index.html it serves statically. A page makes a browser app only for a component that owns no server.
    const pageSpa = page !== undefined && !ownsServer(c.id, rs);
    const browserEntry = browserComponents.has(c.id) || pageSpa;
    if (browserEntry) {
      role.set(c.id, "spa");
      platform.set(c.id, "browser");
      if (browserComponents.has(c.id)) sig.push("browser program");
      if (pageSpa && page !== undefined) sig.push(page);
      if (ui.length > 0) sig.push(`imports ${ui[0]}`);
    } else if (rs.some((r) => r.framework === "worker")) {
      role.set(c.id, "worker");
      sig.push("route framework=worker");
      const wrangler = WRANGLER_FILES.find((f) => files.has(`${c.path}/${f}`));
      if (wrangler !== undefined) sig.push(wrangler);
      if (wrangler !== undefined || workerPlatform.has(c.id)) platform.set(c.id, "cloudflare");
    } else if (rs.some((r) => r.framework === "export" || r.framework === "dispatch") && !(ownsServer(c.id, rs) && !imports.some((t) => VERCEL_IMPORT.test(t)))) {
      // A function: exported or dispatched handlers. A component that listens or has a server route of its own is a server
      // (below), unless it imports a Vercel helper that makes it a function.
      role.set(c.id, "function");
      for (const fw of [...new Set(rs.map((r) => r.framework))].sort(cmp)) sig.push(`route framework=${fw}`);
      const vercel = imports.filter((t) => VERCEL_IMPORT.test(t));
      if (vercel.length > 0) {
        platform.set(c.id, "vercel");
        sig.push(`imports ${vercel[0]}`);
      }
    } else if (rs.length > 0 || listens.has(c.id)) {
      role.set(c.id, "server");
      platform.set(c.id, "node");
      for (const fw of [...new Set(rs.map((r) => r.framework))].sort(cmp)) sig.push(`route framework=${fw}`);
      if (listens.has(c.id)) sig.push("listens");
    }
    if (sig.length > 0) signals.set(c.id, sig);
  }
  const backendRole = (id: string): boolean => {
    const r = role.get(id);
    return r === "server" || r === "function" || r === "worker";
  };
  // Clients are decided on the roles of the first pass alone, so the order the components come in cannot change the result:
  // two entries that call each other are both clients when both request a backend, whichever is visited first.
  const firstPass = new Set(role.keys());
  // The links by target and by source, in link order, so each component's scan is its own links alone.
  const linksTo = new Map<string, Link[]>();
  const linksFrom = new Map<string, Link[]>();
  for (const l of links) {
    const to = linksTo.get(l.to) ?? [];
    to.push(l);
    linksTo.set(l.to, to);
    const from = linksFrom.get(l.from) ?? [];
    from.push(l);
    linksFrom.set(l.from, from);
  }
  for (const c of sys.components) {
    if (!shown.has(c.id) || role.has(c.id) || !c.entry) continue;
    if ((appRoutesOf.get(c.id) ?? []).length > 0 || listens.has(c.id)) continue;
    const calledByDeployable = (linksTo.get(c.id) ?? []).some((l) => firstPass.has(l.from) && !isImportOnly(l.e));
    if (calledByDeployable) continue;
    const out = (linksFrom.get(c.id) ?? []).find((l) => (l.e.verb === "requests" || l.e.verb === "spawns") && backendRole(l.to));
    if (out === undefined) continue;
    role.set(c.id, "client");
    platform.set(c.id, "node");
    signals.set(c.id, ["program entry", `${out.e.verb} ${out.to}`]);
  }
  const isLibrary = (id: string): boolean => shown.has(id) && !role.has(id);
  const deployables = [...role.keys()].sort(cmp);
  const libraries = [...shown].filter(isLibrary).sort(cmp);

  // Adjacency: calls between shown components (the library closure), and every other fact out of a component.
  const callsOut = new Map<string, string[]>();
  const factsOut = new Map<string, Link[]>();
  for (const l of links) {
    if (!shown.has(l.from)) continue;
    // A call to an outside service is a fact out of the component (drawn as a request), not a call into the library closure.
    if (l.e.verb === "calls" && isImportOnly(l.e)) continue;
    if (l.e.verb === "calls" && !exts.has(l.to)) {
      if (!shown.has(l.to)) continue;
      const calls = callsOut.get(l.from) ?? [];
      calls.push(l.to);
      callsOut.set(l.from, calls);
    } else {
      const facts = factsOut.get(l.from) ?? [];
      facts.push(l);
      factsOut.set(l.from, facts);
    }
  }

  // The tier verb of one fact into its target, or undefined when the fact is not drawn (resources, processes, config, api).
  const verbFor = (e: SystemEdge, to: string): Verb | undefined => {
    const ext = exts.get(to);
    if (ext !== undefined) {
      if (ext.category === "store" || ext.category === "filesystem") {
        return e.verb === "reads" || e.verb === "writes" || e.verb === "opens" ? e.verb : undefined;
      }
      if (ext.category === "service" || ext.category === "worker") {
        if (to.startsWith("listen:") || to === "dynamic-url" || to.startsWith("config:")) return undefined;
        if (e.verb === "reads") return "reads";
        if (e.verb === "spawns") return "spawns";
        if (e.verb === "writes" || e.verb === "requests" || e.verb === "calls" || e.verb === "opens") return "requests";
      }
      return undefined;
    }
    if (!role.has(to)) return undefined;
    if (e.verb === "requests") return "requests";
    if (e.verb === "spawns") return "spawns";
    return undefined;
  };

  interface Candidate {
    from: string;
    to: string;
    verb: Verb;
    parts: string[];
    count: number;
    sites: Site[];
    confidence: "exact" | "inferred";
    via: string[];
    apis: TierApi[];
  }
  const candidates: Candidate[] = [];
  const devEdges = new Set<string>();
  const reached = new Map<string, string[]>();
  for (const d of deployables) {
    // Breadth-first over calls into libraries: each library reached keeps the path that reached it.
    const path = new Map<string, string[]>([[d, []]]);
    const queue = [d];
    for (let i = 0; i < queue.length; i++) {
      const cur = queue[i] as string;
      for (const next of callsOut.get(cur) ?? []) {
        if (path.has(next) || !isLibrary(next)) continue;
        path.set(next, [...(path.get(cur) ?? []), next]);
        queue.push(next);
      }
    }
    reached.set(d, [...path.keys()].filter((k) => k !== d).sort(cmp));
    for (const [member, via] of path) {
      for (const l of factsOut.get(member) ?? []) {
        const verb = verbFor(l.e, l.to);
        if (verb === undefined || l.to === d) continue;
        // A browser program has no local disk and no database driver: a fact a folded library brings (not the unit's own) is dropped.
        if (member !== d && role.get(d) === "spa" && (exts.get(l.to)?.category === "filesystem" || verb === "opens")) continue;
        if (!tests && l.e.sites.length > 0 && l.e.count <= DEV_EDGE_MAX && l.e.sites.every((s) => DEV_DIRS.test(s.file))) {
          devEdges.add(l.e.id);
          continue;
        }
        // A store's label is its op, not its API names (those go in `apis`): "read", "write", or the driver an open names.
        const ext = exts.get(l.to);
        const store = ext !== undefined && (ext.category === "store" || ext.category === "filesystem");
        const parts = store && verb !== "opens" ? [verb === "reads" ? "read" : "write"] : labelParts(l.e.label, verb);
        candidates.push({
          from: d,
          to: l.to,
          verb,
          parts,
          count: l.e.count,
          sites: l.e.sites,
          confidence: member === d ? l.e.confidence : "inferred",
          via: [...via],
          apis: apisOf(l.e),
        });
      }
    }
  }

  // Environment heuristic: a browser app that GETs a URL from an env var reads the Worker whose name or path shares a word with
  // it. A word counts only when it is the unit's own: a word shared by two or more deployables (`apps`, `acme`) names no one
  // service. Among the app's env names that match, the most shared words win, then a name read near a fetch site (in its file,
  // or in a function the fetch's function calls), then the alphabetically first.
  const nameOfUnit = (d: string): string => workerName.get(d) ?? comps.get(d)?.label ?? d;
  const unitCount = new Map<string, number>();
  for (const d of deployables) {
    for (const t of new Set([...tokens(nameOfUnit(d)), ...tokens(comps.get(d)?.path ?? "")])) unitCount.set(t, (unitCount.get(t) ?? 0) + 1);
  }
  const ownWords = (text: string): Set<string> => new Set(tokens(text).filter((t) => (unitCount.get(t) ?? 0) < 2));
  const workers = deployables.filter((d) => role.get(d) === "worker");
  for (const d of deployables) {
    if (role.get(d) !== "spa") continue;
    const byName = envLocsOf.get(d) ?? new Map<string, EnvLoc[]>();
    for (const l of factsOut.get(d) ?? []) {
      if (l.e.verb !== "reads" || !(l.to === "dynamic-url" || l.to.startsWith("config:"))) continue;
      const names = l.to.startsWith("config:") ? [l.to.slice("config:".length)] : [...byName.keys()].sort(cmp);
      const siteFiles = new Set(l.e.sites.map((s) => s.file));
      const siteFns = l.e.sites.map((s) => s.fn).filter((f): f is string => f !== undefined);
      const nearFns = new Set([...siteFns, ...siteFns.flatMap((f) => callees.get(f) ?? [])]);
      for (const w of workers) {
        const want = ownWords(`${nameOfUnit(w)} ${comps.get(w)?.path ?? ""}`);
        let best: { name: string; score: number; near: boolean } | undefined;
        for (const name of names) {
          const score = [...ownWords(name)].filter((t) => want.has(t)).length;
          if (score === 0) continue;
          const near = (byName.get(name) ?? []).some((loc) => siteFiles.has(loc.file) || (loc.fn !== undefined && nearFns.has(loc.fn)));
          if (best === undefined || score > best.score || (score === best.score && near && !best.near)) best = { name, score, near };
        }
        if (best === undefined) continue;
        candidates.push({
          from: d,
          to: w,
          verb: "reads",
          parts: [`GET via ${best.name}`],
          count: l.e.count,
          sites: l.e.sites,
          confidence: "inferred",
          via: [],
          apis: apisOf(l.e),
        });
      }
    }
  }

  // Merge the facts of one (from, verb, to): counts add, sites union, a folded fact makes the edge inferred.
  interface Merged {
    from: string;
    to: string;
    verb: Verb;
    parts: string[];
    count: number;
    sites: Site[];
    inferred: boolean;
    via: Set<string>;
    apis: Map<string, number>;
  }
  const merged = new Map<string, Merged>();
  for (const c of candidates) {
    const key = `${c.from}\0${c.verb}\0${c.to}`;
    const m = merged.get(key) ?? { from: c.from, to: c.to, verb: c.verb, parts: [], count: 0, sites: [], inferred: false, via: new Set<string>(), apis: new Map<string, number>() };
    m.parts.push(...c.parts);
    m.count += c.count;
    m.sites.push(...c.sites);
    m.inferred ||= c.confidence === "inferred";
    for (const v of c.via) m.via.add(v);
    for (const a of c.apis) m.apis.set(a.api, (m.apis.get(a.api) ?? 0) + a.count);
    merged.set(key, m);
  }
  const edges: TierEdge[] = [...merged.values()]
    .map((m): TierEdge => ({
      id: `${m.from}>${m.verb}>${m.to}`,
      from: m.from,
      to: m.to,
      verb: m.verb,
      label: mergedLabel(m.parts, m.verb === "requests" ? REQUEST_LABELS : OTHER_LABELS),
      count: m.count,
      sites: dedupeSites(m.sites).slice(0, SITE_CAP),
      confidence: m.inferred ? "inferred" : "exact",
      apis: [...m.apis].map(([api, count]) => ({ api, count })).sort((x, y) => cmp(x.api, y.api)),
      ...(m.via.size > 0 ? { via: [...m.via].sort(cmp) } : {}),
    }))
    .sort((x, y) => cmp(x.from, y.from) || cmp(x.to, y.to) || cmp(x.verb, y.verb) || cmp(x.id, y.id));

  // Nodes: every deployable, then every outside store or service an edge reaches (storage is `store` and `filesystem`).
  const drawnExternals = [...new Set(edges.map((e) => e.to).filter((id) => exts.has(id)))].sort(cmp);
  const nodes: TierNode[] = [];
  for (const d of deployables) {
    const r = role.get(d) as Role;
    const c = comps.get(d);
    const label = r === "worker" ? (workerName.get(d) ?? c?.label ?? d) : (c?.label ?? d);
    const plat = platform.get(d);
    nodes.push({
      id: d,
      label,
      tier: r === "spa" || r === "client" ? "frontend" : "backend",
      role: r,
      ...(plat !== undefined ? { platform: plat } : {}),
      component: d,
      ...(c !== undefined ? { path: c.path } : {}),
      ...(c?.files !== undefined && c.functions !== undefined ? { files: c.files, functions: c.functions } : {}),
      routes: (routesOf.get(d) ?? []).length,
      libraries: reached.get(d) ?? [],
      signals: signals.get(d) ?? [],
    });
  }
  for (const id of drawnExternals) {
    const x = exts.get(id) as SystemExternal;
    const storage = x.category === "store" || x.category === "filesystem";
    nodes.push({
      id,
      label: x.category === "filesystem" ? "Local disk" : x.label,
      tier: storage ? "storage" : "external",
      routes: 0,
      libraries: [],
      signals: [`category ${x.category}`],
      external: x,
    });
  }
  const rankOf = (n: TierNode): number => (n.role === undefined ? 5 : (ROLE_RANK[n.role] as number));
  nodes.sort((x, y) => rankOf(x) - rankOf(y) || cmp(x.label, y.label) || cmp(x.id, y.id));

  const columns = TIER_ORDER.map((tier) => ({ tier, title: TIER_TITLE[tier], nodes: nodes.filter((n) => n.tier === tier).map((n) => n.id) }));
  const unmatchedApi = sys.externals.filter((x) => x.category === "api").length;
  const dev = devCount + devEdges.size;
  const out: TierModel = {
    scope: sys.scope,
    columns,
    nodes,
    edges,
    hidden: { libraries, unmatchedApi, dev },
  };
  if (deployables.length < 2) out.reason = `not enough deployable units at this scope (${deployables.length} found, need 2)`;
  return out;
}
