// The flow data the flow tab reads: a ZoomStore loads each scope's flow and each file's function charts, once. The
// execution canvas's layout and focus live in execStore.ts; the function panel asks this store for a function's chart.
import { type FunctionFlow, type ScopeFlow } from "@insight/flow";
import { api } from "../api";
import { fileOfId, isPostStep, messageReceivers, withMessageTargets, type MessageReceiver } from "../flowTargets";

export class ZoomStore {
  private readonly id: string;
  private flows = new Map<string, ScopeFlow>();
  private scopeLoads = new Map<string, Promise<void>>();
  private fns = new Map<string, FunctionFlow>();
  private fileLoads = new Map<string, Promise<void>>();
  private messages = new Map<string, Promise<FunctionFlow>>();

  constructor(id: string) {
    this.id = id;
  }

  /** The loaded flow of a scope, or undefined while it is not loaded. */
  flowOf(scope: string): ScopeFlow | undefined {
    return this.flows.get(scope);
  }

  /**
   * A function's chart, loading its file's charts if needed. Undefined when the snapshot has no such function. A chart with
   * a postMessage step names the handler the message reaches (see withMessageTargets).
   */
  async chartOf(fnId: string): Promise<FunctionFlow | undefined> {
    await this.ensureFunction(fnId);
    const fn = this.fns.get(fnId);
    if (fn === undefined || !fn.nodes.some(isPostStep)) return fn;
    return this.messaged(fnId, fn);
  }

  /** The chart with its message steps pointed at their receivers, loaded once per function. */
  private messaged(fnId: string, fn: FunctionFlow): Promise<FunctionFlow> {
    let load = this.messages.get(fnId);
    if (load === undefined) {
      load = this.receiversOf(fnId).then(
        (receivers) => withMessageTargets(fn, receivers),
        () => {
          this.messages.delete(fnId);
          return fn;
        },
      );
      this.messages.set(fnId, load);
    }
    return load;
  }

  /** The functions a function posts messages to, named as their own charts name them. Reads the project's references. */
  private async receiversOf(fnId: string): Promise<MessageReceiver[]> {
    const refs = await api.getRefs(this.id, "", fnId);
    return Promise.all(
      messageReceivers(refs.calls).map(async (r) => {
        try {
          await this.ensureFunction(r.id);
        } catch {
          return r;
        }
        return { id: r.id, name: this.fns.get(r.id)?.name ?? r.name };
      }),
    );
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
