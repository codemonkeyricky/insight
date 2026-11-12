// The static builds have no server. This module answers the same calls as `api` from the JSON files an export wrote:
// the demo (scripts/capture-demo.mjs, into /demo/: one fixed project) and each hosted index (apps/export, under the
// storage base). makeStaticApi takes where a project's files live; the demo and hostedApi.ts each supply one.
import { ApiError } from "./apiError";
import type {
  Annotation,
  ArchModel,
  Compare,
  ExecFunctionRef,
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
  SceneLayout,
  ScopeFlow,
  ScopeLensRow,
  ScopeLenses,
  ScopeLensRun,
  SourceSlice,
  TargetType,
} from "./api";
import type { PipelineModel, SerializedModel, SystemModel } from "@insight/model";
import { buildFileFlow } from "@insight/flow";
import { pipelineFor, refsFor, scopeCallersFor, scopeExecFor, scopeFlowFor, systemFor, type ScopeRefsPayload } from "./model/payloads";
import { models } from "./model/store";
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

/** Why a hosted index has no lens results for a folder or file: its export covers the project root only. */
export const ROOT_ONLY_REASON = "Hosted indexes cover the project root only";

/** Options of one static project source. Every field is optional: the demo uses the defaults. */
export interface StaticOptions {
  /** The text of one source file of a project, or undefined when the project does not hold it. Default: the demo's sources.json. */
  sourceFor?: (projectId: string, path: string) => Promise<string | undefined>;
  /** The export holds the project root only, so a folder or file scope lists every lens as unavailable. */
  rootOnly?: boolean;
  /** The project as the page shows it, from the export's project.json. Default: the project as exported. */
  identify?: (projectId: string, project: Project) => Project;
  /** The message a write gets. */
  readOnlyMessage?: string;
}

const DEMO_BASE = `${import.meta.env.BASE_URL}demo/`.replace(/\/{2,}/g, "/");
const DEMO_READ_ONLY = "This is a read-only demo. Run Insight locally to add projects and re-index.";

/** One cache for every base, so keys carry the base and no two projects share an entry. */
const cache = new Map<string, Promise<unknown>>();

/** A JSON file under a base URL. A failed load is not kept, so a retry can succeed. */
function loadFrom<T>(base: string, name: string): Promise<T> {
  const key = base + name;
  let hit = cache.get(key) as Promise<T> | undefined;
  if (!hit) {
    hit = fetch(key).then((res) => {
      // A host that answers an unknown path with its HTML page has no such file, the same as a 404.
      const isPage = (res.headers.get("content-type") ?? "").includes("text/html");
      const status = !res.ok ? res.status : isPage ? 404 : 200;
      if (status !== 200) throw new ApiError(status, `project data ${name} is missing (${status})`);
      return res.json() as Promise<T>;
    });
    cache.set(key, hit);
    hit.catch(() => cache.delete(key));
  }
  return hit;
}

/** The recorded graph of a project, indexed for node lookups. */
interface GraphIndex {
  byId: Map<string, RawNode>;
  children: Map<string, string[]>;
  outgoing: Map<string, number[]>;
}

/**
 * The read-only API over one static export per project. `baseFor` names a project's files as a URL base ending in "/", either
 * at once or after a wait (a private project's base is a signed grant). A throw from it is a failed read, as a rejection is.
 */
