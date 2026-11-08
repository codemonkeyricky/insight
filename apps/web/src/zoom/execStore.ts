// The execution canvas's data. An ExecStore loads one scope's execution model at a time, builds its scene, and lays
// it out whole: from the layout the demo capture saved when it still covers the scene, else in the elkjs worker.
// The layout serves every focus in the scope, so a zoom never solves again. A roots-only store cuts the scene down to
// the functions each thread starts in (execRootsOnly), and always solves that cut itself.
import {
  buildExecScene,
  execRootsOnly,
  layoutCovers,
  layoutScene,
  type ExecFunctionRef,
  type ExecModel,
  type Scene,
  type SceneLayout,
} from "@insight/flow";
import { api } from "../api";
import { solve } from "./elk";
import { execBuild, execFocus, execIndex, execResolve, execUrl, splitExecFocus, type ExecIndex } from "./execMap";
import type { MapBuild, MapSource, MapUrl } from "./source";

/** One scope's loaded canvas: its scene and layout, the model's functions, and the index the panels read. */
export interface ExecView {
  scene: Scene;
  layout: SceneLayout;
  fns: ReadonlyMap<string, ExecFunctionRef>;
  index: ExecIndex;
}

export class ExecStore implements MapSource {
  private readonly id: string;
  private readonly rootsOnly: boolean;
  private readonly loads = new Map<string, Promise<ExecView>>();
  private readonly views = new Map<string, ExecView>();

  /** `rootsOnly` makes the store's scenes the roots-only cut. Make one store per (project, flag). */
  constructor(id: string, rootsOnly = false) {
    this.id = id;
    this.rootsOnly = rootsOnly;
  }

  /** The cache key of a scope: its scene depends on the scope and on whether the store is roots-only. */
  private keyOf(scope: string): string {
    return `${this.rootsOnly ? "roots" : "all"}\u0000${scope}`;
  }

  private sceneOf(model: ExecModel): Scene {
    const full = buildExecScene(model);
    return this.rootsOnly ? execRootsOnly(full, model) : full;
  }

  /** Loads a scope's model and layout once. A failed load is dropped, so the next call tries again. */
  private load(scope: string): Promise<ExecView> {
    const key = this.keyOf(scope);
    let load = this.loads.get(key);
    if (load === undefined) {
      load = Promise.all([api.getScopeExec(this.id, scope), api.scopeExecLayout(this.id, scope)])
        .then(async ([model, saved]) => {
          const scene = this.sceneOf(model);
          // The saved layout is the full scene's. A roots-only scene is a different scene, so it is always solved here.
          const layout =
            !this.rootsOnly && saved !== undefined && layoutCovers(scene, saved)
              ? saved
              : await layoutScene(scene, (g) => solve(g).then((s) => s.result));
          const fns = new Map(model.functions.map((f): [string, ExecFunctionRef] => [f.id, f]));
          const view: ExecView = { scene, layout, fns, index: execIndex(scene, model) };
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
    return execBuild(view.scene, view.layout, scope, nodeId, view.fns);
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
}
