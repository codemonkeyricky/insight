// The execution canvas's data. An ExecStore loads one scope's execution model at a time, builds its scene, and lays
// it out whole: from the layout the demo capture saved when it still covers the scene, else in the elkjs worker.
// The layout serves every focus in the scope, so a zoom never solves again. A roots-only store cuts the scene down to
// the functions each thread starts in (execRootsOnly), and always solves that cut itself.
import {
  MORE_SUFFIX,
  buildExecScene,
  execDefaultOpen,
  execThreadId,
  execRootsOnly,
  flattenRoots,
  gridRootsLayout,
  layoutCovers,
  layoutScene,
  runtimeOpen,
  runtimeRootsLayout,
  runtimeRootsScene,
  type ExecFunctionRef,
  type ExecModel,
  type Scene,
  type SceneLayout,
} from "@insight/flow";
import { api } from "../api";
import { solve } from "./elk";
import { execBuild, execFocus, execIndex, execOpenSet, execPlacementFor, execResolve, execThreadKeyOf, execUrl, splitExecFocus, type ExecIndex } from "./execMap";
import type { MapBuild, MapSource, MapUrl } from "./source";

/** One scope's loaded canvas: its scene and layout, the model's functions, and the index the panels read. */
export interface ExecView {
  scene: Scene;
  /** The layout with the default containers open (execDefaultOpen). Every other layout of the view is this one with
   * some containers opened as well (see layoutFor). */
  layout: SceneLayout;
  /** The containers open in `layout`: execDefaultOpen of the scene. */
  open: ReadonlySet<string>;
  fns: ReadonlyMap<string, ExecFunctionRef>;
  index: ExecIndex;
  /** The layouts with more containers open, by the sorted ids that differ from `layout`. Bounded (see LAYOUTS_MAX). */
  layouts: Map<string, Promise<SceneLayout>>;
  /** Whether the scene has runtime containers (process and thread boxes). Its layout holds every container, so none is solved. */
  containers: boolean;
  /** The dispatch targets (await or start) of each thread, by the thread's scene id: a chain box of one is an async box. */
  asyncIn: ReadonlyMap<string, ReadonlySet<string>>;
}

/** The most layouts with containers opened a view keeps. Each one reuses the base layout, so a few are cheap. */
const LAYOUTS_MAX = 32;

export class ExecStore implements MapSource {
  private readonly id: string;
  private readonly rootsOnly: boolean;
  /** Whether anonymous functions are their own boxes. Folded (false) is the server's model and its saved layout. */
  private readonly lambdas: boolean;
  /** Whether a roots-only store draws the runtime containers (process and thread boxes) when the model has them. */
  private readonly runtime: boolean;
  private readonly loads = new Map<string, Promise<ExecView>>();
  private readonly views = new Map<string, ExecView>();
  /** The threads whose "+N more" card was clicked, as `scope NUL thread id`. Kept across loads of the scope. */
  private readonly more = new Set<string>();

  /**
   * `rootsOnly` makes the store's scenes the roots-only cut; `lambdas` shows anonymous functions; `runtime` draws the process
   * and thread boxes around the roots (roots-only only, and only when the model has runtime context). One store per flags.
   */
  constructor(id: string, rootsOnly = false, lambdas = false, runtime = true) {
    this.id = id;
    this.rootsOnly = rootsOnly;
    this.lambdas = lambdas;
    this.runtime = runtime;
  }

  /** The cache key of a scope: its scene depends on the scope and on whether the store is roots-only. */
  private keyOf(scope: string): string {
    return `${this.rootsOnly ? "roots" : "all"}\u0000${this.lambdas ? "lambdas" : "folded"}\u0000${this.runtime ? "runtime" : "flat"}\u0000${scope}`;
  }

