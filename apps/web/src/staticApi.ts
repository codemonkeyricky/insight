// The demo build has no server. This module answers the same calls as `api` from JSON files that
// scripts/capture-demo.mjs wrote into /demo/: one fixed project, Insight indexed at one commit.
import { ApiError } from "./apiError";
import type {
  FindingRow,
  LensRecord,
  NodeFacts,
  Overview,
  Project,
  SourceSlice,
} from "./api";

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
      if (!res.ok) throw new ApiError(res.status, `demo data ${name} is missing (${res.status})`);
      return res.json() as Promise<T>;
    });
    cache.set(name, hit);
    // A failed load is not kept, so a retry can succeed.
    hit.catch(() => cache.delete(name));
  }
  return hit;
}

const project = () => load<{ project: Project; overview: Overview }>("project.json");

async function checkProject(id: string): Promise<{ project: Project; overview: Overview }> {
  const data = await project();
  if (data.project.id !== id) throw new ApiError(404, `no project ${id}`);
  return data;
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
  /** Facts about the captured run, shown in the demo banner. */
  meta: () => load<DemoMeta>("meta.json"),
};
