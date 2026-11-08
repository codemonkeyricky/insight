// The flow data the flow tab reads: a ZoomStore loads each scope's flow and each file's function charts, once. The
// execution canvas's layout and focus live in execStore.ts; the function panel asks this store for a function's chart.
import { type FunctionFlow, type ScopeFlow } from "@insight/flow";
import { api } from "../api";
import { fileOfId } from "../flowTargets";

export class ZoomStore {
  private readonly id: string;
  private flows = new Map<string, ScopeFlow>();
  private scopeLoads = new Map<string, Promise<void>>();
  private fns = new Map<string, FunctionFlow>();
  private fileLoads = new Map<string, Promise<void>>();

  constructor(id: string) {
    this.id = id;
  }

  /** The loaded flow of a scope, or undefined while it is not loaded. */
  flowOf(scope: string): ScopeFlow | undefined {
    return this.flows.get(scope);
  }

  /** A function's chart, loading its file's charts if needed. Undefined when the snapshot has no such function. */
  async chartOf(fnId: string): Promise<FunctionFlow | undefined> {
    await this.ensureFunction(fnId);
    return this.fns.get(fnId);
  }

  ensureScope(path: string): Promise<void> {
    if (this.flows.has(path)) return Promise.resolve();
    let load = this.scopeLoads.get(path);
    if (load === undefined) {
      load = api.scopeFlow(this.id, path).then(
        (flow) => {
          this.flows.set(path, flow);
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
}