  /**
   * The scene a model draws here, and whether it has runtime containers. A roots-only store with runtime boxes draws the
   * containers when the model has runtime context; otherwise it draws the flat roots-only cut.
   */
  private sceneOf(model: ExecModel, scope: string): { scene: Scene; containers: boolean } {
    const full = buildExecScene(model);
    if (!this.rootsOnly) return { scene: full, containers: false };
    const prefix = `${scope}\u0000`;
    const expanded = new Set([...this.more].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length)));
    const runtime = this.runtime ? runtimeRootsScene(full, model, expanded) : undefined;
    if (runtime !== undefined) return { scene: runtime, containers: true };
    return { scene: flattenRoots(execRootsOnly(full, model), model), containers: false };
  }

  /**
   * Shows every root card of the thread that the "+N more" card `nodeId` stands for. The scope is loaded again, so the
   * next build lays out the thread with all its cards.
   */
  async expandMore(build: MapBuild, nodeId: string): Promise<void> {
    const threadId = nodeId.slice(0, -MORE_SUFFIX.length);
    this.more.add(`${build.path}\u0000${threadId}`);
    const key = this.keyOf(build.path);
    this.loads.delete(key);
    this.views.delete(key);
    await this.load(build.path);
  }

  /** Loads a scope's model and layout once. A failed load is dropped, so the next call tries again. */
  private load(scope: string): Promise<ExecView> {
    const key = this.keyOf(scope);
    let load = this.loads.get(key);
    if (load === undefined) {
      // The server's saved layout is for the folded, full scene only.
      const saved$ = this.rootsOnly || this.lambdas ? Promise.resolve(undefined) : api.scopeExecLayout(this.id, scope);
      load = Promise.all([api.getScopeExec(this.id, scope, { lambdas: this.lambdas }), saved$, api.getScopeCallers(this.id, scope)])
        .then(async ([model, saved, callers]) => {
          const { scene, containers } = this.sceneOf(model, scope);
          // The saved layout is the full scene's, with the default containers open. A roots-only scene is a different scene,
          // so it is never the saved one. A flat roots-only scene is a grid of uniform cards (gridRootsLayout), with no solve.
          // A roots-only scene with runtime containers is laid out here too, every container open (runtimeRootsLayout).
          const open = containers ? runtimeOpen(scene) : execDefaultOpen(scene);
          const layout = containers
            ? runtimeRootsLayout(scene)
            : this.rootsOnly
              ? gridRootsLayout(scene)
              : !this.lambdas && saved !== undefined && layoutCovers(scene, saved, open)
                ? saved
                : await layoutScene(scene, (g) => solve(g).then((s) => s.result), { open });
          const fns = new Map(model.functions.map((f): [string, ExecFunctionRef] => [f.id, f]));
          const asyncIn = new Map<string, Set<string>>();
          for (const t of model.threads) {
            const targets = new Set(t.coroutines.map((c) => c.target));
            if (targets.size > 0) asyncIn.set(execThreadId(t.id), targets);
          }
          const view: ExecView = { scene, layout, open, fns, index: execIndex(scene, model, callers, this.lambdas), layouts: new Map(), containers, asyncIn };
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

  async ensureFocus(focus: string): Promise<void> {
    const { scope, nodeId } = splitExecFocus(focus);
    const view = await this.load(scope);
    if (!view.scene.nodes.has(nodeId)) throw new Error(`Nothing in the execution map at ${nodeId}`);
  }

  async build(focus: string): Promise<MapBuild> {
    const { scope, nodeId } = splitExecFocus(focus);
    const view = await this.load(scope);
    if (!view.scene.nodes.has(nodeId)) throw new Error(`Nothing in the execution map at ${nodeId}`);
    const layout = await this.layoutFor(view, execOpenSet(view.scene, nodeId));
    // A roots-only build is slotted: its expansions sit in the room the layout keeps for them (see rebuild).
    return { ...execBuild(view.scene, layout, scope, nodeId, view.fns), slotted: this.rootsOnly };
  }

  /**
   * The build laid out with `footprint`: the room kept beside each opened card, so the expansions and the frames around
   * them fit (runtimeRootsLayout and gridRootsLayout keep it). Only a slotted (roots-only) build is laid out again. The
   * layout is arithmetic, so this is synchronous.
   */
  rebuild(b: MapBuild, footprint: ReadonlyMap<string, { w: number; h: number }>): MapBuild {
    const view = this.viewOf(b);
    if (view === undefined || !b.slotted) return b;
    const layout = view.containers ? runtimeRootsLayout(view.scene, footprint) : gridRootsLayout(view.scene, footprint);
    return { ...execBuild(view.scene, layout, b.path, b.nodeId, view.fns), slotted: true, footprint };
  }

  /** Whether `fnId` is a dispatch target of the thread that holds the box `boxId` (see ExecView.asyncIn). */
  asyncOf(b: MapBuild, fnId: string, boxId: string): boolean {
    const view = this.viewOf(b);
    const thread = view?.scene.nodes.get(boxId)?.parent;
    return thread !== undefined && view?.asyncIn.get(thread)?.has(fnId) === true;
  }

  /**
   * The layout for a set of open containers. Only the containers that differ from the base layout are laid out again,
   * along with the containers above them (see layoutScene). A set is solved once and kept until LAYOUTS_MAX other sets
   * push it out.
   */
  private layoutFor(view: ExecView, opened: ReadonlySet<string>): Promise<SceneLayout> {
    const changed = [...opened].filter((id) => !view.open.has(id)).sort();
    // A scene with runtime containers lays out every container already, so no set of open containers needs a solve.
    if (view.containers || changed.length === 0) return Promise.resolve(view.layout);
    const key = changed.join("\u0000");
    let layout = view.layouts.get(key);
    if (layout === undefined) {
      if (view.layouts.size >= LAYOUTS_MAX) {
        const oldest = view.layouts.keys().next().value;
        if (oldest !== undefined) view.layouts.delete(oldest);
      }
      layout = layoutScene(view.scene, (g) => solve(g).then((s) => s.result), {
        open: opened,
        reuse: { from: view.layout, changed },
      });
      view.layouts.set(key, layout);
      // A failed solve is dropped, so the next build tries again.
      layout.catch(() => view.layouts.delete(key));
    }
    return layout;
  }

  /** The URL that shows a focus. Only a roots-only store writes `roots`, so its links keep the view. */
  url(_build: MapBuild, focus: string): MapUrl | undefined {
    const { scope, nodeId } = splitExecFocus(focus);
    const view = this.views.get(this.keyOf(scope));
    if (view === undefined) return undefined;
    const target = execUrl(view.scene, scope, nodeId);
    if (target === undefined) return undefined;
    return this.rootsOnly ? { ...target, roots: true } : target;
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
