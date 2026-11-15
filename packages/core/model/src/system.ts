// The System view's model: one scope's components, the HTTP routes they serve, the outside systems they touch, and the
// verbs between them. Computed from the whole-project model, so a scope is a closed world: a fact that leaves it is not drawn.
// When the scope has runtime context, the facts are drawn per slice (a component on one thread or coroutine); see system-runtime.ts.
import type { IRNode, NodeId, Span } from "@insight/ir";
import { isNoisePath } from "@insight/flow";
import { edgeTargets } from "@insight/sdk";
import type { ProjectModel } from "./model.js";
import { inScope, normalizeScope, ROOT_SCOPE } from "./scope.js";
import { classifyHost } from "./services.js";
import { scopeView } from "./view.js";
import { buildRuntimePlan, type SystemEvidence, type SystemResource, type SystemRuntime, type SystemRuntimeMode, type SystemSlice } from "./system-runtime.js";

export type { SystemEvidence, SystemResource, SystemResourceKind, SystemRuntime, SystemRuntimeMode, SystemSlice, SystemSpawn } from "./system-runtime.js";

export interface SystemModel {
  scope: string; // "" = project root
  components: SystemComponent[]; // the scope's children (packages at root when package.json roots exist, else folders/files), plus "(scope)" when the scope is one file
  routes: SystemRoute[]; // served endpoints inside the scope
  externals: SystemExternal[];
  edges: SystemEdge[];
  stages: string[][]; // component ids per column, left → right; externals are drawn after
  via?: string; // set when the scope held one code folder, so its children are shown instead: the folder, relative to the scope ("src")
  /** grounded: edges start and end at slices. none: no runtime context, the flat model. truncated: the exec model was cut, so flat. */
  runtime: SystemRuntimeMode;
  /** Truncated only: the in-scope functions the exec model cut, so the runtime of their code is not drawn. */
  skippedFunctions?: number;
  runtimes?: SystemRuntime[]; // present when runtime is grounded
  slices?: SystemSlice[]; // present when runtime is grounded
  resources?: SystemResource[]; // in-process resources and kernel ops, when there are any
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
  /** The APIs and syscalls behind the external, with their counts. Present only when the IR names one. */
  ops?: SystemEvidence[];
}
export interface SystemEdge {
  id: string;
  from: string;
  to: string;
  verb: "calls" | "reads" | "writes" | "runs" | "requests" | "spawns" | "posts" | "produces" | "feeds" | "enqueues" | "dequeues" | "locks" | "waits" | "notifies" | "listens" | "signals" | "controls" | "opens" | "maps"; // produces and feeds: the Pipeline view
  label: string; // e.g. "PUT ×5", "GET", "POST /api/index", "git", "3 vars"
  count: number;
  sites: Site[]; // up to 20 sites
  confidence: "exact" | "inferred";
  /** The APIs and syscalls the facts went through. Present only when some fact names one. */
  evidence?: SystemEvidence[];
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
  evidence?: Map<string, SystemEvidence>;
}

/** An API or syscall a fact went through, before it is counted. */
interface Ev {
  api: string;
  syscall?: string;
  level: SystemEvidence["level"];
}

/** Where a fact starts: a slice (grounded) with its runtime, or the component itself (none). */
interface Source {
  from: string;
  rt?: string;
}

/** Folders a scope may pass through to reach its children, a guard against a chain of single folders. */
const MAX_VIA = 8;

/** The label of a <dynamic> resource: the name is unknown, so the API that made it says what it is. */
const dynamicLabel = (api: string | undefined): string => (api === undefined || api === "" ? "<dynamic>" : `<dynamic> (${api})`);

