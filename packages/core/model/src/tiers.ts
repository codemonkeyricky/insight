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
  /** Human-readable facts behind the classification, e.g. "route framework=worker", "wrangler.toml". */
  signals: string[];
  external?: SystemExternal;
}

export interface TierEdge {
  id: string;
  from: string;
  to: string;
  verb: "requests" | "reads" | "writes" | "opens" | "spawns";
  label: string;
  count: number;
  sites: Site[];
  confidence: "exact" | "inferred";
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
const UI_IMPORT = /^(react-dom|vue|svelte|preact|solid-js)(\/|$)/;
const VERCEL_IMPORT = /^@vercel\//;
const ROUTE_PREFIX = "route:";

type Role = NonNullable<TierNode["role"]>;
type Verb = TierEdge["verb"];

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

/** The label of a merged edge: up to three distinct labels, then how many more. */
function mergedLabel(parts: string[]): string {
  const sorted = [...new Set(parts)].sort(cmp);
  if (sorted.length <= 3) return sorted.join(", ");
  return `${sorted.slice(0, 3).join(", ")}, +${sorted.length - 3}`;
}

/**
 * Labels of a System edge, with their " ×n" counts removed: "GET ×2, POST" → ["GET", "POST"]. A route that takes any method
 * is labelled by its path alone ("* /api/index" → "/api/index"): the request's own method is not in the System model.
 */
function labelParts(label: string): string[] {
  return label.split(", ").map((part) => part.replace(/ ×\d+$/, "").replace(/^\* /, ""));
}

/**
 * The Tiers model of one System model. Pure and deterministic: the same inputs always give the same output. `sys` is the
 * System model of the scope (`systemModel(model, scope, { tests })`); pass the same `tests` value to both.
 */
export function tierModel(model: ProjectModel, sys: SystemModel, opts: TierOptions = {}): TierModel {
  const tests = opts.tests === true;
  const comps = new Map(sys.components.map((c) => [c.id, c] as const));
  const exts = new Map(sys.externals.map((x) => [x.id, x] as const));
  const files = new Set(model.files);
  const byPathLength = sys.components.filter((c) => c.path !== "").sort((a, b) => b.path.length - a.path.length || cmp(a.id, b.id));

  // The component that owns a file or a label path: the longest component path that is a prefix of it.
  const ownerOfPath = (path: string | undefined): string | undefined => {
    if (path === undefined) return undefined;
    return byPathLength.find((c) => path === c.path || path.startsWith(`${c.path}/`))?.id;
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
  // A browser program's own components: the ones that own a file its runtime runs (the roots are "file#fn"). A slice of a
  // browser runtime in a component the browser only calls into (a backend, a library) does not make that component a frontend.
  const browserComponents = new Set<string>();
  for (const s of sys.slices ?? []) {
    if (!isBrowserRuntime(s.runtime)) continue;
    const roots = runtimeById.get(s.runtime)?.roots ?? [];
    if (roots.some((root) => ownerOfPath(root.split("#")[0]) === s.component)) browserComponents.add(s.component);
  }

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
    if (edge.kind !== "packaging.import") continue;
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
  const listens = new Set(links.filter((l) => l.e.verb === "listens").map((l) => l.from));
  const envNamesOf = new Map<string, Set<string>>();
  for (const node of model.doc.nodes) {
    if (node.kind !== "effects.env.read") continue;
    const name = (node.attrs as { name?: unknown }).name;
    const owner = ownerOfPath(model.fileOf(node.id));
    if (typeof name !== "string" || name === "" || owner === undefined) continue;
    const set = envNamesOf.get(owner) ?? new Set<string>();
    set.add(name);
    envNamesOf.set(owner, set);
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

  // Classification, by priority: spa, worker, function, server. A client is a program entry that serves nothing and calls a backend.
  const role = new Map<string, Role>();
  const platform = new Map<string, NonNullable<TierNode["platform"]>>();
  const signals = new Map<string, string[]>();
  for (const c of sys.components) {
    if (!shown.has(c.id)) continue;
    const rs = routesOf.get(c.id) ?? [];
    const imports = [...(importsOf.get(c.id) ?? [])].sort(cmp);
    const sig: string[] = [];
    const ui = imports.filter((t) => UI_IMPORT.test(t));
    if (browserComponents.has(c.id) || files.has(`${c.path}/index.html`) || ui.length > 0) {
      role.set(c.id, "spa");
      platform.set(c.id, "browser");
      if (browserComponents.has(c.id)) sig.push("browser program");
      if (files.has(`${c.path}/index.html`)) sig.push("index.html");
      if (ui.length > 0) sig.push(`imports ${ui[0]}`);
    } else if (rs.some((r) => r.framework === "worker")) {
      role.set(c.id, "worker");
      sig.push("route framework=worker");
      const wrangler = WRANGLER_FILES.find((f) => files.has(`${c.path}/${f}`));
      if (wrangler !== undefined) sig.push(wrangler);
      if (wrangler !== undefined || workerPlatform.has(c.id)) platform.set(c.id, "cloudflare");
    } else if (rs.some((r) => r.framework === "export" || r.framework === "dispatch")) {
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
  for (const c of sys.components) {
    if (!shown.has(c.id) || role.has(c.id) || !c.entry) continue;
    if ((routesOf.get(c.id) ?? []).length > 0 || listens.has(c.id)) continue;
    const calledByDeployable = links.some((l) => l.to === c.id && role.has(l.from) && !isImportOnly(l.e));
    if (calledByDeployable) continue;
    const out = links.find((l) => l.from === c.id && (l.e.verb === "requests" || l.e.verb === "spawns") && backendRole(l.to));
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
    if (l.e.verb === "calls") {
      if (isImportOnly(l.e) || !shown.has(l.to)) continue;
      callsOut.set(l.from, [...(callsOut.get(l.from) ?? []), l.to]);
    } else {
      factsOut.set(l.from, [...(factsOut.get(l.from) ?? []), l]);
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
    label: string;
    count: number;
    sites: Site[];
    confidence: "exact" | "inferred";
    via: string[];
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
        // A browser program has no local disk and no database driver: a folded library's fs or DB facts are not its own.
        if (role.get(d) === "spa" && (exts.get(l.to)?.category === "filesystem" || verb === "opens")) continue;
        if (!tests && l.e.sites.length > 0 && l.e.count <= DEV_EDGE_MAX && l.e.sites.every((s) => DEV_DIRS.test(s.file))) {
          devEdges.add(l.e.id);
          continue;
        }
        candidates.push({
          from: d,
          to: l.to,
          verb,
          label: l.e.label,
          count: l.e.count,
          sites: l.e.sites,
          confidence: member === d ? l.e.confidence : "inferred",
          via: [...via],
        });
      }
    }
  }

  // Environment heuristic: a browser app that GETs a URL from an env var reads the Worker whose name or path shares a word with it.
  const workers = deployables.filter((d) => role.get(d) === "worker");
  for (const d of deployables) {
    if (role.get(d) !== "spa") continue;
    for (const l of factsOut.get(d) ?? []) {
      if (l.e.verb !== "reads" || !(l.to === "dynamic-url" || l.to.startsWith("config:"))) continue;
      const names = l.to.startsWith("config:") ? [l.to.slice("config:".length)] : [...(envNamesOf.get(d) ?? [])].sort(cmp);
      for (const w of workers) {
        const want = new Set([...tokens(workerName.get(w) ?? ""), ...tokens(comps.get(w)?.path ?? "")]);
        const name = names.find((n) => tokens(n).some((t) => want.has(t)));
        if (name === undefined) continue;
        candidates.push({ from: d, to: w, verb: "reads", label: `GET via ${name}`, count: l.e.count, sites: l.e.sites, confidence: "inferred", via: [] });
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
  }
  const merged = new Map<string, Merged>();
  for (const c of candidates) {
    const key = `${c.from}\0${c.verb}\0${c.to}`;
    const m = merged.get(key) ?? { from: c.from, to: c.to, verb: c.verb, parts: [], count: 0, sites: [], inferred: false, via: new Set<string>() };
    m.parts.push(...labelParts(c.label));
    m.count += c.count;
    m.sites.push(...c.sites);
    m.inferred ||= c.confidence === "inferred";
    for (const v of c.via) m.via.add(v);
    merged.set(key, m);
  }
  const edges: TierEdge[] = [...merged.values()]
    .map((m): TierEdge => ({
      id: `${m.from}>${m.verb}>${m.to}`,
      from: m.from,
      to: m.to,
      verb: m.verb,
      label: mergedLabel(m.parts),
      count: m.count,
      sites: dedupeSites(m.sites).slice(0, SITE_CAP),
      confidence: m.inferred ? "inferred" : "exact",
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
