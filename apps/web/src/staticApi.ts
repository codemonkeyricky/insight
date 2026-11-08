// The demo build has no server. This module answers the same calls as `api` from JSON files that
// scripts/capture-demo.mjs wrote into /demo/: one fixed project, Insight indexed at one commit.
import { ApiError } from "./apiError";
import type {
  Annotation,
  Compare,
  ExecModel,
  FileEntry,
  FileFlow,
  FileFlowSummary,
  FileSymbol,
  FileView,
  FindingRow,
  LensRecord,
  NodeFacts,
  Overview,
  Project,
  Review,
  ReviewStale,
  ScopeFlow,
  ScopeLensRow,
  ScopeLenses,
  ScopeLensRun,
  SourceSlice,
  TargetType,
} from "./api";
import { canonicalScope, scopeKey, scopeProblem } from "./scopeKey";

interface RawNode {
  id: string;
  kind: string;
  facet: string;
  parent?: string;
  span?: NodeFacts["node"]["span"];
  attrs: Record<string, unknown>;
}
type RawEdge = NodeFacts["outgoing"][number] & { facet?: string; attrs?: unknown };
interface Graph {
  snapshot: string;
  nodes: RawNode[];
  edges: RawEdge[];
  incoming: Record<string, number[]>;
}
export interface DemoMeta {
  capturedAt: string;
  commit: string;
  nodes: number;
  edges: number;
  files: number;
}

const base = `${import.meta.env.BASE_URL}demo/`.replace(/\/{2,}/g, "/");
const cache = new Map<string, Promise<unknown>>();

function load<T>(name: string): Promise<T> {
  let hit = cache.get(name) as Promise<T> | undefined;
  if (!hit) {
    hit = fetch(base + name).then((res) => {
      // A host that answers an unknown path with its HTML page has no such file, the same as a 404.
      const isPage = (res.headers.get("content-type") ?? "").includes("text/html");
      const status = !res.ok ? res.status : isPage ? 404 : 200;
      if (status !== 200) throw new ApiError(status, `demo data ${name} is missing (${status})`);
      return res.json() as Promise<T>;
    });
    cache.set(name, hit);
    // A failed load is not kept, so a retry can succeed.
    hit.catch(() => cache.delete(name));
  }
  return hit;
}

const project = () => load<{ project: Project; overview: Overview }>("project.json");

/**
 * The demo holds one project, and its id is random on every capture. Any id in the URL opens it, so a
 * link shared from an earlier deploy keeps working after the demo is captured again.
 */
async function checkProject(_id: string): Promise<{ project: Project; overview: Overview }> {
  return project();
}

const readOnly = (): never => {
  throw new ApiError(405, "This is a read-only demo. Run Insight locally to add projects and re-index.");
};

interface GraphIndex {
  byId: Map<string, RawNode>;
  children: Map<string, string[]>;
  outgoing: Map<string, number[]>;
}
let graphIndex: Promise<{ graph: Graph; index: GraphIndex }> | undefined;
function loadGraph() {
  graphIndex ??= load<Graph>("graph.json").then((graph) => {
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    const children = new Map<string, string[]>();
    for (const n of graph.nodes) {
      if (n.parent === undefined) continue;
      const list = children.get(n.parent);
      if (list) list.push(n.id);
      else children.set(n.parent, [n.id]);
    }
    const outgoing = new Map<string, number[]>();
    graph.edges.forEach((e, i) => {
      const list = outgoing.get(e.from);
      if (list) list.push(i);
      else outgoing.set(e.from, [i]);
    });
    return { graph, index: { byId, children, outgoing } };
  });
  graphIndex.catch(() => {
    graphIndex = undefined;
  });
  return graphIndex;
}

/** A captured file of one scope, or undefined when the capture did not write it. */
function scopeFile<T>(scope: string, name: string): Promise<T | undefined> {
  return load<T>(`scope/${scopeKey(scope)}/${name}`).catch((e: unknown) => {
    if (e instanceof ApiError && e.status === 404) return undefined;
    throw e;
  });
}

/** The scope's listing as the capture saved it. A scope the capture did not reach is "no such scope", as on the server. */
async function scopeListing(scope: string): Promise<ScopeLenses> {
  const problem = scopeProblem(scope);
  if (problem) throw new ApiError(400, problem);
  const listing = await scopeFile<ScopeLenses>(scope, "lenses.json");
  if (!listing) throw new ApiError(404, "no such scope");
  return listing;
}

/**
 * The record of a lens whose result the capture did not save. The capture saves only ok results with
 * something to show, so an ok lens here has nothing in it, and the other statuses carry their reason.
 */
function recordOf(row: ScopeLensRow): LensRecord {
  if (row.status === "ok") return { id: row.id, title: row.title, status: "ok", reused: false, result: { findings: [], views: [], metrics: {} } };
  if (row.status === "unavailable" || row.status === "error") return { id: row.id, title: row.title, status: row.status, reason: row.reason, reused: false };
  return { id: row.id, title: row.title, status: "unavailable", reason: "Not captured for this scope in the demo.", reused: false };
}

