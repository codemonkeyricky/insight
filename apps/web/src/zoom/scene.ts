// The zoom map's data. A ZoomStore loads the scope flows a focus needs, rebuilds the tree and the merged calls when
// one arrives, and lays out each open container in the worker. Layouts are cached by what they depend on, so a
// container is solved again only when its children, its stubs or the calls change.
import {
  PROJECT_ID,
  buildScopeTree,
  focusFromUrl,
  frameSize,
  layoutContainerOf,
  layoutGraphOf,
  layoutKey,
  mergeCalls,
  openFor,
  placeEdges,
  placeScene,
  readLayout,
  stubsFor,
  type ContainerLayout,
  type FunctionFlow,
  type Placed,
  type PlacedEdge,
  type ScopeFlow,
  type ScopeFlowStats,
  type ScopeLink,
  type ScopeTree,
  type Size,
} from "@insight/flow";
import { api } from "../api";
import { fileOfId } from "../flowTargets";
import { solve } from "./elk";

/** The chart's size when a function has nothing to chart: a small box that says so. */
const EMPTY_CFG: Size = { w: 240, h: 56 };

export interface LayoutTiming {
  container: string;
  /** Solver time on the page, or 0 when the answer came from the cache. */
  ms: number;
  cached: boolean;
  nodes: number;
  edges: number;
}

/** Everything the map draws for one focus. A new build replaces the old one whole. */
export interface Build {
  tree: ScopeTree;
  focus: string;
  /** The project-relative path the focus stands for: its folder or file, or a function's file. */
  path: string;
  open: Set<string>;
  placed: Placed;
  edges: PlacedEdge[];
  /** The focused function's chart, when the focus is a function. */
  cfg?: { id: string; fn: FunctionFlow; w: number; h: number };
  /** The resolution of the focus's scope, when its flow is loaded. */
  stats?: ScopeFlowStats;
  timings: LayoutTiming[];
}

export const cfgSize = (fn: FunctionFlow): Size => (fn.tooLarge || fn.nodes.length === 0 ? EMPTY_CFG : { w: fn.width, h: fn.height });

/** The path of each ancestor of a scope, from the project down to the scope itself. */
export function chainOf(scope: string): string[] {
  if (scope === "") return [""];
  const parts = scope.split("/");
  return ["", ...parts.map((_, i) => parts.slice(0, i + 1).join("/"))];
}

export class ZoomStore {
  private readonly id: string;
  private flows = new Map<string, ScopeFlow>();
  private scopeLoads = new Map<string, Promise<void>>();
  private fns = new Map<string, FunctionFlow>();
  private fileLoads = new Map<string, Promise<void>>();
  private version = 0;
  private tree: ScopeTree = buildScopeTree([]);
  private links: ScopeLink[] = [];
  private cache = new Map<string, ContainerLayout>();

  constructor(id: string) {
    this.id = id;
  }

  getTree(): ScopeTree {
    return this.tree;
  }

  /** Loads the flows of a scope and of each ancestor, so the focus's children and its calls are known. */
  async ensureChain(scope: string): Promise<void> {
    await Promise.all(chainOf(scope).map((p) => this.ensureScope(p)));
  }

  /** Loads what a focus needs to be drawn: its scope chain, and for a function, the file's charts. */
  async ensureFocus(focus: string): Promise<void> {
    const n = this.tree.nodes.get(focus);
    if (n === undefined) throw new Error(`Nothing in the map at ${focus}`);
    await this.ensureChain(n.path);
    if (n.kind === "function") await this.ensureFunction(focus);
  }

  /** Loads what a URL names and returns the focus it stands for. */
  async resolve(scope: string, fn?: string): Promise<string> {
    await this.ensureChain(scope);
    const focus = focusFromUrl(this.tree, scope, fn);
    if (focus === undefined) throw new Error(`Nothing in the snapshot at ${scope}`);
    await this.ensureFocus(focus);
    return focus;
  }

