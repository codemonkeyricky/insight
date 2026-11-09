import { EventEmitter } from "node:events";
import { runIndex, type IndexOptions, type IndexReport } from "@insight/core";
import { headOf, isDirty, syncCheckout } from "./git.js";
import type { LastRun, ProjectRecord, ProjectRegistry } from "./registry.js";

export type IndexFn = (opts: IndexOptions) => Promise<IndexReport>;

export type JobEvent =
  | { type: "status"; projectId: string; status: ProjectRecord["status"]; queued: boolean; at: string; error?: string }
  | { type: "progress"; projectId: string; line: string; at: string }
  | { type: "done"; projectId: string; last: LastRun; at: string }
  | { type: "failed"; projectId: string; error: string; at: string };

export interface JobRunnerOptions {
  registry: ProjectRegistry;
  /** How often every project is re-indexed. Zero disables the schedule. */
  intervalMs?: number;
  /** The indexer. Tests pass a stub. */
  index?: IndexFn;
}

export const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Runs indexing jobs. A project has at most one job at a time. A trigger that arrives while a job
 * runs is queued once, and several such triggers merge into a single follow-up run.
 */
export class JobRunner {
  private readonly active = new Map<string, Promise<void>>();
  private readonly followUp = new Map<string, { full: boolean }>();
  private readonly events = new EventEmitter();
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly opts: JobRunnerOptions) {
    this.events.setMaxListeners(0);
  }

  subscribe(projectId: string, listener: (event: JobEvent) => void): () => void {
    const wrapped = (event: JobEvent) => {
      if (event.projectId === projectId) listener(event);
    };
    this.events.on("event", wrapped);
    return () => this.events.off("event", wrapped);
  }

  isIndexing(projectId: string): boolean {
    return this.active.has(projectId);
  }

  isQueued(projectId: string): boolean {
    return this.followUp.has(projectId);
  }

  /** Starts a run now, or queues one behind the running job. Returns what happened. */
  trigger(projectId: string, options: { full?: boolean } = {}): "started" | "queued" | "missing" {
    if (!this.opts.registry.get(projectId)) return "missing";
    if (this.active.has(projectId)) {
      const prev = this.followUp.get(projectId);
      this.followUp.set(projectId, { full: prev?.full === true || options.full === true });
      this.emit({ type: "status", projectId, status: "indexing", queued: true, at: now() });
      return "queued";
    }
    this.launch(projectId, options.full === true);
    return "started";
  }

  /** Resolves once no job is running or queued for the project. */
  async whenIdle(projectId: string): Promise<void> {
    while (this.active.has(projectId)) await this.active.get(projectId);
  }

  /** Re-indexes every project now, then on the interval. */
  start(): void {
    for (const p of this.opts.registry.list()) this.trigger(p.id);
    const interval = this.opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    if (interval > 0 && this.timer === undefined) {
      this.timer = setInterval(() => {
        for (const p of this.opts.registry.list()) this.trigger(p.id);
      }, interval);
      this.timer.unref();
    }
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  private launch(projectId: string, full: boolean): void {
    const job = this.execute(projectId, full).finally(() => {
      this.active.delete(projectId);
      const next = this.followUp.get(projectId);
      if (next) {
        this.followUp.delete(projectId);
        this.launch(projectId, next.full);
      }
    });
    this.active.set(projectId, job);
  }

  private async execute(projectId: string, full: boolean): Promise<void> {
    const registry = this.opts.registry;
    const project = registry.get(projectId);
    if (!project) return;
    registry.update(projectId, { status: "indexing", error: undefined });
    this.emit({ type: "status", projectId, status: "indexing", queued: false, at: now() });
    try {
      let root: string;
      let commit: string | undefined;
      let dirty: boolean | undefined;
      if (project.source.kind === "git") {
        root = project.source.checkout;
        this.emit({ type: "progress", projectId, line: `fetching ${project.source.url}`, at: now() });
        const sync = await syncCheckout(project.source.url, root);
        commit = sync.commit;
        if (sync.warning) this.emit({ type: "progress", projectId, line: `warning: ${sync.warning}`, at: now() });
      } else {
        root = project.source.path;
        commit = await headOf(root);
        // The snapshot reads the working tree, so uncommitted changes make the commit label incomplete.
        dirty = await isDirty(root);
      }
      const report = await (this.opts.index ?? runIndex)({
        projectPath: root,
        stateDir: project.stateDir,
        full,
        allowBuildTools: project.allowBuildTools,
        commit,
        onProgress: (line) => this.emit({ type: "progress", projectId, line, at: now() }),
      });
      const last: LastRun = {
        snapshot: report.snapshot,
        ...(commit !== undefined ? { commit } : {}),
        ...(dirty !== undefined ? { dirty } : {}),
        finishedAt: now(),
        durationMs: report.durationMs,
        nodes: report.nodes,
        edges: report.edges,
        findings: report.findings,
        extracted: report.extracted.length,
        reused: report.reused,
        coverage: report.coverage,
        problems: report.problems,
        lenses: report.lenses.map(({ id, title, status, reason, reused, findings }) => ({
          id,
          title,
          status,
          ...(reason !== undefined ? { reason } : {}),
          reused,
          findings,
        })),
      };
      registry.update(projectId, { status: "idle", error: undefined, last });
      this.emit({ type: "done", projectId, last, at: now() });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      registry.update(projectId, { status: "error", error });
      this.emit({ type: "failed", projectId, error, at: now() });
    }
  }

  private emit(event: JobEvent): void {
    this.events.emit("event", event);
  }
}

const now = () => new Date().toISOString();