/**
 * The exec model of a scope with no functions, as execModel answers it. The main thread is always listed, so
 * the empty model has one thread with nothing in it. The web build cannot call execModel, so this is written out.
 */
function emptyScopeExec(scope: string): ExecModel {
  return {
    scope: canonicalScope(scope),
    truncated: false,
    functions: [],
    threads: [{ id: "main", kind: "main", roots: [], reach: 0, reached: [], coroutines: [] }],
    dispatches: [],
    stats: {
      threads: 1,
      spawns: 0,
      resolved: 0,
      outside: 0,
      unresolved: 0,
      candidates: 0,
      coroutines: 0,
      dispatches: 0,
      functionsInScope: 0,
      functionsThreaded: 0,
      functionsUnthreaded: 0,
      functionsListed: 0,
    },
  };
}

/** The flow of a scope with no functions. The capture writes no flow file for such a scope. */
const EMPTY_SCOPE_FLOW: ScopeFlow = {
  granularity: "functions",
  functions: [],
  unreferenced: [],
  calls: [],
  externals: [],
  entries: [],
  files: [],
  stats: {
    functions: 0,
    files: 0,
    calls: 0,
    resolved: 0,
    external: 0,
    unresolved: 0,
    inbound: 0,
    entries: 0,
    functionsTotal: 0,
    functionsNoise: 0,
    functionsNonNoise: 0,
    unreferenced: 0,
    unreferencedNoise: 0,
    unreferencedOutside: 0,
  },
};