/** Kernel op labels, by `effects.os.call` op. */
const OS_LABEL: Record<string, string> = {
  signal: "Signals",
  "process-control": "Process control",
  memory: "Memory maps",
  device: "Devices",
  "raw-syscall": "Raw syscalls",
  info: "System info",
  fd: "File descriptors",
};

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
  if (files.length === 0) return { scope, components: [], routes: [], externals: [], edges: [], stages: [], runtime: "none" };

  const inside = (file: string | undefined): file is string => file !== undefined && inScope(file, scope) && fileSet.has(file);
  const fileSet = new Set(files);
  const packages = packageRoots(model.files, nodePackageRoots(model));

  // Ownership: a file belongs to the outermost package strictly under the scope, else to its child folder or file.
  const compOf = new Map<string, Comp>();
  for (const file of files) compOf.set(file, componentOf(file, scope, packages, view.kind === "file"));
  const componentById = new Map<string, Comp>();
  for (const c of compOf.values()) componentById.set(c.id, c);

  // The runtime: which threads and coroutines run each component's code. Empty unless the scope has runtime context.
  const plan = buildRuntimePlan(model, scope, (file) => compOf.get(file)?.id, tests);
  const grounded = plan.mode === "grounded";

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
  // The function that owns a node: the node itself when it is a function, else its parent (a spawn, an effect or a lock sits in a function).
  const ownerOfId = (id: NodeId): string | undefined => {
    const own = fnOf(id);
    if (own !== undefined) return own;
    const parent = model.byId.get(id)?.parent;
    return parent === undefined ? undefined : fnOf(parent);
  };
  const siteOf = (file: string, span: Span | undefined, owner: NodeId | undefined): Site => {
    const fn = owner === undefined ? undefined : fnOf(owner);
    return { file: span?.file ?? file, line: (span?.start[0] ?? 0) + 1, ...(fn !== undefined ? { fn } : {}) };
  };

  // The node a fact lands on: the slice of its component on its runtime when grounded, else the component.
  const targetOf = (rt: string | undefined, comp: string): string => (grounded && rt !== undefined ? plan.sliceId(rt, comp) : comp);
  // The program a runtime belongs to: undefined in the flat model, for a thread no program started, and for the unthreaded runtime.
  const progOf = (rt: string | undefined): string | undefined => (grounded && rt !== undefined ? plan.programOf(rt) : undefined);
  // A resource's id is keyed by its program, never by a thread: `kind:program:name`, or `kind:name` when no program owns it.
  const resId = (kind: string, name: string, prog: string | undefined): string => (prog === undefined ? `${kind}:${name}` : `${kind}:${prog}:${name}`);
  // The slice a callee runs in, from a caller running on `rt`: the caller's runtime when the callee runs there, else its first runtime.
  const calleeSlice = (rt: string | undefined, fn: NodeId | undefined, file: string, comp: string): string => {
    const owners = plan.owners(fn, file);
    const on = rt !== undefined && owners.includes(rt) ? rt : (owners[0] as string);
    return plan.sliceId(on, comp);
  };
  // Processes started by a spawn node (their threads are of kind "process" in the exec model).
  const processSpawns = new Set<string>();
  for (const t of plan.exec.threads) if (t.kind === "process" && t.spawn !== undefined) processSpawns.add(t.spawn.node);

  // Where a fact owned by `owner` (in `file`, component `comp`) starts: one source per runtime that runs it when grounded.
  const sourcesOf = (owner: NodeId | undefined, file: string, comp: string): Source[] => {
    if (!grounded) return [{ from: comp }];
    return plan.owners(owner, file).map((rt) => ({ from: plan.sliceId(rt, comp), rt }));
  };

  const buckets = new Map<string, Bucket>();
  const externals = new Map<string, SystemExternal>();
  // Evidence per target, per API: the IR facts behind it. An external's op counts are the distinct facts, however many
  // runtimes each one runs on.
  const evFacts = new Map<string, Map<string, { ev: SystemEvidence; facts: Set<string> }>>();
  let factSeq = 0;
  const addFact = (from: string, to: string, verb: SystemEdge["verb"], tag: string, site: Site, exact: boolean, extra?: { names?: string[]; ev?: Ev; fact?: string }): void => {
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
    if (extra?.ev) {
      const e = extra.ev;
      const evKey = `${e.api}\0${e.syscall ?? ""}\0${e.level}`;
      b.evidence ??= new Map();
      const cur = b.evidence.get(evKey);
      if (cur) cur.count++;
      else b.evidence.set(evKey, { api: e.api, ...(e.syscall !== undefined ? { syscall: e.syscall } : {}), level: e.level, count: 1 });
      const fact = extra.fact ?? `#${++factSeq}`;
      let perTo = evFacts.get(to);
      if (perTo === undefined) evFacts.set(to, (perTo = new Map()));
      let rec = perTo.get(evKey);
      if (rec === undefined) perTo.set(evKey, (rec = { ev: { api: e.api, ...(e.syscall !== undefined ? { syscall: e.syscall } : {}), level: e.level, count: 0 }, facts: new Set() }));
      rec.facts.add(fact);
    }
  };
  const ensureExternal = (ext: SystemExternal): string => {
    if (!externals.has(ext.id)) externals.set(ext.id, ext);
    return ext.id;
  };
  const putResource = (res: SystemResource): string => plan.putResource(res).id;
  // Grounded: the env resource of a program, or `env` when no program runs the code. Flat: `env:flat`, with no edge of its own.
  const envId = (prog: string | undefined, flat = false): string => (flat ? "env:flat" : prog === undefined ? "env" : `env:${prog}`);

  // The effect and route facts of the scope, owned by the file that holds them.
  const routes: SystemRoute[] = [];
  const fetches: Array<{ node: IRNode; file: string }> = [];
  const messageFrom = new Set(plan.exec.dispatches.filter((d) => d.how === "message").map((d) => d.from));
  const fileOfFn = new Map(plan.exec.functions.map((f) => [f.id, f.file] as const));
  for (const node of model.doc.nodes) {
    if (!node.kind.startsWith("effects.")) continue;
    const file = model.fileOf(node.id);
    if (!inside(file)) continue;
    const attrs = node.attrs as Record<string, unknown>;
    const comp = compOf.get(file)?.id as string;
    const exact = node.provenance.confidence === "exact";
    const site = siteOf(file, node.span, node.parent);
    const owner = ownerOfId(node.id);
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
    if (node.kind === "effects.net.connect") {
      fetches.push({ node, file });
      continue;
    }
    if (node.kind === "effects.net.listen") {
      const port = attrs.port === undefined ? "" : String(attrs.port);
      const label = port === "" ? "Listens" : `Listens :${port}`;
      const id = ensureExternal({ id: `listen:${port}`, label, category: "service" });
      for (const s of sourcesOf(owner, file, comp)) addFact(s.from, id, "listens", "listen", site, exact, { fact: node.id });
      continue;
    }
    if (node.kind === "effects.os.call") {
      const op = typeof attrs.op === "string" ? attrs.op : "info";
      const target = typeof attrs.target === "string" ? attrs.target : undefined;
      const rid = `os:${op}`;
      const res = putResource({ id: rid, kind: "os", label: OS_LABEL[op] ?? op, source: "os" });
      if (target !== undefined && target !== "<dynamic>") plan.addName(res, target);
      const verb: SystemEdge["verb"] = op === "signal" ? "signals" : op === "process-control" ? "controls" : op === "memory" || op === "device" ? "maps" : "calls";
      const ev = evidenceOf(attrs, target === "<dynamic>");
      const tag = typeof attrs.api === "string" ? attrs.api : op;
      for (const s of sourcesOf(owner, file, comp)) addFact(s.from, rid, verb, tag, site, exact, ev ? { ev, fact: node.id } : { fact: node.id });
      // An fd op on a literal path (open, fs.open, fs.openSync) also reaches the Filesystem, so the file shows there.
      if (op === "fd" && target !== undefined && target !== "<dynamic>") {
        const fsId = ensureExternal({ id: "fs", label: "Filesystem", category: "filesystem" });
        for (const s of sourcesOf(owner, file, comp)) addFact(s.from, fsId, "opens", tag, site, exact, ev ? { ev, fact: node.id } : { fact: node.id });
      }
      continue;
    }
    if (node.kind === "effects.fs.read" || node.kind === "effects.fs.write") {
      const verb = node.kind === "effects.fs.read" ? "reads" : "writes";
      const api = typeof attrs.api === "string" ? attrs.api : "fs";
      const id = ensureExternal({ id: "fs", label: "Filesystem", category: "filesystem" });
      const ev = evidenceOf(attrs, attrs.path === "<dynamic>");
      for (const s of sourcesOf(owner, file, comp)) addFact(s.from, id, verb, api, site, exact, ev ? { ev, fact: node.id } : undefined);
    } else if (node.kind === "effects.proc.exec") {
      const command = commandName(attrs.command);
      const ev = evidenceOf(attrs, command === "dynamic command");
      // A command that names one project program runs that program; any other is a process box by its name.
      const api = typeof attrs.api === "string" ? attrs.api : undefined;
      const prog = grounded ? plan.programOfCommand(command, { file: site.file, line: site.line, ...(site.fn !== undefined ? { fn: site.fn } : {}), status: "resolved", ...(api !== undefined ? { api } : {}) }) : undefined;
      const to = prog ?? ensureExternal({ id: `proc:${command}`, label: command, category: "process", command });
      for (const s of sourcesOf(owner, file, comp)) addFact(s.from, to, "runs", command, site, exact, ev ? { ev, fact: node.id } : undefined);
    } else if (node.kind === "effects.env.read") {
      const name = typeof attrs.name === "string" ? attrs.name : "";
      if (grounded) {
        for (const s of sourcesOf(owner, file, comp)) {
          const prog = progOf(s.rt);
          const rid = putResource({ id: envId(prog), kind: "env", label: "Environment", ...(prog !== undefined ? { program: prog } : {}), source: "env" });
          plan.addName(rid, name);
          addFact(s.from, rid, "reads", name, site, exact, { names: name === "" ? [] : [name] });
        }
      } else {
        // The flat model keeps its one environment box and holds the names on the resource alone.
        const rid = putResource({ id: envId(undefined, true), kind: "env", label: "Environment", source: "env" });
        plan.addName(rid, name);
        const id = ensureExternal({ id: "env", label: "Environment", category: "config", names: [] });
        const ext = externals.get(id) as SystemExternal;
        if (name !== "" && !ext.names?.includes(name)) ext.names = [...(ext.names ?? []), name].sort();
        addFact(comp, id, "reads", name, site, exact, { names: name === "" ? [] : [name] });
      }
    } else if (node.kind === "effects.message.post") {
      if (grounded) {
        // A post with a dispatch from the same function is routed by that dispatch; any other goes to a peer box.
        if (!messageFrom.has(owner ?? "")) {
          for (const s of sourcesOf(owner, file, comp)) {
            const prog = progOf(s.rt);
            const rid = putResource({ id: resId("queue", "peer", prog), kind: "queue", label: "inbox (unknown peer)", ...(prog !== undefined ? { program: prog } : {}), source: "message" });
            addFact(s.from, rid, "enqueues", "postMessage", site, exact);
          }
        }
      } else {
        const id = ensureExternal({ id: "peer", label: "Peer (postMessage)", category: "worker" });
        addFact(comp, id, "posts", "postMessage", site, exact);
      }
    }
  }

  // Absolute and relative fetches. A relative one is matched to a route of the scope before it becomes an external.
  routes.sort((x, y) => cmp(x.component, y.component) || cmp(x.path, y.path) || cmp(x.method, y.method) || cmp(x.id, y.id));
  for (const { node, file } of fetches) {
    const attrs = node.attrs;
    const comp = compOf.get(file)?.id as string;
    const owner = ownerOfId(node.id);
    const method = typeof attrs.method === "string" ? attrs.method.toUpperCase() : undefined;
    const path = typeof attrs.path === "string" ? attrs.path : "";
    const exact = node.provenance.confidence === "exact" && attrs.confidence !== "inferred";
    const site = siteOf(file, node.span, node.parent);
    const host = typeof attrs.host === "string" ? attrs.host : "<dynamic>";
    const env = typeof attrs.env === "string" ? attrs.env : undefined;
    const sources = sourcesOf(owner, file, comp);

    const relative = attrs.relative === true || (host === "<dynamic>" && path.startsWith(":") && path.includes("/"));
    if (relative && path !== "") {
      const hit = matchRoute(path, method, routes);
      if (hit !== undefined) {
        if (hit.component !== comp) for (const s of sources) addFact(s.from, targetOf(s.rt, hit.component), "requests", `${hit.method} ${hit.path}`, site, exact);
        continue;
      }
      const label = `${method ?? "*"} ${path}`;
      const id = ensureExternal({ id: `api:${label}`, label, category: "api" });
      for (const s of sources) addFact(s.from, id, "requests", label, site, exact);
      continue;
    }

    const verb = methodVerb(method);
    const tag = method ?? "fetch";
    const ev = evidenceOf(attrs, host === "<dynamic>");
    if (host === "<dynamic>") {
      const ext: SystemExternal = env !== undefined
        ? { id: `config:${env}`, label: `URL from ${env}`, category: "service" }
        : { id: "dynamic-url", label: "Dynamic URL", category: "service" };
      for (const s of sources) addFact(s.from, ensureExternal(ext), verb, tag, site, exact, ev ? { ev, fact: node.id } : undefined);
      continue;
    }
    const svc = classifyHost(host, path);
    const id = ensureExternal({ id: svc.id, label: svc.label, category: svc.category, host: svc.host });
    for (const s of sources) addFact(s.from, id, verb, tag, site, exact, ev ? { ev, fact: node.id } : undefined);
  }

  // Code-level facts between components: calls (candidates included), references, and spawns (a worker or child process).
  // Grounded: a call or spawn starts at the caller's slice and ends at the callee's slice on the runtime that runs it; a
  // spawned program is its own runtime, so a process spawn ends at that program. Flat: component to component, as before.
  // The component pairs that have a call, so an import is only drawn where no call joins the two.
  const callPairs = new Set<string>();
  for (const rel of model.relations) {
    const fromFile = model.fileOf(rel.from);
    const toFile = model.fileOf(rel.to);
    if (!inside(fromFile)) continue;
    const a = compOf.get(fromFile)?.id as string;
    const exact = !rel.candidate && rel.edge.provenance.confidence === "exact";
    const site = siteOf(fromFile, rel.edge.span, rel.from);
    const owner = ownerOfId(rel.from);
    if (rel.kind === "spawn") {
      const src = model.byId.get(rel.from);
      const api = typeof src?.attrs.api === "string" ? src.attrs.api : "thread";
      const spawnSite = siteOf(fromFile, rel.edge.span ?? src?.span, src?.parent);
      const processSpawn = processSpawns.has(rel.from);
      const spawned = plan.threadOfSpawn(rel.from);
      const program = grounded && processSpawn ? plan.programOfSpawn(rel.from) : undefined;
      const apiTail = api.slice(api.lastIndexOf(".") + 1);
      for (const s of sourcesOf(owner, fromFile, a)) {
        if (program !== undefined) {
          addFact(s.from, program, "spawns", `spawns ${api}`, spawnSite, exact, { fact: `${rel.from}>${rel.to}` });
          continue;
        }
        if (grounded && processSpawn) {
          // A process the IR cannot resolve to a project program is a process box by its API name.
          addFact(s.from, ensureExternal({ id: `proc:${apiTail}`, label: apiTail, category: "process", command: apiTail }), "spawns", `spawns ${api}`, spawnSite, exact, { fact: `${rel.from}>${rel.to}` });
          continue;
        }
        if (inside(toFile)) {
          const b = compOf.get(toFile)?.id as string;
          if (a === b) continue;
          const to = grounded && spawned !== undefined ? plan.sliceId(spawned, b) : b;
          addFact(s.from, to, "spawns", `spawns ${api}`, spawnSite, exact);
        } else if (toFile !== undefined) {
          addFact(s.from, ensureExternal({ id: `worker:${toFile}`, label: toFile, category: "worker" }), "spawns", `spawns ${api}`, spawnSite, exact);
        }
      }
      continue;
    }
    if (!inside(toFile)) continue;
    const b = compOf.get(toFile)?.id as string;
    if (a === b) continue;
    callPairs.add(`${a}\0${b}`);
    // A call is drawn from the caller's slice to the callee's slice on the runtime that runs it (component-level when flat).
    const calleeFn = ownerOfId(rel.to);
    for (const s of sourcesOf(owner, fromFile, a)) {
      const to = grounded ? calleeSlice(s.rt, calleeFn, toFile, b) : b;
      addFact(s.from, to, "calls", "calls", site, exact);
    }
  }

  // Placeholder threads of unresolved spawns: started from the spawning slice (the spawn site's component on its thread).
  for (const [rt, ph] of plan.placeholders) {
    const site: Site = { file: ph.spawn.file, line: ph.spawn.line, ...(ph.spawn.fn !== undefined ? { fn: ph.spawn.fn } : {}) };
    // One edge from each distinct host. The source is a slice that exists and has functions: the spawn site's component on
    // that host, else its non-empty slice that contains the spawn file (longest path prefix, then first by id), else the host runtime itself.
    const sources = new Set<string>();
    for (const host of ph.hosts) {
      const own = ph.component === undefined ? undefined : plan.slices.get(`${host}|${ph.component}`);
      // Non-empty slices of the host: the one whose component contains the spawn site's file (longest path prefix) first, then by id.
      const pathLen = (sl: { component: string }): number => {
        const cp = componentById.get(sl.component)?.path;
        return cp === undefined ? -1 : cp === "" || cp === "." ? 0 : ph.spawn.file === cp || ph.spawn.file.startsWith(`${cp}/`) ? cp.length : -1;
      };
      const any = [...plan.slices.values()]
        .filter((sl) => sl.runtime === host && sl.functions > 0)
        .sort((a, b) => pathLen(b) - pathLen(a) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0];
      sources.add(own !== undefined && own.functions > 0 ? own.id : any !== undefined ? any.id : host);
    }
    for (const from of [...sources].sort()) addFact(from, rt, "spawns", `spawns ${ph.spawn.api ?? "thread"}`, site, true);
  }

  // Message handoffs and event-loop queues, per the runtime's dispatches. Flat: one inbox per receiving component.
  for (const d of plan.exec.dispatches) {
    if (!inside(d.file)) continue;
    const comp = compOf.get(d.file)?.id as string;
    const site: Site = { file: d.file, line: d.line, ...(fnOf(d.from) !== undefined ? { fn: fnOf(d.from) as string } : {}) };
    if (d.how === "timer" || d.how === "microtask" || d.how === "callback") {
      const queue = d.how === "timer" ? "Timers" : d.how === "microtask" ? "Microtasks" : "Callbacks";
      for (const s of sourcesOf(fnOf(d.from), d.file, comp)) {
        const prog = progOf(s.rt);
        const rid = putResource({ id: resId("queue", queue, prog), kind: "queue", label: queue, ...(prog !== undefined ? { program: prog } : {}), source: "event-loop" });
        addFact(s.from, rid, "enqueues", d.how, site, true);
      }
    } else if (d.how === "message") {
      for (const s of sourcesOf(fnOf(d.from), d.file, comp)) {
        for (const target of d.targets) {
          const tfile = fileOfFn.get(target);
          if (!inside(tfile)) continue;
          const tcomp = compOf.get(tfile)?.id as string;
          if (grounded) {
            const tRt = plan.owners(target, tfile)[0];
            const recv = tRt === undefined ? undefined : plan.threadOf(tRt);
            if (recv === s.rt) continue;
            if (recv === undefined) {
              // The handler runs on no grounded thread: the message goes to the peer inbox of the sender's program.
              const prog = progOf(s.rt);
              const peer = putResource({ id: resId("queue", "peer", prog), kind: "queue", label: "inbox (unknown peer)", ...(prog !== undefined ? { program: prog } : {}), source: "message" });
              addFact(s.from, peer, "enqueues", "message", site, true);
              continue;
            }
            const inbox = putResource({ id: `queue:${recv}:inbox`, kind: "queue", label: `${plan.label(recv)} inbox`, ...(progOf(recv) !== undefined ? { program: progOf(recv) as string } : {}), source: "message" });
            addFact(s.from, inbox, "enqueues", "message", site, true);
            addFact(inbox, plan.sliceId(tRt as string, tcomp), "dequeues", "message", site, true);
          } else {
            if (s.from === tcomp) continue;
            const inbox = putResource({ id: `queue:${tcomp}:inbox`, kind: "queue", label: `${tcomp} inbox`, source: "message" });
            addFact(s.from, inbox, "enqueues", "message", site, true);
            addFact(inbox, tcomp, "dequeues", "message", site, true);
          }
        }
      }
    }
  }

  // Locks and channels the exec model lists, with each site's operation. One resource per program that uses it.
  for (const r of plan.exec.resources) {
    const kind = r.kind === "lock" ? "lock" : "queue";
    const source = r.kind === "lock" ? "sync" : "channel";
    for (const site of r.sites) {
      if (!inside(site.file)) continue;
      const comp = compOf.get(site.file)?.id as string;
      const verb: SystemEdge["verb"] = site.op === "acquire" ? "locks" : site.op === "send" ? "enqueues" : "dequeues";
      const at: Site = { file: site.file, line: site.line, fn: site.fn };
      // A <dynamic> name says nothing shared: each such site is its own resource, keyed by its span.
      const dyn = r.name === "<dynamic>";
      const rname = dyn ? `<dynamic>@${site.file}:${site.line}` : r.name;
      const rlabel = dyn ? dynamicLabel(site.api) : r.name;
      for (const s of sourcesOf(site.fn, site.file, comp)) {
        const prog = progOf(s.rt);
        const rid = putResource({ id: resId(kind, rname, prog), kind, label: rlabel, ...(prog !== undefined ? { program: prog } : {}), source });
        // A dequeue runs from the queue to the thread that takes the item, as an inbox does.
        if (verb === "dequeues") addFact(rid, s.from, verb, site.op, at, true);
        else addFact(s.from, rid, verb, site.op, at, true);
      }
    }
  }

  // Semaphores and condvars are read from the IR: the exec model does not list them.
  for (const node of model.doc.nodes) {
    if (node.kind !== "sync.semaphore" && node.kind !== "sync.condvar") continue;
    const file = model.fileOf(node.id);
    if (!inside(file)) continue;
    const attrs = node.attrs as Record<string, unknown>;
    const op = typeof attrs.op === "string" ? attrs.op : "";
    const verb: SystemEdge["verb"] | undefined = op === "acquire" || op === "wait" ? "waits" : op === "release" || op === "notify" ? "notifies" : undefined;
    if (verb === undefined) continue;
    const api = typeof attrs.api === "string" ? attrs.api : "";
    const given = typeof attrs.name === "string" ? attrs.name : typeof attrs.lock === "string" ? attrs.lock : "";
    const kind = node.kind === "sync.semaphore" ? "semaphore" : "condvar";
    // A wait with no name takes its API's name (Atomics.wait has none, so it is "Atomics"). With no API either it has
    // nothing shared to key it by, so it is <dynamic> and keyed per site, like the other unnamed sites.
    const named = given !== "" ? given : api.startsWith("Atomics.") ? "Atomics" : api !== "" ? api : "<dynamic>";
    const dyn = named === "<dynamic>";
    const name = dyn ? `<dynamic>@${file}:${node.span?.start.join(":") ?? node.id}` : named;
    const label = dyn ? dynamicLabel(api) : named;
    const comp = compOf.get(file)?.id as string;
    for (const s of sourcesOf(ownerOfId(node.id), file, comp)) {
      const prog = progOf(s.rt);
      const rid = putResource({ id: resId(kind, name, prog), kind, label, ...(prog !== undefined ? { program: prog } : {}), source: "sync" });
      addFact(s.from, rid, verb, op, siteOf(file, node.span, node.parent), node.provenance.confidence === "exact");
    }
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
      if (a === b || callPairs.has(`${a}\0${b}`)) continue;
      for (const s of sourcesOf(undefined, fromFile, a)) {
        const to = grounded ? calleeSlice(s.rt, undefined, toFile, b) : b;
        const key = `${s.from}\0calls\0${to}`;
        let ib = importEdges.get(key);
        if (!ib) {
          ib = { from: s.from, to, verb: "calls", tags: new Map(), count: 0, sites: [], exact: false, importOnly: true };
          importEdges.set(key, ib);
        }
        ib.tags.set("imports", (ib.tags.get("imports") ?? 0) + 1);
        ib.count++;
        ib.sites.push(siteOf(fromFile, e.span, undefined));
      }
    }
  }
  for (const [key, ib] of importEdges) buckets.set(key, ib);

  const routeList = routes;

  const edges: SystemEdge[] = [];
  for (const b of buckets.values()) {
    const id = `${b.from}>${b.verb}>${b.to}`;
    const sites = dedupeSites(b.sites);
    const tags = [...b.tags.entries()].sort(([x], [y]) => cmp(x, y));
    let label = tags.map(([t, n]) => (n > 1 ? `${t} ×${n}` : t)).join(", ");
    if (b.verb === "reads" && b.names !== undefined && (b.to === "env" || b.to.startsWith("env:"))) {
      const n = b.names.size;
      label = `${n} ${n === 1 ? "var" : "vars"}`;
    }
    const evidence = b.evidence ? [...b.evidence.values()].sort(cmpEvidence) : [];
    edges.push({
      id,
      from: b.from,
      to: b.to,
      verb: b.verb,
      label,
      count: b.count,
      sites: sites.slice(0, SITE_CAP),
      confidence: b.exact && !b.importOnly ? "exact" : "inferred",
      ...(evidence.length > 0 ? { evidence } : {}),
    });
  }
  edges.sort((x, y) => cmp(x.from, y.from) || cmp(x.to, y.to) || cmp(x.verb, y.verb) || cmp(x.id, y.id));

  // The APIs behind each external, counted over the facts that reach it.
  for (const [id, perTo] of evFacts) {
    const ext = externals.get(id);
    if (ext === undefined) continue;
    ext.ops = [...perTo.values()].map((r) => ({ ...r.ev, count: r.facts.size })).sort(cmpEvidence);
  }

  const importOnly = new Set<string>();
  for (const ib of importEdges.values()) importOnly.add(`${ib.from}>calls>${ib.to}`);

  // A component's slices are its place in the runtime: map each slice back to its component for the component-level checks.
  const compOfId = (id: string): string | undefined => plan.slices.get(id)?.component ?? (componentById.has(id) ? id : undefined);

  // Components must hold code: a child with no functions, no route and no fact is dropped (package.json, tsconfig.json, lockfiles).
  const touched = new Set<string>();
  for (const e of edges) {
    for (const id of [e.from, e.to]) {
      const c = compOfId(id);
      if (c !== undefined) touched.add(c);
    }
  }
  for (const r of routeList) touched.add(r.component);
  for (const id of [...componentById.keys()]) if ((fnCount.get(id) ?? 0) === 0 && !touched.has(id)) componentById.delete(id);
  if (componentById.size === 0) return { scope, components: [], routes: [], externals: [], edges: [], stages: [], runtime: "none" };

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
    const a = compOfId(e.from);
    const b = compOfId(e.to);
    if (a !== undefined && b !== undefined && a !== b) incoming.add(b);
    if (a !== undefined) outgoing.add(a);
  }
  const entries = new Set(compIds.filter((id) => hasRoute.has(id) || hasMain.has(id)));
  const seeds = new Set([...entries, ...compIds.filter((id) => !incoming.has(id) && outgoing.has(id))]);

  // Columns: BFS over calls, requests and spawns from the seeds. A component none reaches goes in a last column.
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    const a = compOfId(e.from);
    const b = compOfId(e.to);
    if (a === undefined || b === undefined || a === b || importOnly.has(`${e.from}>calls>${e.to}`)) continue;
    if (!componentById.has(a) || !componentById.has(b)) continue;
    const list = adj.get(a) ?? [];
    list.push(b);
    adj.set(a, list);
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

  const out: SystemModel = { scope, components, routes: routeList, externals: externalList, edges, stages, runtime: plan.mode };
  if (plan.mode === "truncated") out.skippedFunctions = Math.max(0, plan.exec.stats.functionsInScope - plan.exec.functions.filter((f) => f.inScope).length);
  if (grounded) {
    const { runtimes, slices } = plan.finish();
    // A program with nothing in this scope (no slice of its threads, no child thread, no resource, no edge into it) is not drawn.
    const endpoints = new Set<string>();
    for (const e of edges) {
      endpoints.add(e.from);
      endpoints.add(e.to);
    }
    const busy = new Set<string>();
    for (const sl of slices) {
      const prog = plan.programOf(sl.runtime);
      if (prog !== undefined) busy.add(prog);
    }
    // A drawn child thread counts; an implicit main thread is not drawn, so it does not keep its program.
    for (const rt of runtimes) if (rt.parent !== undefined && rt.implicit !== true) busy.add(rt.parent);
    out.runtimes = runtimes.filter((rt) => rt.kind !== "program" || busy.has(rt.id) || (rt.resources?.length ?? 0) > 0 || endpoints.has(rt.id));
    out.slices = slices;
  }
  const resourceList = [...plan.resources.values()].sort((x, y) => cmp(x.id, y.id));
  if (resourceList.length > 0) out.resources = resourceList;
  return out;
}

