// The execution canvas's data. An ExecStore loads one scope's execution model at a time, builds its scene, and lays it out
// as the flat grid of unrooted functions (unrootedScene, gridRootsLayout). The grid has no containers, so nothing is solved
// per focus and no saved layout applies.
import {
  MORE_SUFFIX,
  buildExecScene,
  withResourcePeers,
  execThreadId,
  gridRootsLayout,
  threadLabelOf,
  unrootedScene,
  type ExecFunctionRef,
  type ExecModel,
  type FunctionFlow,
  type Scene,
  type SceneLayout,
} from "@insight/flow";
import { api } from "../api";
import type { FlowFocus } from "./detailPref";
import { execBuild, execCallChain, execFocus, execIndex, execOpenSet, execPlacementFor, execResolve, execRunsOn, execThreadKeyOf, execUrl, splitExecFocus, syncSites, type ExecIndex } from "./execMap";
import type { MapBuild, MapSource, MapUrl } from "./source";

/** One scope's loaded canvas: its grid scene and layout, the model's functions, and the index the panels read. */
export interface ExecView {
  scene: Scene;
  /** The grid's layout (gridRootsLayout), with the footprint of no expansion. */
  layout: SceneLayout;
  fns: ReadonlyMap<string, ExecFunctionRef>;
  index: ExecIndex;
  /** The dispatch targets (await or start) of each thread, by the thread's scene id: a chain box of one is an async box. */
  asyncIn: ReadonlyMap<string, ReadonlySet<string>>;
  /** The model the scene was built from: its functions, threads and resources (the panels and the edge tooltips read it). */
  model: ExecModel;
}

export class ExecStore implements MapSource {
  private readonly id: string;
  /** Whether anonymous functions are their own boxes. Folded (false) is the server's model. */
  private readonly lambdas: boolean;
  /** The chart the boxes are sized by: the inter-module focus, or the full chart (`all`, the default). */
  private readonly focus: FlowFocus;
  private readonly loads = new Map<string, Promise<ExecView>>();
  private readonly views = new Map<string, ExecView>();
  /** The grid roots whose "+N more" card was clicked, as `scope NUL root id`. Kept across loads of the scope. */
  private readonly more = new Set<string>();

  /**
   * `lambdas` shows anonymous functions; `focus` sizes the boxes by the inter-module chart. One store per flags.
   */
  constructor(id: string, lambdas = false, focus: FlowFocus = "all") {
    this.id = id;
    this.lambdas = lambdas;
    this.focus = focus;
  }

  /** The cache key of a scope: its scene depends on the scope and on the flags. */
  private keyOf(scope: string): string {
    return `${this.lambdas ? "lambdas" : "folded"}\u0000${this.focus}\u0000${scope}`;
  }