export const staticApi = {
  health: async () => ({ ok: true, version: "demo" }),
  projects: async () => [(await project()).project],
  project: async (id: string) => (await checkProject(id)).project,
  add: async (_body: { path?: string; url?: string; name?: string; allowBuildTools: boolean }): Promise<Project> => readOnly(),
  remove: async (_id: string): Promise<void> => readOnly(),
  reindex: async (_id: string, _full = false): Promise<{ result: string }> => readOnly(),
  overview: async (id: string, snapshot?: string): Promise<Overview> => {
    const { overview } = await checkProject(id);
    if (snapshot !== undefined && snapshot !== overview.snapshot?.id) throw new ApiError(404, `unknown snapshot ${snapshot}`);
    return overview;
  },
  lens: async (id: string, lensId: string, _snapshot?: string): Promise<LensRecord> => {
    await checkProject(id);
    const lens = (await load<Record<string, LensRecord>>("lenses.json"))[lensId];
    if (!lens) throw new ApiError(404, `no lens ${lensId} in this snapshot`);
    return lens;
  },
  scopeLenses: async (id: string, scope: string): Promise<ScopeLenses> => {
    await checkProject(id);
    return scopeListing(scope);
  },
  scopeLens: async (id: string, scope: string, lensId: string): Promise<ScopeLensRun> => {
    await checkProject(id);
    const listing = await scopeListing(scope);
    const row = listing.lenses.find((l) => l.id === lensId);
    if (!row) throw new ApiError(404, `no lens ${lensId}`);
    // The capture writes a result file only for an ok lens with something to show, so no other lens asks for one.
    const saved = row.status === "ok" && row.hasContent === true ? await scopeFile<ScopeLensRun>(scope, `${lensId}.json`) : undefined;
    if (saved) return saved;
    return { snapshot: listing.snapshot, scope: listing.scope, kind: listing.kind, lens: recordOf(row) };
  },
  findings: async (id: string, filter: { lens?: string; severity?: string; snapshot?: string } = {}): Promise<FindingRow[]> => {
    await checkProject(id);
    return (await load<FindingRow[]>("findings.json")).filter(
      (f) => (filter.lens === undefined || f.lens === filter.lens) && (filter.severity === undefined || f.severity === filter.severity),
    );
  },
  source: async (id: string, file: string, start: number, end: number, context = 3): Promise<SourceSlice> => {
    await checkProject(id);
    const text = (await load<Record<string, string>>("sources.json"))[file];
    if (text === undefined) throw new ApiError(404, `${file} is not part of the demo data`);
    const all = text.split("\n");
    const lo = Math.max(1, Math.min(start, end) - Math.max(0, context));
    const hi = Math.min(all.length, Math.max(start, end) + Math.max(0, context));
    return {
      file,
      firstLine: lo,
      lines: all.slice(lo - 1, hi).map((l) => l.replace(/\r$/, "")),
      highlight: { start: Math.min(start, end), end: Math.max(start, end) },
      totalLines: all.length,
    };
  },
  node: async (id: string, nodeId: string): Promise<NodeFacts> => {
    await checkProject(id);
    const { graph, index } = await loadGraph();
    const node = index.byId.get(nodeId);
    if (!node) throw new ApiError(404, `no node ${nodeId}`);
    const ancestors: { id: string; kind: string }[] = [];
    for (let cur = node.parent === undefined ? undefined : index.byId.get(node.parent); cur; cur = cur.parent === undefined ? undefined : index.byId.get(cur.parent)) {
      ancestors.push(cur);
    }
    return {
      snapshot: graph.snapshot,
      node,
      ancestors,
      children: (index.children.get(nodeId) ?? []).flatMap((c) => index.byId.get(c) ?? []),
      outgoing: (index.outgoing.get(nodeId) ?? []).map((i) => graph.edges[i] as RawEdge),
      incoming: (graph.incoming[nodeId] ?? []).map((i) => graph.edges[i] as RawEdge),
    };
  },
  files: async (id: string, _snapshot?: string): Promise<FileEntry[]> => {
    await checkProject(id);
    return load<FileEntry[]>("files.json");
  },
  file: async (id: string, path: string, _snapshot?: string): Promise<FileView> => {
    await checkProject(id);
    const text = (await load<Record<string, string>>("sources.json"))[path];
    if (text === undefined) throw new ApiError(404, `${path} is not part of the demo data`);
    const lines = text.split("\n").map((l) => l.replace(/\r$/, ""));
    if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
    const { graph } = await loadGraph();
    const symbols: FileSymbol[] = [];
    for (const n of graph.nodes) {
      if ((n.kind !== "structure.function" && n.kind !== "structure.type") || n.span?.file !== path) continue;
      symbols.push({ id: n.id, kind: n.kind, name: String(n.attrs.qualifiedName ?? n.attrs.name ?? n.id), span: n.span });
    }
    symbols.sort((a, b) => a.span.start[0] - b.span.start[0] || a.span.start[1] - b.span.start[1]);
    const findings = (await load<FindingRow[]>("findings.json")).filter((f) => f.span?.file === path);
    const entry = (await load<FileEntry[]>("files.json")).find((f) => f.path === path);
    return {
      snapshot: graph.snapshot,
      file: path,
      lines,
      totalLines: lines.length,
      size: new TextEncoder().encode(text).length,
      ...(entry?.language ? { language: entry.language } : {}),
      symbols,
      findings,
    };
  },
  /** A file with no functions has no flow file, so that answers an empty chart rather than an error. */
  flow: async (id: string, path: string): Promise<FileFlow> => {
    await checkProject(id);
    const name = `flow/${path.split("/").map(encodeURIComponent).join("/")}.json`;
    return load<FileFlow>(name).catch((e: unknown) => {
      if (e instanceof ApiError && e.status === 404) return { file: path, functions: [] };
      throw e;
    });
  },
  flowSummary: async (id: string): Promise<FileFlowSummary[]> => {
    await checkProject(id);
    return (await load<{ snapshot: string | null; files: FileFlowSummary[] }>("flow-summary.json")).files;
  },
  /** A scope's call flow as the capture saved it. A scope with no functions has no file, which is the empty flow. */
  scopeFlow: async (id: string, scope: string): Promise<ScopeFlow> => {
    await checkProject(id);
    const problem = scopeProblem(scope);
    if (problem) throw new ApiError(400, problem);
    return (await scopeFile<ScopeFlow>(scope, "flow.json")) ?? EMPTY_SCOPE_FLOW;
  },
  /** A scope's execution model as the capture saved it. A scope with no functions has no file, which is the empty model. */
  getScopeExec: async (id: string, scope: string): Promise<ExecModel> => {
    await checkProject(id);
    const problem = scopeProblem(scope);
    if (problem) throw new ApiError(400, problem);
    return (await scopeFile<ExecModel>(scope, "exec.json")) ?? emptyScopeExec(scope);
  },
  // Comparing commits and keeping review decisions and notes need a git history and a writable
  // store, which the static demo does not have. The tabs are hidden in demo mode; these keep the
  // surface identical to the live api.
  compare: async (_id: string, _base: string, _head: string): Promise<Compare> => readOnly(),
  review: async (_id: string, _snapshot?: string): Promise<Review> => readOnly(),
  decide: async (_id: string, _key: string, _status: "accepted" | "dismissed", _note = ""): Promise<{ key: string; decision: ReviewStale }> => readOnly(),
  reopen: async (_id: string, _key: string): Promise<void> => readOnly(),
  annotations: async (_id: string, _filter: { type?: TargetType; key?: string } = {}): Promise<Annotation[]> => [],
  addAnnotation: async (_id: string, _body: { type: TargetType; key: string; text: string }): Promise<Annotation> => readOnly(),
  editAnnotation: async (_id: string, _annId: string, _text: string): Promise<Annotation> => readOnly(),
  removeAnnotation: async (_id: string, _annId: string): Promise<void> => readOnly(),
  /** Facts about the captured run, shown in the demo banner. */
  meta: () => load<DemoMeta>("meta.json"),
};