/** The API and syscall evidence of a fact, when the IR names one. `dynamic` marks a target the IR could not resolve. */
function evidenceOf(attrs: Record<string, unknown>, dynamic: boolean): Ev | undefined {
  const api = typeof attrs.api === "string" ? attrs.api : undefined;
  const syscall = typeof attrs.syscall === "string" ? attrs.syscall : undefined;
  if (api === undefined && syscall === undefined) return undefined;
  const level: SystemEvidence["level"] = syscall !== undefined || attrs.op === "raw-syscall" ? "syscall" : dynamic ? "unknown" : "api";
  return { api: api ?? syscall ?? "", ...(syscall !== undefined ? { syscall } : {}), level };
}

function cmpEvidence(a: SystemEvidence, b: SystemEvidence): number {
  return cmp(a.api, b.api) || cmp(a.syscall ?? "", b.syscall ?? "") || cmp(a.level, b.level);
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

/**
 * The package roots of the project: the folders of its package.json files, plus the `extra` roots (see `nodePackageRoots`),
 * outside fixture folders. The root package is not a root here.
 */
export function packageRoots(files: string[], extra: string[] = []): string[] {
  const roots = new Set<string>();
  for (const file of files) {
    const slash = file.lastIndexOf("/");
    if (file.slice(slash + 1) !== "package.json" || slash === -1) continue;
    const dir = file.slice(0, slash);
    if (NOT_A_PACKAGE.test(dir)) continue;
    roots.add(dir);
  }
  for (const dir of extra) {
    if (dir === "." || dir === "" || NOT_A_PACKAGE.test(dir)) continue;
    roots.add(dir);
  }
  return [...roots].sort();
}

const nodeRootCache = new WeakMap<ProjectModel, string[]>();

/** The package roots of structure.package nodes (a build system's packages, such as Bazel's), from each node's `root` attribute. The root package "." is not one here. */
export function nodePackageRoots(model: ProjectModel): string[] {
  const cached = nodeRootCache.get(model);
  if (cached !== undefined) return cached;
  const roots = new Set<string>();
  for (const node of model.doc.nodes) {
    if (node.kind !== "structure.package") continue;
    const root = (node.attrs as { root?: unknown }).root;
    if (typeof root === "string" && root !== "." && root !== "") roots.add(root);
  }
  const list = [...roots].sort();
  nodeRootCache.set(model, list);
  return list;
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
