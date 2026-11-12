// The System view's model: one scope's components, the HTTP routes they serve, the outside systems they touch, and the
// verbs between them. Computed from the whole-project model, so a scope is a closed world: a fact that leaves it is not drawn.
import type { IRNode, NodeId, Span } from "@insight/ir";
import { isNoisePath } from "@insight/flow";
import { edgeTargets } from "@insight/sdk";
import type { ProjectModel } from "./model.js";
import { inScope, normalizeScope, ROOT_SCOPE } from "./scope.js";
import { classifyHost } from "./services.js";
import { scopeView } from "./view.js";

export interface SystemModel {
  scope: string; // "" = project root
  components: SystemComponent[]; // the scope's children (packages at root when package.json roots exist, else folders/files), plus "(scope)" when the scope is one file
  routes: SystemRoute[]; // served endpoints inside the scope
  externals: SystemExternal[];
  edges: SystemEdge[];
  stages: string[][]; // component ids per column, left → right; externals are drawn after
  via?: string; // set when the scope held one code folder, so its children are shown instead: the folder, relative to the scope ("src")
}
export interface SystemOptions {
  tests?: boolean; // include tests, fixtures and samples (hidden by default)
}
export interface Site {
  file: string;
  line: number;
  fn?: string;
} // fn = model function id (Flow tab fn= value)
export interface SystemComponent {
  id: string;
  label: string;
  path: string;
  kind: "package" | "folder" | "file";
  files: number;
  functions: number;
  entry: boolean;
}
export interface SystemRoute {
  id: string;
  component: string;
  framework: string;
  method: string;
  path: string;
  handler?: string;
  site: Site;
}
export interface SystemExternal {
  id: string;
  label: string;
  category: "service" | "store" | "api" | "process" | "filesystem" | "config" | "worker";
  host?: string;
  command?: string;
  names?: string[];
}
export interface SystemEdge {
  id: string;
  from: string;
  to: string;
  verb: "calls" | "reads" | "writes" | "runs" | "requests" | "spawns" | "posts" | "produces" | "feeds"; // produces and feeds: the Pipeline view
  label: string; // e.g. "PUT ×5", "GET", "POST /api/index", "git", "3 vars"
  count: number;
  sites: Site[]; // up to 20 sites
  confidence: "exact" | "inferred";
}

/** Sites kept per edge. The count still covers every fact. */
const SITE_CAP = 20;

/** Directories whose package.json files describe fixtures, not packages of the project (same rule as the Arch tab). */
const NOT_A_PACKAGE = /(^|\/)(node_modules|test|tests|fixtures|__fixtures__|samples)(\/|$)/;

const EMPTY_LABEL = "(scope)";

export interface Comp {
  id: string;
  label: string;
  path: string;
  kind: SystemComponent["kind"];
}

interface Bucket {
  from: string;
  to: string;
  verb: SystemEdge["verb"];
  tags: Map<string, number>;
  count: number;
  sites: Site[];
  exact: boolean;
  names?: Set<string>;
  importOnly?: boolean;
}

/** Folders a scope may pass through to reach its children, a guard against a chain of single folders. */
const MAX_VIA = 8;

/**
 * The System model of one scope. A scope outside the project, or with no files, gives an empty model. Tests, fixtures and
 * samples (the Flow tab's noise rule) are left out unless `opts.tests` is set. When the scope holds one folder of code
 * (apps/hosted → src), that folder's children are shown and `via` names the folder.
 */
export function systemModel(model: ProjectModel, scopePath: string, opts: SystemOptions = {}): SystemModel {
  const scope = normalizeScope(scopePath);
  const tests = opts.tests === true || isNoisePath(scope) || isNoisePath(`${scope}/x`);
  let inner = scope;
  const via: string[] = [];
  for (let i = 0; ; i++) {
    const sys = buildSystem(model, inner, tests);
    const only = sys.components.length === 1 ? sys.components[0] : undefined;
    if (only !== undefined && only.kind === "folder" && only.path !== inner && i < MAX_VIA) {
      via.push(only.path.slice(inner === ROOT_SCOPE ? 0 : inner.length + 1));
      inner = only.path;
      continue;
    }
    const rel = scope === ROOT_SCOPE ? inner : inner.slice(scope.length + 1);
    return { ...sys, scope, ...(inner !== scope ? { via: rel } : {}) };
  }
}

