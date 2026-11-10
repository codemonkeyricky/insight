// The execution canvas's data. An ExecStore loads one scope's execution model at a time, builds its scene, and lays
// it out whole: from the layout the demo capture saved when it still covers the scene, else in the elkjs worker.
// The layout serves every focus in the scope, so a zoom never solves again. A roots-only store cuts the scene down to
// the functions each thread starts in (execRootsOnly), and always solves that cut itself.
import {
  buildExecScene,
  execDefaultOpen,
  execRootsOnly,
  flattenRoots,
  layoutCovers,
  layoutScene,
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
}

/** The most layouts with containers opened a view keeps. Each one reuses the base layout, so a few are cheap. */
const LAYOUTS_MAX = 32;

export class ExecStore implements MapSource {
  private readonly id: string;
  private readonly rootsOnly: boolean;
  /** Whether anonymous functions are their own boxes. Folded (false) is the server's model and its saved layout. */
  private readonly lambdas: boolean;
  private readonly loads = new Map<string, Promise<ExecView>>();
  private readonly views = new Map<string, ExecView>();

  /** `rootsOnly` makes the store's scenes the flat roots-only cut; `lambdas` shows anonymous functions. One store per (project, flags). */
  constructor(id: string, rootsOnly = false, lambdas = false) {
    this.id = id;
    this.rootsOnly = rootsOnly;
    this.lambdas = lambdas;
  }

  /** The cache key of a scope: its scene depends on the scope and on whether the store is roots-only. */
  private keyOf(scope: string): string {
    return `${this.rootsOnly ? "roots" : "all"}\u0000${this.lambdas ? "lambdas" : "folded"}\u0000${scope}`;
  }

  private sceneOf(model: ExecModel): Scene {
    const full = buildExecScene(model);
    return this.rootsOnly ? flattenRoots(execRootsOnly(full, model), model) : full;
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
          const scene = this.sceneOf(model);
          const open = execDefaultOpen(scene);
          // The saved layout is the full scene's, with the default containers open. A roots-only scene is a different scene,
          // so it is always solved here.
          const layout =
            !this.rootsOnly && !this.lambdas && saved !== undefined && layoutCovers(scene, saved, open)
              ? saved
              : await layoutScene(scene, (g) => solve(g).then((s) => s.result), { open });
          const fns = new Map(model.functions.map((f): [string, ExecFunctionRef] => [f.id, f]));
          const view: ExecView = { scene, layout, open, fns, index: execIndex(scene, model, callers), layouts: new Map() };
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
    return execBuild(view.scene, layout, scope, nodeId, view.fns);
  }

  /**
   * The layout for a set of open containers. Only the containers that differ from the base layout are laid out again,
   * along with the containers above them (see layoutScene). A set is solved once and kept until LAYOUTS_MAX other sets
   * push it out.
   */
  private layoutFor(view: ExecView, opened: ReadonlySet<string>): Promise<SceneLayout> {
    const changed = [...opened].filter((id) => !view.open.has(id)).sort();
    if (changed.length === 0) return Promise.resolve(view.layout);
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
