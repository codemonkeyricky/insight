// The flow data the flow tab reads: a ZoomStore loads each scope's flow and each file's function charts, once. The
// execution canvas's layout and focus live in execStore.ts; the function panel asks this store for a function's chart.
import { type FunctionFlow, type ScopeFlow } from "@insight/flow";
import { api } from "../api";
import { fileOfId, isPostStep, messageReceivers, withMessageTargets, type MessageReceiver } from "../flowTargets";
import { readDetail, type FlowDetail } from "./detailPref";

export class ZoomStore {
  private readonly id: string;
  /** Which chart a function shows: its coupling chart, or its full chart. Set from the Detail choice (see setDetail). */
  private detail: FlowDetail;
  private flows = new Map<string, ScopeFlow>();
  private scopeLoads = new Map<string, Promise<void>>();
  private fns = new Map<string, FunctionFlow>();
  private fileLoads = new Map<string, Promise<void>>();
  private messages = new Map<string, Promise<FunctionFlow>>();
  private receivers = new Map<string, Promise<MessageReceiver[]>>();
  private loadedReceivers = new Map<string, MessageReceiver[]>();

  /** `detail` defaults to the reader's saved Detail choice. */
  constructor(id: string, detail: FlowDetail = readDetail()) {
    this.id = id;
    this.detail = detail;
  }

  /**
   * The Detail choice the charts are picked by. Charts already handed out keep their chart: a map that shows them must
   * remount to draw the other detail (FlowView keys its map on the choice).
   */
  setDetail(detail: FlowDetail): void {
    this.detail = detail;
  }

  /** The loaded flow of a scope, or undefined while it is not loaded. */
  flowOf(scope: string): ScopeFlow | undefined {
    return this.flows.get(scope);
  }

  /**
   * A function's chart, loading its file's charts if needed. Undefined when the snapshot has no such function. With the
   * "coupling" detail, a function that has a coupling chart shows it (its coupling is kept, so the panel shows the summary);
   * otherwise the full chart is returned, still carrying `coupling`. A chart with a postMessage step names the handler the
   * message reaches (see withMessageTargets).
   */
  async chartOf(fnId: string): Promise<FunctionFlow | undefined> {
    await this.ensureFunction(fnId);
    const fn = this.fns.get(fnId);
    if (fn === undefined) return undefined;
    const chart: FunctionFlow = this.detail === "coupling" && fn.coupling !== undefined ? { ...fn.coupling.chart, coupling: fn.coupling } : fn;
    if (!chart.nodes.some(isPostStep)) return chart;
    return this.messaged(fnId, chart);
  }

  /** The chart with its message steps pointed at their receivers, loaded once per function and detail. */
  private messaged(fnId: string, chart: FunctionFlow): Promise<FunctionFlow> {
    const key = `${this.detail}\0${fnId}`;
    let load = this.messages.get(key);
    if (load === undefined) {
      load = this.receiversOf(fnId).then(
        (receivers) => withMessageTargets(chart, receivers),
        () => {
          this.messages.delete(key);
          return chart;
        },
      );
      this.messages.set(key, load);
    }
    return load;
  }

  /**
   * A chart of a function with its message steps pointed at their receivers, for a chart derived from the function's own
   * (an unfolded coupling chart): the receivers are cached per function, the chart is not. A chart with no message step, or
   * whose receivers cannot be read, is returned as it is.
   */
  async withMessages(fnId: string, chart: FunctionFlow): Promise<FunctionFlow> {
    if (!chart.nodes.some(isPostStep)) return chart;
    try {
      return withMessageTargets(chart, await this.receiversOf(fnId));
    } catch {
      return chart;
    }
  }

  /** Loads `fnId`'s receivers, so that `messagesOf` can point a chart's message steps at them synchronously. Never throws. */
  async loadMessages(fnId: string): Promise<void> {
    try {
      this.loadedReceivers.set(fnId, await this.receiversOf(fnId));
    } catch {
      // Without receivers the message steps keep no target (messagesOf returns the chart as it is).
    }
  }

  /** `chart` with its message steps pointed at the receivers `loadMessages` loaded for `fnId`; as it is when they are not loaded. */
  messagesOf(fnId: string, chart: FunctionFlow): FunctionFlow {
    const receivers = this.loadedReceivers.get(fnId);
    if (receivers === undefined || !chart.nodes.some(isPostStep)) return chart;
    return withMessageTargets(chart, receivers);
  }

  /** The functions a function posts messages to, named as their own charts name them. Reads the project's references. Cached per function. */
  private receiversOf(fnId: string): Promise<MessageReceiver[]> {
    let load = this.receivers.get(fnId);
    if (load === undefined) {
      load = this.loadReceivers(fnId);
      this.receivers.set(fnId, load);
      load.catch(() => this.receivers.delete(fnId));
    }
    return load;
  }

  private async loadReceivers(fnId: string): Promise<MessageReceiver[]> {
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