  /** The grid a model draws: the unrooted functions of the scope, with the "+N more" cards the user expanded. */
  private sceneOf(model: ExecModel, scope: string): Scene {
    const prefix = `${scope}\u0000`;
    const expanded = new Set([...this.more].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length)));
    return unrootedScene(buildExecScene(model), model, expanded);
  }

  /**
   * Shows every card of the grid that the "+N more" card `nodeId` stands for. The scope is loaded again, so the next build
   * lays out the grid with all its cards.
   */
  async expandMore(build: MapBuild, nodeId: string): Promise<void> {
    const rootId = nodeId.slice(0, -MORE_SUFFIX.length);
    this.more.add(`${build.path}\u0000${rootId}`);
    const key = this.keyOf(build.path);
    this.loads.delete(key);
    this.views.delete(key);
    await this.load(build.path);
  }

  /** Loads a scope's model once. A failed load is dropped, so the next call tries again. */
  private load(scope: string): Promise<ExecView> {
    const key = this.keyOf(scope);
    let load = this.loads.get(key);
    if (load === undefined) {
      load = Promise.all([api.getScopeExec(this.id, scope, { lambdas: this.lambdas, focus: this.focus }), api.getScopeCallers(this.id, scope)])
        .then(([model, callers]) => {
          const scene = this.sceneOf(model, scope);
          const layout = gridRootsLayout(scene);
          const fns = new Map(model.functions.map((f): [string, ExecFunctionRef] => [f.id, f]));
          const asyncIn = new Map<string, Set<string>>();
          for (const t of model.threads) {
            const targets = new Set(t.coroutines.map((c) => c.target));
            if (targets.size > 0) asyncIn.set(execThreadId(t.id), targets);
          }
          const view: ExecView = { scene, layout, fns, index: execIndex(scene, model, callers, this.lambdas), asyncIn, model };
          this.views.set(key, view);
          return view;
        })
        .catch((e: unknown) => {
          this.loads.delete(key);
          throw e;
        });
      this.loads.set(key, load);
    }
    return load;
  }

  async resolve(scope: string, fn?: string): Promise<string> {
    const view = await this.load(scope);
    return execFocus(scope, execResolve(view.scene, fn));
  }

  /**
   * The chain of calls that reaches a function the scope draws no card for (see execCallChain): the focus of the chain's
   * first function, which has a card, and the chain. Undefined when the function has a card, or no card reaches it.
   */
  async chainTo(scope: string, fnId: string): Promise<{ focus: string; chain: readonly string[] } | undefined> {
    const view = await this.load(scope);
    const chain = execCallChain(view.index, fnId);
    const first = chain?.[0];
    const nodeId = first === undefined ? undefined : execPlacementFor(view.index, first);
    if (chain === undefined || nodeId === undefined) return undefined;
    return { focus: execFocus(scope, nodeId), chain };
  }

  async ensureFocus(focus: string): Promise<void> {
    const { scope, nodeId } = splitExecFocus(focus);
    const view = await this.load(scope);
    if (!view.scene.nodes.has(nodeId)) throw new Error(`Nothing in the execution map at ${nodeId}`);
  }

  async build(focus: string): Promise<MapBuild> {
    const { scope, nodeId } = splitExecFocus(focus);
    const view = await this.load(scope);
    if (!view.scene.nodes.has(nodeId)) throw new Error(`Nothing in the execution map at ${nodeId}`);
    // A build is slotted: its expansions sit in the room the layout keeps for them (see rebuild).
    return { ...withSites(view, execBuild(view.scene, view.layout, scope, nodeId, view.fns)), slotted: true };
  }

  /**
   * The build laid out with `footprint`: the room kept beside each opened card, so the expansions fit (gridRootsLayout keeps
   * it). The layout is arithmetic, so this is synchronous.
   */
  rebuild(b: MapBuild, footprint: ReadonlyMap<string, { left?: number; w: number; h: number }>): MapBuild {
    const view = this.viewOf(b);
    if (view === undefined || !b.slotted) return b;
    const layout = gridRootsLayout(view.scene, footprint);
    return { ...withSites(view, execBuild(view.scene, layout, b.path, b.nodeId, view.fns)), slotted: true, footprint };
  }

  /** The threads `fnId` runs on in the build's scope, for its open box's tooltip (see execRunsOn). */
  runsOn(b: MapBuild, fnId: string): string | undefined {
    const view = this.viewOf(b);
    return view === undefined ? undefined : execRunsOn(view.index, view.scene, fnId);
  }

  /** A function's chart with its sync rows' peers in their titles, from the build's model (see withResourcePeers). */
  annotateChart(b: MapBuild, fnId: string, chart: FunctionFlow): FunctionFlow {
    const view = this.viewOf(b);
    return view === undefined ? chart : withResourcePeers(chart, fnId, view.model);
  }

  /** Whether `fnId` is a dispatch target of the thread that holds the box `boxId` (see ExecView.asyncIn). */
  asyncOf(b: MapBuild, fnId: string, boxId: string): boolean {
    const view = this.viewOf(b);
    const thread = view?.scene.nodes.get(boxId)?.parent;
    return thread !== undefined && view?.asyncIn.get(thread)?.has(fnId) === true;
  }

  /** The URL that shows a focus (see execUrl). */
  url(_build: MapBuild, focus: string): MapUrl | undefined {
    const { scope, nodeId } = splitExecFocus(focus);
    const view = this.views.get(this.keyOf(scope));
    if (view === undefined) return undefined;
    return execUrl(view.scene, scope, nodeId);
  }

  /** The loaded view of a build's scope, or undefined before the scope has loaded. The panels read its index. */
  viewOf(build: MapBuild): ExecView | undefined {
    return this.views.get(this.keyOf(build.path));
  }

  /** A node of a build is a node of the build's scope, so its focus carries that scope. */
  focusOf(build: MapBuild, nodeId: string): string {
    return execFocus(build.path, nodeId);
  }

  /** Whether the build's model names `fnId`. A folded lambda is not named, so a call to one opens no box (see MapSource.isFunction). */
  isFunction(build: MapBuild, fnId: string): boolean {
    const view = this.viewOf(build);
    return view === undefined || view.fns.has(fnId);
  }

  /** The placement of a function in the build's scope: in the build's thread when it has one there (see execPlacementFor). */
  placeFunction(build: MapBuild, fnId: string): string | undefined {
    const view = this.viewOf(build);
    if (view === undefined) return undefined;
    return execPlacementFor(view.index, fnId, execThreadKeyOf(view.scene, build.nodeId));
  }
}

/**
 * The selected function's thread. The grid draws no thread frame, so its card has no thread above it; the card's id carries
 * the thread it was first placed in ("thread:<id>>fn"), and the model names that thread. A card on no thread stays plain code.
 */
function withThread(view: ExecView, b: MapBuild): MapBuild {
  const sel = b.selected;
  if (sel === undefined || sel.runtime !== "none") return b;
  const t = view.model.threads.find((th) => b.nodeId.startsWith(`${execThreadId(th.id)}>`));
  if (t === undefined) return b;
  return { ...b, selected: { ...sel, runtime: "thread", thread: threadLabelOf(t, view.fns) } };
}

/** The build's sync edges with their sites: the tooltip of each lists the sites of the resources the edge names. */
function withSites(view: ExecView, build: MapBuild): MapBuild {
  const b = withThread(view, build);
  if (!b.edges.some((e) => e.kind === "sync" && e.resources !== undefined)) return b;
  const edges = b.edges.map((e) => (e.kind === "sync" && e.resources !== undefined ? { ...e, sites: syncSites(view.model, e.resources) } : e));
  return { ...b, edges };
}