function buildSystem(model: ProjectModel, scope: string, tests: boolean): SystemModel {
  const view = scopeView(model, scope);
  const files = tests ? view.files() : view.files().filter((f) => !isNoisePath(f));
  if (files.length === 0) return { scope, components: [], routes: [], externals: [], edges: [], stages: [] };

  const inside = (file: string | undefined): file is string => file !== undefined && inScope(file, scope) && fileSet.has(file);
  const fileSet = new Set(files);
  const packages = packageRoots(model.files);

  // Ownership: a file belongs to the outermost package strictly under the scope, else to its child folder or file.
  const compOf = new Map<string, Comp>();
  for (const file of files) compOf.set(file, componentOf(file, scope, packages, view.kind === "file"));
  const componentById = new Map<string, Comp>();
  for (const c of compOf.values()) componentById.set(c.id, c);

  const fnCount = new Map<string, number>();
  for (const fn of model.functions) {
    if (!fileSet.has(fn.file)) continue;
    const id = compOf.get(fn.file)?.id;
    if (id !== undefined) fnCount.set(id, (fnCount.get(id) ?? 0) + 1);
  }
  const fileCount = new Map<string, number>();
  for (const file of files) {
    const id = compOf.get(file)?.id as string;
    fileCount.set(id, (fileCount.get(id) ?? 0) + 1);
  }

  // The function a fact belongs to: its nearest named parent (anonymous functions count as their owner). Module-level code has none.
  const fnOf = (id: NodeId): string | undefined => {
    let cur = id;
    for (let depth = 0; depth < 1000; depth++) {
      const node = model.byId.get(cur);
      if (!node || node.kind !== "structure.function" || node.attrs.anonymous !== true || node.parent === undefined) break;
      cur = node.parent;
    }
    return model.functionById.has(cur) ? cur : undefined;
  };
  const siteOf = (file: string, span: Span | undefined, owner: NodeId | undefined): Site => {
    const fn = owner === undefined ? undefined : fnOf(owner);
    return { file: span?.file ?? file, line: (span?.start[0] ?? 0) + 1, ...(fn !== undefined ? { fn } : {}) };
  };

  const buckets = new Map<string, Bucket>();
  const externals = new Map<string, SystemExternal>();
  const addFact = (from: string, to: string, verb: SystemEdge["verb"], tag: string, site: Site, exact: boolean, extra?: { names?: string[] }): void => {
    const key = `${from}\0${verb}\0${to}`;
    let b = buckets.get(key);
    if (!b) {
      b = { from, to, verb, tags: new Map(), count: 0, sites: [], exact: false };
      buckets.set(key, b);
    }
    b.tags.set(tag, (b.tags.get(tag) ?? 0) + 1);
    b.count++;
    b.sites.push(site);
    b.exact ||= exact;
    if (extra?.names) {
      b.names ??= new Set();
      for (const n of extra.names) b.names.add(n);
    }
  };
  const ensureExternal = (ext: SystemExternal): string => {
    if (!externals.has(ext.id)) externals.set(ext.id, ext);
    return ext.id;
  };

  // The effect and route facts of the scope, owned by the file that holds them.
  const routes: SystemRoute[] = [];
  const fetches: Array<{ node: IRNode; file: string }> = [];
  for (const node of model.doc.nodes) {
    if (node.kind !== "effects.net.serve" && !node.kind.startsWith("effects.")) continue;
    const file = model.fileOf(node.id);
    if (!inside(file)) continue;
    const attrs = node.attrs;
    const comp = compOf.get(file)?.id as string;
    if (node.kind === "effects.net.serve") {
      const method = typeof attrs.method === "string" ? attrs.method.toUpperCase() : "GET";
      const path = typeof attrs.path === "string" ? attrs.path : "";
      const handler = typeof attrs.handler === "string" ? attrs.handler : undefined;
      routes.push({
        id: `route:${node.id}`,
        component: comp,
        framework: typeof attrs.framework === "string" ? attrs.framework : "http",
        method,
        path,
        ...(handler !== undefined ? { handler } : {}),
        site: siteOf(file, node.span, node.parent),
      });
      continue;
    }
    if (node.kind === "effects.net.connect") fetches.push({ node, file });
    else if (node.kind === "effects.fs.read" || node.kind === "effects.fs.write") {
      const verb = node.kind === "effects.fs.read" ? "reads" : "writes";
      const api = typeof attrs.api === "string" ? attrs.api : "fs";
      const id = ensureExternal({ id: "fs", label: "Filesystem", category: "filesystem" });
      addFact(comp, id, verb, api, siteOf(file, node.span, node.parent), node.provenance.confidence === "exact");
    } else if (node.kind === "effects.proc.exec") {
      const command = commandName(attrs.command);
      const id = ensureExternal({ id: `proc:${command}`, label: command, category: "process", command });
      addFact(comp, id, "runs", command, siteOf(file, node.span, node.parent), node.provenance.confidence === "exact");
    } else if (node.kind === "effects.env.read") {
      const name = typeof attrs.name === "string" ? attrs.name : "";
      const id = ensureExternal({ id: "env", label: "Environment", category: "config", names: [] });
      const ext = externals.get(id) as SystemExternal;
      if (name !== "" && !ext.names?.includes(name)) ext.names = [...(ext.names ?? []), name].sort();
      addFact(comp, id, "reads", name, siteOf(file, node.span, node.parent), node.provenance.confidence === "exact", { names: name === "" ? [] : [name] });
    } else if (node.kind === "effects.message.post") {
      const id = ensureExternal({ id: "peer", label: "Peer (postMessage)", category: "worker" });
      addFact(comp, id, "posts", "postMessage", siteOf(file, node.span, node.parent), node.provenance.confidence === "exact");
    }
  }

  // Absolute and relative fetches. A relative one is matched to a route of the scope before it becomes an external.
  for (const { node, file } of fetches) {
    const attrs = node.attrs;
    const comp = compOf.get(file)?.id as string;
    const method = typeof attrs.method === "string" ? attrs.method.toUpperCase() : undefined;
    const path = typeof attrs.path === "string" ? attrs.path : "";
    const exact = node.provenance.confidence === "exact" && attrs.confidence !== "inferred";
    const site = siteOf(file, node.span, node.parent);
    const host = typeof attrs.host === "string" ? attrs.host : "<dynamic>";
    const env = typeof attrs.env === "string" ? attrs.env : undefined;

    const relative = attrs.relative === true || (host === "<dynamic>" && path.startsWith(":") && path.includes("/"));
    if (relative && path !== "") {
      const hit = matchRoute(path, method, routes);
      if (hit !== undefined) {
        if (hit.component !== comp) addFact(comp, hit.component, "requests", `${hit.method} ${hit.path}`, site, exact);
        continue;
      }
      const label = `${method ?? "*"} ${path}`;
      const id = ensureExternal({ id: `api:${label}`, label, category: "api" });
      addFact(comp, id, "requests", label, site, exact);
      continue;
    }

    const verb = methodVerb(method);
    const tag = method ?? "fetch";
    if (host === "<dynamic>") {
      const ext: SystemExternal = env !== undefined
        ? { id: `config:${env}`, label: `URL from ${env}`, category: "service" }
        : { id: "dynamic-url", label: "Dynamic URL", category: "service" };
      addFact(comp, ensureExternal(ext), verb, tag, site, exact);
      continue;
    }
    const svc = classifyHost(host, path);
    addFact(comp, ensureExternal({ id: svc.id, label: svc.label, category: svc.category, host: svc.host }), verb, tag, site, exact);
  }

  // Code-level facts between components: calls (candidates included), references, and spawns (a worker or child process).
  for (const rel of model.relations) {
    const fromFile = model.fileOf(rel.from);
    const toFile = model.fileOf(rel.to);
    if (!inside(fromFile)) continue;
    const a = compOf.get(fromFile)?.id as string;
    const exact = !rel.candidate && rel.edge.provenance.confidence === "exact";
    const site = siteOf(fromFile, rel.edge.span, rel.from);
    if (rel.kind === "spawn") {
      const src = model.byId.get(rel.from);
      const api = typeof src?.attrs.api === "string" ? src.attrs.api : "thread";
      const spawnSite = siteOf(fromFile, rel.edge.span ?? src?.span, src?.parent);
      if (inside(toFile)) {
        const b = compOf.get(toFile)?.id as string;
        if (a !== b) addFact(a, b, "spawns", `spawns ${api}`, spawnSite, exact);
      } else if (toFile !== undefined) {
        addFact(a, ensureExternal({ id: `worker:${toFile}`, label: toFile, category: "worker" }), "spawns", `spawns ${api}`, spawnSite, exact);
      }
      continue;
    }
    if (!inside(toFile)) continue;
    const b = compOf.get(toFile)?.id as string;
    if (a === b) continue;
    addFact(a, b, "calls", "calls", site, exact);
  }

  // Imports only where no call joins the same two components: an inferred edge, not used for stages.
  const importEdges = new Map<string, Bucket>();
  for (const e of model.doc.edges) {
    if (e.kind !== "packaging.import") continue;
    const fromFile = model.fileOf(e.from);
    if (!inside(fromFile)) continue;
    for (const target of edgeTargets(e).nodes) {
      const toFile = model.fileOf(target);
      if (!inside(toFile)) continue;
      const a = compOf.get(fromFile)?.id as string;
      const b = compOf.get(toFile)?.id as string;
      if (a === b) continue;
      const key = `${a}\0calls\0${b}`;
      const hasCall = buckets.has(key);
      if (hasCall) continue;
      let ib = importEdges.get(key);
      if (!ib) {
        ib = { from: a, to: b, verb: "calls", tags: new Map(), count: 0, sites: [], exact: false, importOnly: true };
        importEdges.set(key, ib);
      }
      ib.tags.set("imports", (ib.tags.get("imports") ?? 0) + 1);
      ib.count++;
      ib.sites.push(siteOf(fromFile, e.span, undefined));
    }
  }
  for (const [key, ib] of importEdges) buckets.set(key, ib);

  const routeList = routes.sort((x, y) => cmp(x.component, y.component) || cmp(x.path, y.path) || cmp(x.method, y.method) || cmp(x.id, y.id));

  const edges: SystemEdge[] = [];
  for (const b of buckets.values()) {
    const id = `${b.from}>${b.verb}>${b.to}`;
    const sites = dedupeSites(b.sites);
    const tags = [...b.tags.entries()].sort(([x], [y]) => cmp(x, y));
    let label = tags.map(([t, n]) => (n > 1 ? `${t} ×${n}` : t)).join(", ");
    if (b.verb === "reads" && b.names !== undefined && externals.get(b.to)?.id === "env") {
      const n = b.names.size;
      label = `${n} ${n === 1 ? "var" : "vars"}`;
    }
    edges.push({
      id,
      from: b.from,
      to: b.to,
      verb: b.verb,
      label,
      count: b.count,
      sites: sites.slice(0, SITE_CAP),
      confidence: b.exact && !b.importOnly ? "exact" : "inferred",
    });
  }
  edges.sort((x, y) => cmp(x.from, y.from) || cmp(x.to, y.to) || cmp(x.verb, y.verb) || cmp(x.id, y.id));

  const importOnly = new Set<string>();
  for (const ib of importEdges.values()) importOnly.add(`${ib.from}>calls>${ib.to}`);

  // Components must hold code: a child with no functions, no route and no fact is dropped (package.json, tsconfig.json, lockfiles).
  const touched = new Set<string>();
  for (const e of edges) {
    touched.add(e.from);
    touched.add(e.to);
  }
  for (const r of routeList) touched.add(r.component);
  for (const id of [...componentById.keys()]) if ((fnCount.get(id) ?? 0) === 0 && !touched.has(id)) componentById.delete(id);
  if (componentById.size === 0) return { scope, components: [], routes: [], externals: [], edges: [], stages: [] };

  // Entries: components with a route or a program entry point. Another component nothing calls starts a column 0 only when
  // it has facts going out; one with nothing in or out goes to the last column.
  const compIds = [...componentById.keys()].sort();
  const hasRoute = new Set(routeList.map((r) => r.component));
  const hasMain = new Set<string>();
  for (const fn of model.functions) {
    if (!fileSet.has(fn.file)) continue;
    const comp = compOf.get(fn.file);
    if (comp && (fn.name === "main" || isProgramFile(fn.file))) hasMain.add(comp.id);
  }
  const incoming = new Set<string>();
  const outgoing = new Set<string>();
  for (const e of edges) {
    if (e.from !== e.to) incoming.add(e.to);
    outgoing.add(e.from);
  }
  const entries = new Set(compIds.filter((id) => hasRoute.has(id) || hasMain.has(id)));
  const seeds = new Set([...entries, ...compIds.filter((id) => !incoming.has(id) && outgoing.has(id))]);

  // Columns: BFS over calls, requests and spawns from the seeds. A component none reaches goes in a last column.
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    if (e.from === e.to || importOnly.has(`${e.from}>calls>${e.to}`)) continue;
    if (!componentById.has(e.to) || !componentById.has(e.from)) continue;
    const list = adj.get(e.from) ?? [];
    list.push(e.to);
    adj.set(e.from, list);
  }
  const depth = new Map<string, number>();
  let frontier = [...seeds].sort();
  for (const id of frontier) depth.set(id, 0);
  for (let d = 0; frontier.length > 0; d++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const to of adj.get(id) ?? []) {
        if (depth.has(to)) continue;
        depth.set(to, d + 1);
        next.push(to);
      }
    }
    frontier = next.sort();
  }
  const reachedMax = Math.max(-1, ...depth.values());
  for (const id of compIds) if (!depth.has(id)) depth.set(id, reachedMax + 1);

  const columns: string[][] = [];
  for (const id of compIds) {
    const d = depth.get(id) as number;
    (columns[d] ??= []).push(id);
  }
  const stages = columns
    .filter((col) => col !== undefined)
    .map((col) => col.sort((x, y) => cmp(componentById.get(x)?.label ?? x, componentById.get(y)?.label ?? y) || cmp(x, y)));

  const components: SystemComponent[] = compIds.map((id) => {
    const c = componentById.get(id) as Comp;
    return {
      id,
      label: c.label,
      path: c.path,
      kind: c.kind,
      files: fileCount.get(id) ?? 0,
      functions: fnCount.get(id) ?? 0,
      entry: entries.has(id),
    };
  });

  const externalList = [...externals.values()].sort((x, y) => cmp(x.category, y.category) || cmp(x.label, y.label) || cmp(x.id, y.id));
  for (const ext of externalList) if (ext.names !== undefined && ext.names.length === 0) delete ext.names;

  return { scope, components, routes: routeList, externals: externalList, edges, stages };
}