  private ensureScope(path: string): Promise<void> {
    if (this.flows.has(path)) return Promise.resolve();
    let load = this.scopeLoads.get(path);
    if (load === undefined) {
      load = api.scopeFlow(this.id, path).then(
        (flow) => {
          this.flows.set(path, flow);
          this.refresh();
        },
        (e: unknown) => {
          this.scopeLoads.delete(path);
          throw e;
        },
      );
      this.scopeLoads.set(path, load);
    }
    return load;
  }

  /** Loads a file's function charts. A function's chart is the one thing that needs the file's layout flow. */
  private ensureFunction(fnId: string): Promise<void> {
    if (this.fns.has(fnId)) return Promise.resolve();
    const file = fileOfId(fnId);
    let load = this.fileLoads.get(file);
    if (load === undefined) {
      load = api.flow(this.id, file).then(
        (res) => {
          for (const f of res.functions) this.fns.set(f.id, f);
        },
        (e: unknown) => {
          this.fileLoads.delete(file);
          throw e;
        },
      );
      this.fileLoads.set(file, load);
    }
    return load;
  }

  private refresh(): void {
    const loaded = [...this.flows].map(([scope, flow]) => ({ scope, flow }));
    this.tree = buildScopeTree(loaded.map((l) => l.flow));
    this.links = mergeCalls(loaded);
    this.version += 1;
    // Each version has its own keys, so the layouts of the last version can never be asked for again.
    this.cache.clear();
  }

  /**
   * The map for a focus. Each open container is solved bottom-up, so an open child's frame has its size before its
   * parent is laid out, and the parent reserves that slot. A container nothing opens is never solved.
   */
  async build(focus: string): Promise<Build> {
    const tree = this.tree;
    const links = this.links;
    const version = this.version;
    const node = tree.nodes.get(focus);
    if (node === undefined) throw new Error(`Nothing in the map at ${focus}`);
    const open = openFor(tree, focus);
    const layoutOf = layoutContainerOf(tree, focus);
    const fn = node.kind === "function" ? this.fns.get(focus) : undefined;
    const cfg = fn === undefined ? undefined : { id: focus, fn, ...cfgSize(fn) };
    const layouts = new Map<string, ContainerLayout>();
    const timings: LayoutTiming[] = [];

    const solveContainer = async (container: string): Promise<Size> => {
      const kids = tree.nodes.get(container)?.children ?? [];
      const sizes = new Map<string, Size>();
      for (const child of kids) {
        if (cfg !== undefined && child === cfg.id) {
          sizes.set(child, frameSize(cfg));
          continue;
        }
        const cn = tree.nodes.get(child);
        if (cn !== undefined && open.has(child) && cn.children.length > 0) {
          sizes.set(child, frameSize(await solveContainer(child)));
        }
      }
      const stubs = container === layoutOf ? stubsFor(tree, links, open, container) : [];
      const key = layoutKey(container, sizes, stubs, version);
      let layout = this.cache.get(key);
      if (layout === undefined) {
        const graph = layoutGraphOf(tree, container, sizes, stubs, links);
        const solved = await solve(graph);
        layout = readLayout(graph, solved.result);
        this.cache.set(key, layout);
        timings.push({ container, ms: solved.ms, cached: false, nodes: graph.children.length, edges: graph.edges.length });
      } else {
        timings.push({ container, ms: 0, cached: true, nodes: 0, edges: 0 });
      }
      layouts.set(container, layout);
      return { w: layout.w, h: layout.h };
    };

    await solveContainer(PROJECT_ID);
    const placed = placeScene(tree, layouts, { x: 0, y: 0 }, cfg === undefined ? undefined : { id: cfg.id, w: cfg.w, h: cfg.h });
    const edges = placeEdges(tree, links, open, focus, placed.rects);
    return {
      tree,
      focus,
      path: node.path,
      open,
      placed,
      edges,
      cfg,
      stats: this.flows.get(node.path)?.stats,
      timings,
    };
  }
}