export function makeStaticApi(baseFor: (projectId: string) => string | Promise<string>, opts: StaticOptions = {}) {
  const baseOf = (projectId: string): Promise<string> => new Promise<string>((resolve) => resolve(baseFor(projectId)));
  const load = <T>(projectId: string, name: string): Promise<T> => baseOf(projectId).then((base) => loadFrom<T>(base, name));
  const readOnly = (): never => {
    throw new ApiError(405, opts.readOnlyMessage ?? DEMO_READ_ONLY);
  };
  const sourceFor = opts.sourceFor ?? ((projectId: string, path: string) => load<Record<string, string>>(projectId, "sources.json").then((m) => m[path]));

  const graphIndexes = new Map<string, Promise<{ graph: Graph; index: GraphIndex }>>();
  const loadGraph = async (projectId: string) => {
    const base = await baseOf(projectId);
    let hit = graphIndexes.get(base);
    if (!hit) {
      hit = loadFrom<Graph>(base, "graph.json").then((graph) => {
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
      graphIndexes.set(base, hit);
      hit.catch(() => graphIndexes.delete(base));
    }
    return hit;
  };

  /** A file of one scope, or undefined when the export did not write it. */
  const scopeFile = <T>(projectId: string, scope: string, name: string): Promise<T | undefined> =>
    load<T>(projectId, `scope/${scopeKey(scope)}/${name}`).catch((e: unknown) => {
      if (e instanceof ApiError && e.status === 404) return undefined;
      throw e;
    });

  /** The project's project.json, as the page shows it. */
  async function checkProject(id: string): Promise<{ project: Project; overview: Overview }> {
    const data = await load<{ project: Project; overview: Overview }>(id, "project.json");
    if (!opts.identify) return data;
    const project = opts.identify(id, data.project);
    return { project, overview: { ...data.overview, project } };
  }

  /** The listing of a folder or file on a root-only export: the root's lenses, each unavailable. */
  async function unavailableListing(id: string, scope: string): Promise<ScopeLenses> {
    const root = await scopeFile<ScopeLenses>(id, "", "lenses.json");
    if (!root) throw new ApiError(404, "no such scope");
    const path = canonicalScope(scope);
    const files = await load<FileEntry[]>(id, "files.json");
    return {
      snapshot: root.snapshot,
      scope: path,
      kind: files.some((f) => f.path === path) ? "file" : "folder",
      stats: { nodes: 0, edges: 0, findings: 0, external: 0 },
      facets: [],
      lenses: root.lenses.map((row) => ({ id: row.id, title: row.title, status: "unavailable", reason: ROOT_ONLY_REASON, findings: null, hasContent: false })),
    };
  }

  /** The scope's listing as the export saved it. A scope the export did not reach is "no such scope", as on the server. */
  async function scopeListing(id: string, scope: string): Promise<ScopeLenses> {
    const problem = scopeProblem(scope);
    if (problem) throw new ApiError(400, problem);
    if (opts.rootOnly && canonicalScope(scope) !== "") return unavailableListing(id, scope);
    const listing = await scopeFile<ScopeLenses>(id, scope, "lenses.json");
    if (!listing) throw new ApiError(404, "no such scope");
    return listing;
  }

  /** The text of a source file, or the 404 a file the project does not hold gets. */
  async function sourceText(id: string, path: string): Promise<string> {
    const text = await sourceFor(id, path);
    if (text === undefined) throw new ApiError(404, `${path} is not part of this project's data`);
    return text;
  }

  /**
   * The record of a lens whose result the export did not save. The export saves only ok results with
   * something to show, so an ok lens here has nothing in it, and the other statuses carry their reason.
   */
  function recordOf(row: ScopeLensRow): LensRecord {
    if (row.status === "ok") return { id: row.id, title: row.title, status: "ok", reused: false, result: { findings: [], views: [], metrics: {} } };
    if (row.status === "unavailable" || row.status === "error") return { id: row.id, title: row.title, status: row.status, reason: row.reason, reused: false };
    return { id: row.id, title: row.title, status: "unavailable", reason: "Not captured for this scope in the demo.", reused: false };
  }

  /**
   * The architecture of a project with no package.json files, as archModel answers it. The layers are the lens
   * package's DEFAULT_LAYERS, written out here so the web build does not import that package at run time.
   */
  const EMPTY_ARCH: ArchModel = { layers: ["project", "frontend", "ir", "lens", "app"], packages: [], edges: [], unresolved: [], externals: [], violations: [], files: [], fileImports: [] };

  /** The project's model, loaded once. Scope flows and exec models are computed from it, as the server computes them. */
  const modelOf = async (id: string) => {
    const base = await baseOf(id);
    return models.get(`static:${base}`, () => loadFrom<SerializedModel>(base, "model.json"));
  };

  return {
    project: async (id: string) => (await checkProject(id)).project,
    overview: async (id: string, snapshot?: string): Promise<Overview> => {
      const { overview } = await checkProject(id);
      if (snapshot !== undefined && snapshot !== overview.snapshot?.id) throw new ApiError(404, `unknown snapshot ${snapshot}`);
      return overview;
    },
    add: async (_body: { path?: string; url?: string; name?: string; allowBuildTools: boolean }): Promise<Project> => readOnly(),
    remove: async (_id: string): Promise<void> => readOnly(),
    reindex: async (_id: string, _full = false): Promise<{ result: string }> => readOnly(),
    lens: async (id: string, lensId: string, _snapshot?: string): Promise<LensRecord> => {
      await checkProject(id);
      const lens = (await load<Record<string, LensRecord>>(id, "lenses.json"))[lensId];
      if (!lens) throw new ApiError(404, `no lens ${lensId} in this snapshot`);
      return lens;
    },
    scopeLenses: async (id: string, scope: string): Promise<ScopeLenses> => {
      await checkProject(id);
      return scopeListing(id, scope);
    },
    scopeLens: async (id: string, scope: string, lensId: string): Promise<ScopeLensRun> => {
      await checkProject(id);
      const listing = await scopeListing(id, scope);
      const row = listing.lenses.find((l) => l.id === lensId);
      if (!row) throw new ApiError(404, `no lens ${lensId}`);
      // The export writes a result file only for an ok lens with something to show, so no other lens asks for one.
      const saved = row.status === "ok" && row.hasContent === true ? await scopeFile<ScopeLensRun>(id, scope, `${lensId}.json`) : undefined;
      if (saved) return saved;
      return { snapshot: listing.snapshot, scope: listing.scope, kind: listing.kind, lens: recordOf(row) };
    },
    findings: async (id: string, filter: { lens?: string; severity?: string; snapshot?: string } = {}): Promise<FindingRow[]> => {
      await checkProject(id);
      return (await load<FindingRow[]>(id, "findings.json")).filter(
        (f) => (filter.lens === undefined || f.lens === filter.lens) && (filter.severity === undefined || f.severity === filter.severity),
      );
    },
    source: async (id: string, file: string, start: number, end: number, context = 3): Promise<SourceSlice> => {
      await checkProject(id);
      const text = await sourceText(id, file);
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
      const { graph, index } = await loadGraph(id);
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
      return load<FileEntry[]>(id, "files.json");
    },
    file: async (id: string, path: string, _snapshot?: string): Promise<FileView> => {
      await checkProject(id);
      const text = await sourceText(id, path);
      const lines = text.split("\n").map((l) => l.replace(/\r$/, ""));
      if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
      const { graph } = await loadGraph(id);
      const symbols: FileSymbol[] = [];
      for (const n of graph.nodes) {
        if ((n.kind !== "structure.function" && n.kind !== "structure.type") || n.span?.file !== path) continue;
        symbols.push({ id: n.id, kind: n.kind, name: String(n.attrs.qualifiedName ?? n.attrs.name ?? n.id), span: n.span });
      }
      symbols.sort((a, b) => a.span.start[0] - b.span.start[0] || a.span.start[1] - b.span.start[1]);
      const findings = (await load<FindingRow[]>(id, "findings.json")).filter((f) => f.span?.file === path);
      const entry = (await load<FileEntry[]>(id, "files.json")).find((f) => f.path === path);
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
    /**
     * A file's function charts, laid out from the project's graph the way the live server lays them out (its fileFlow). The
     * export has no flow/* files (the spec computes flow layouts in the client), so this reads the graph, not a file.
     */
    flow: async (id: string, path: string): Promise<FileFlow> => {
      await checkProject(id);
      const { graph } = await loadGraph(id);
      const nodes = graph.nodes.filter((n) => n.span?.file === path);
      const edges = graph.edges.filter((e) => e.span?.file === path);
      type FlowInput = Parameters<typeof buildFileFlow>;
      return buildFileFlow(path, nodes as unknown as FlowInput[1], edges as unknown as FlowInput[2]);
    },
    flowSummary: async (id: string): Promise<FileFlowSummary[]> => {
      await checkProject(id);
      return (await load<{ snapshot: string | null; files: FileFlowSummary[] }>(id, "flow-summary.json")).files;
    },
    /** A scope's call flow, computed from the project's model the way the live server computes it. */
    scopeFlow: async (id: string, scope: string): Promise<ScopeFlow> => {
      await checkProject(id);
      const problem = scopeProblem(scope);
      if (problem) throw new ApiError(400, problem);
      const { snapshot, model } = await modelOf(id);
      return scopeFlowFor(snapshot, model, scope);
    },
    /** A scope's execution model, computed from the project's model the way the live server computes it. */
    getScopeExec: async (id: string, scope: string, execOpts: { lambdas?: boolean } = {}): Promise<ExecModel> => {
      await checkProject(id);
      const problem = scopeProblem(scope);
      if (problem) throw new ApiError(400, problem);
      const { snapshot, model } = await modelOf(id);
      return scopeExecFor(snapshot, model, scope, execOpts);
    },
    /** The reverse references of a node, computed from the project's model the way the live server computes them. */
    getRefs: async (id: string, scope: string, fnId: string): Promise<ScopeRefsPayload> => {
      await checkProject(id);
      const problem = scopeProblem(scope);
      if (problem) throw new ApiError(400, problem);
      const { snapshot, model } = await modelOf(id);
      return refsFor(snapshot, model, scope, fnId);
    },
    /** The project-wide callers of each function of a scope, computed from the project's model. */
    getScopeCallers: async (id: string, scope: string): Promise<ReadonlyMap<string, readonly ExecFunctionRef[]>> => {
      await checkProject(id);
      const problem = scopeProblem(scope);
      if (problem) throw new ApiError(400, problem);
      const { model } = await modelOf(id);
      return scopeCallersFor(model, scope);
    },
    /** The System view of a scope, computed from the project's model. */
    getSystem: async (id: string, scope: string, tests = false): Promise<SystemModel> => {
      await checkProject(id);
      const problem = scopeProblem(scope);
      if (problem) throw new ApiError(400, problem);
      const { model } = await modelOf(id);
      return systemFor(model, scope, tests);
    },
    /** The Pipeline view of a scope, computed from the project's model (like getSystem). */
    getPipeline: async (id: string, scope: string, opts: { tests?: boolean } = {}): Promise<PipelineModel> => {
      await checkProject(id);
      const problem = scopeProblem(scope);
      if (problem) throw new ApiError(400, problem);
      const { model } = await modelOf(id);
      return pipelineFor(model, scope, opts.tests === true);
    },
    /**
     * The architecture model as the export saved it. The model covers the whole project, so the export writes it
     * once, under the root scope, and every scope reads that file. A project with no package.json files has none.
     */
    getScopeArch: async (id: string, scope: string): Promise<ArchModel> => {
      await checkProject(id);
      const problem = scopeProblem(scope);
      if (problem) throw new ApiError(400, problem);
      return (await scopeFile<ArchModel>(id, "", "arch.json")) ?? EMPTY_ARCH;
    },
    /** A scope's execution scene laid out whole, as the export saved it. Undefined when it saved none. */
    scopeExecLayout: async (id: string, scope: string): Promise<SceneLayout | undefined> => {
      await checkProject(id);
      const problem = scopeProblem(scope);
      if (problem) throw new ApiError(400, problem);
      return scopeFile<SceneLayout>(id, scope, "exec-layout.json");
    },
    // Comparing commits and keeping review decisions and notes need a git history and a writable
    // store, which the static builds do not have. The tabs are hidden there; these keep the
    // surface identical to the live api.
    compare: async (_id: string, _base: string, _head: string): Promise<Compare> => readOnly(),
    review: async (_id: string, _snapshot?: string): Promise<Review> => readOnly(),
    decide: async (_id: string, _key: string, _status: "accepted" | "dismissed", _note = ""): Promise<{ key: string; decision: ReviewStale }> => readOnly(),
    reopen: async (_id: string, _key: string): Promise<void> => readOnly(),
    annotations: async (_id: string, _filter: { type?: TargetType; key?: string } = {}): Promise<Annotation[]> => [],
    addAnnotation: async (_id: string, _body: { type: TargetType; key: string; text: string }): Promise<Annotation> => readOnly(),
    editAnnotation: async (_id: string, _annId: string, _text: string): Promise<Annotation> => readOnly(),
    removeAnnotation: async (_id: string, _annId: string): Promise<void> => readOnly(),
  };
}

/** The demo's source of one file, from the capture's sources.json, is the default sourceFor. */
const demo = makeStaticApi(() => DEMO_BASE);

/**
 * The demo build's api. The demo holds one project, and its id is random on every capture. Any id in the URL opens it, so a
 * link shared from an earlier deploy keeps working after the demo is captured again.
 */
export const staticApi = {
  ...demo,
  health: async () => ({ ok: true, version: "demo" }),
  projects: async () => [await demo.project("")],
  /** Facts about the captured run, shown in the demo banner. */
  meta: () => loadFrom<DemoMeta>(DEMO_BASE, "meta.json"),
};