/** The component of one file in a scope: the outermost package strictly under the scope that holds it, else the scope's child. */
export function componentOf(file: string, scope: string, packages: string[], scopeIsFile: boolean): Comp {
  let pkg: string | undefined;
  for (const root of packages) {
    if (root === scope) continue;
    if (scope !== ROOT_SCOPE && !root.startsWith(`${scope}/`)) continue;
    if (!file.startsWith(`${root}/`)) continue;
    if (pkg === undefined || root.length < pkg.length) pkg = root;
  }
  if (pkg !== undefined) return { id: pkg, label: pkg, path: pkg, kind: "package" };
  if (scopeIsFile || file === scope) return { id: file, label: EMPTY_LABEL, path: file, kind: "file" };
  const rest = scope === ROOT_SCOPE ? file : file.slice(scope.length + 1);
  const slash = rest.indexOf("/");
  if (slash === -1) return { id: file, label: file, path: file, kind: "file" };
  const folder = scope === ROOT_SCOPE ? rest.slice(0, slash) : `${scope}/${rest.slice(0, slash)}`;
  return { id: folder, label: folder, path: folder, kind: "folder" };
}

/** The package roots of the project: the folders of its package.json files, outside fixture folders. The root package is not a root here. */
export function packageRoots(files: string[]): string[] {
  const roots = new Set<string>();
  for (const file of files) {
    const slash = file.lastIndexOf("/");
    if (file.slice(slash + 1) !== "package.json" || slash === -1) continue;
    const dir = file.slice(0, slash);
    if (NOT_A_PACKAGE.test(dir)) continue;
    roots.add(dir);
  }
  return [...roots].sort();
}

