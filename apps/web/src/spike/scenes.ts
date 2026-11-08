// Builds the layouts the zoom spike draws from the demo's captured scopes. Every layout goes through the worker.
import type { ScopeCall, ScopeFlow } from "@insight/flow";
import type { ElkNode } from "elkjs/lib/elk-api";
import { scopeKey } from "../scopeKey";
import { layoutGraph, type LayoutReply } from "./elkClient";

const BASE = `${import.meta.env.BASE_URL}demo/`.replace(/\/{2,}/g, "/");

export async function loadDemo<T>(name: string): Promise<T> {
  const res = await fetch(BASE + name);
  if (!res.ok) throw new Error(`demo ${name}: ${res.status}`);
  return (await res.json()) as T;
}

/** The flow of a scope, as the capture wrote it. "" is the project. */
export const loadScope = (scope: string) => loadDemo<ScopeFlow>(`scope/${scopeKey(scope)}/flow.json`);

export const FILE_W = 220;
export const FILE_H = 44;
export const FN_W = 230;
export const FN_H = 44;
/** Space the file's header takes above its functions in an expanded frame. */
export const FRAME_HEAD = 30;
export const FRAME_PAD = 16;

export interface Box {
  id: string;
  label: string;
  sub: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Functions the box stands for. */
  count: number;
}

export interface Edge {
  id: string;
  from: string;
  to: string;
  points: [number, number][];
}

export interface Scene {
  name: string;
  boxes: Box[];
  edges: Edge[];
  width: number;
  height: number;
  layout: { ms: number; where: LayoutReply["where"]; nodes: number; edges: number; startedAt: number };
}

const LAYERED = {
  "elk.algorithm": "layered",
  "elk.direction": "RIGHT",
  "elk.spacing.nodeNode": "24",
  "elk.layered.spacing.nodeNodeBetweenLayers": "60",
};

const dirOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const baseOf = (p: string) => p.slice(p.lastIndexOf("/") + 1);

/** Lays out files as boxes, with the calls between them as edges. The calls must already be file to file. */
function fileGraph(files: { file: string; functions: number }[], calls: ScopeCall[]): ElkNode {
  const ids = new Set(files.map((f) => f.file));
  return {
    id: "root",
    layoutOptions: LAYERED,
    children: files.map((f) => ({ id: f.file, width: FILE_W, height: FILE_H })),
    edges: calls
      .filter((c) => !c.external && c.from !== c.to && ids.has(c.from) && ids.has(c.to))
      .map((c, i) => ({ id: `c${i}`, sources: [c.from], targets: [c.to] })),
  };
}

/** Lays out one file's functions with the calls between them. */
function functionGraph(scope: ScopeFlow): ElkNode {
  const ids = new Set(scope.functions.map((f) => f.id));
  return {
    id: "root",
    layoutOptions: LAYERED,
    children: scope.functions.map((f) => ({ id: f.id, width: FN_W, height: FN_H })),
    edges: scope.calls
      .filter((c) => !c.external && c.from !== c.to && ids.has(c.from) && ids.has(c.to))
      .map((c, i) => ({ id: `c${i}`, sources: [c.from], targets: [c.to] })),
  };
}

function toScene(name: string, graph: ElkNode, reply: LayoutReply, labels: Map<string, { label: string; sub: string; count: number }>, startedAt: number): Scene {
  const laid = reply.result;
  const boxes: Box[] = (laid.children ?? []).map((c) => {
    const meta = labels.get(c.id) ?? { label: c.id, sub: "", count: 0 };
    return { id: c.id, label: meta.label, sub: meta.sub, x: c.x ?? 0, y: c.y ?? 0, w: c.width ?? FILE_W, h: c.height ?? FILE_H, count: meta.count };
  });
  const at = new Map(boxes.map((b) => [b.id, b]));
  const edges: Edge[] = [];
  for (const e of laid.edges ?? []) {
    const sec = e.sections?.[0];
    if (!sec) continue;
    const from = e.sources[0];
    const to = e.targets[0];
    if (from === undefined || to === undefined || !at.has(from) || !at.has(to)) continue;
    const pts: [number, number][] = [[sec.startPoint.x, sec.startPoint.y], ...(sec.bendPoints ?? []).map((p): [number, number] => [p.x, p.y]), [sec.endPoint.x, sec.endPoint.y]];
    edges.push({ id: e.id, from, to, points: pts });
  }
  return {
    name,
    boxes,
    edges,
    width: laid.width ?? 0,
    height: laid.height ?? 0,
    layout: { ms: reply.ms, where: reply.where, nodes: graph.children?.length ?? 0, edges: graph.edges?.length ?? 0, startedAt },
  };
}

/** The folder view: every file under `prefix` as a box, from the demo's file list and the scope's calls. */
export async function folderScene(prefix: string, scopeName: string): Promise<Scene> {
  const startedAt = performance.now();
  const [files, scope] = await Promise.all([loadDemo<{ path: string; functions: number }[]>("files.json"), loadScope(scopeName)]);
  const rows = files.filter((f) => f.path.startsWith(prefix)).map((f) => ({ file: f.path, functions: f.functions }));
  const graph = fileGraph(rows, scope.calls);
  const reply = await layoutGraph(graph);
  const labels = new Map(rows.map((r) => [r.file, { label: baseOf(r.file), sub: dirOf(r.file), count: r.functions }]));
  return toScene(scopeName, graph, reply, labels, startedAt);
}

/** The project view: every file with functions, from the project's own scope. */
export async function rootScene(): Promise<Scene> {
  const startedAt = performance.now();
  const scope = await loadScope("");
  const rows = scope.files.map((f) => ({ file: f.file, functions: f.functions }));
  const graph = fileGraph(rows, scope.calls);
  const reply = await layoutGraph(graph);
  const labels = new Map(rows.map((r) => [r.file, { label: baseOf(r.file), sub: dirOf(r.file), count: r.functions }]));
  return toScene("project", graph, reply, labels, startedAt);
}

export interface FunctionLayout {
  file: string;
  boxes: Box[];
  edges: Edge[];
  width: number;
  height: number;
  layout: Scene["layout"];
}

/** One file's functions, laid out inside the file's box. Positions are relative to the box's top-left corner. */
export async function functionLayout(file: string): Promise<FunctionLayout> {
  const startedAt = performance.now();
  const scope = await loadScope(file);
  const graph = functionGraph(scope);
  const reply = await layoutGraph(graph);
  const labels = new Map(scope.functions.map((f) => [f.id, { label: f.name, sub: `${f.decisions} decisions · ${f.loops} loops`, count: f.steps }]));
  const scene = toScene(file, graph, reply, labels, startedAt);
  return { file, boxes: scene.boxes.map((b) => ({ ...b, w: FN_W, h: FN_H })), edges: scene.edges, width: scene.width, height: scene.height, layout: scene.layout };
}