/** The verb of an HTTP method: reads for GET and HEAD, writes for the rest that change state, calls when unknown. */
function methodVerb(method: string | undefined): SystemEdge["verb"] {
  if (method === "GET" || method === "HEAD") return "reads";
  if (method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE") return "writes";
  return "calls";
}

/** The route a relative request is answered by: same method (any when the request omits it), segments matched with `:param` as a wildcard. */
function matchRoute(path: string, method: string | undefined, routes: SystemRoute[]): SystemRoute | undefined {
  let req = segments(path);
  if (!path.startsWith("/") && req.length > 1) req = req.slice(1);
  let best: { route: SystemRoute; literal: number } | undefined;
  for (const route of routes) {
    if (route.path === "" || (method !== undefined && method !== route.method)) continue;
    const want = segments(route.path);
    if (want.length !== req.length) continue;
    let literal = 0;
    let ok = true;
    for (let i = 0; i < want.length; i++) {
      const w = want[i] as string;
      const r = req[i] as string;
      if (w.startsWith(":") || r.startsWith(":")) continue;
      if (w !== r) {
        ok = false;
        break;
      }
      literal++;
    }
    if (!ok) continue;
    if (best === undefined || literal > best.literal || (literal === best.literal && cmp(route.id, best.route.id) < 0)) best = { route, literal };
  }
  return best?.route;
}

/** The path split into its segments, without the query string or trailing slashes. */
function segments(path: string): string[] {
  return (path.split("?")[0] ?? "").split("/").filter((s) => s !== "");
}

/** The command a process runs, as its program name: "git", "tar", or "dynamic command" when it is not known. */
function commandName(value: unknown): string {
  if (typeof value !== "string") return "dynamic command";
  const first = value.trim().split(/\s+/)[0] ?? "";
  if (first === "" || first === "<dynamic>") return "dynamic command";
  return first.slice(first.lastIndexOf("/") + 1) || "dynamic command";
}

/** Project entry files by name: a CLI or main file starts the program. */
function isProgramFile(file: string): boolean {
  return /(^|\/)(main|cli|bin)\.[cm]?[jt]sx?$/.test(file);
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

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
