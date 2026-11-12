import { EventEmitter } from "node:events";
import { runIndex, type IndexLimits, type IndexOptions, type IndexPhase, type IndexReport } from "@insight/indexer";
import { headOf, isDirty, syncCheckout } from "./git.js";
import type { LastRun, ProjectRecord, ProjectRegistry } from "./registry.js";

export type IndexFn = (opts: IndexOptions) => Promise<IndexReport>;

/** The stages a run goes through: the git fetch, then the stages of the indexer. */
export type RunPhase = "fetch" | IndexPhase;

/** What a run is doing now. Sent with `phase` events, and on the project JSON while the project is indexing. */
export interface RunProgress {
  phase: RunPhase;
  label: string;
  /** Extract only: the frontend this stage is about. */
  frontend?: string;
  /** Extract only: this frontend's 1-based position among the frontends with files to extract. */
  step?: number;
  /** Extract only: how many frontends have files to extract. Not set by the indexer yet. */
  steps?: number;
  /** Counted stages only: units finished so far. */
  done?: number;
  /** Counted stages only: units in this stage. */
  total?: number;
  /** When the run started. */
  startedAt: string;
  /** When the current phase (and frontend) started. */
  phaseStartedAt: string;
  full: boolean;
  /** Duration of the project's last successful run, for a rough estimate. */
  previousMs?: number;
}

export interface RecentLine {
  line: string;
  at: string;
}

export type JobEvent =
  | { type: "status"; projectId: string; status: ProjectRecord["status"]; queued: boolean; at: string; error?: string }
  | { type: "progress"; projectId: string; line: string; at: string; replay?: true }
  | { type: "phase"; projectId: string; progress: RunProgress; at: string }
  | { type: "done"; projectId: string; last: LastRun; at: string }
  | { type: "failed"; projectId: string; error: string; at: string };

/** How every run is set up. These are the core's indexing options, which a hosted server narrows. */
export interface IndexingOptions {
  /** Load the project's own `.insight/plugins` and lens settings. See IndexOptions. Defaults to true. */
  projectPlugins?: boolean;
  /** Write the SQLite index. Defaults to true. */
  writeIndexDb?: boolean;
  /** Caps on what a run reads. Unset means no caps. */
  limits?: IndexLimits;
  /** Snapshots kept per project. Defaults to the core default. */
  keepSnapshots?: number;
  /**
   * Whether build tools may run at all. Defaults to true. False overrides any project that allows them, so the
   * flag on a project record cannot re-enable them on a server that forbids them.
   */
  allowBuildTools?: boolean;
}

export interface JobRunnerOptions {
  registry: ProjectRegistry;
  /** Opt-in schedule that re-indexes every project. Zero, the default, means no schedule. */
  intervalMs?: number;
  /** The indexer. Tests pass a stub. */
  index?: IndexFn;
  /** Passed to every run. See IndexingOptions. */
  indexing?: IndexingOptions;
}

/** At most one `phase` event per project in this window, except for stage changes and the final update. */
export const PHASE_THROTTLE_MS = 150;
/** How many progress lines are kept per project for replay to a client that connects mid-run. */
export const RECENT_LINE_LIMIT = 200;

type StageUpdate = Omit<RunProgress, "startedAt" | "phaseStartedAt" | "full" | "previousMs">;
type RunBase = Pick<RunProgress, "startedAt" | "full" | "previousMs">;

interface PhaseThrottle {
  last: number;
  dirty: boolean;
  timer?: NodeJS.Timeout;
}

/**
 * Runs indexing jobs. A project has at most one job at a time. A trigger that arrives while a job
 * runs is queued once, and several such triggers merge into a single follow-up run.
 *
 * Nothing runs by itself: a run starts only when triggered (adding a project, or a reindex request).
 */
export class JobRunner {
  private readonly active = new Map<string, Promise<void>>();
  private readonly followUp = new Map<string, { full: boolean }>();
  private readonly events = new EventEmitter();
  private readonly progress = new Map<string, RunProgress>();
  private readonly recent = new Map<string, RecentLine[]>();
  private readonly throttle = new Map<string, PhaseThrottle>();
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

  /** The current stage of the active run, if any. */
  progressOf(projectId: string): RunProgress | undefined {
    return this.progress.get(projectId);
  }

  /** The last progress lines of the project, oldest first. Kept after a run ends, until the next run starts. */
  recentLines(projectId: string): RecentLine[] {
    return [...(this.recent.get(projectId) ?? [])];
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

  /**
   * Arms the optional schedule. It does not index anything itself: with no `intervalMs` (the default)
   * this does nothing, and runs start only when triggered.
   */
  start(): void {
    const interval = this.opts.intervalMs ?? 0;
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
    const startedAt = now();
    const previousMs = project.last?.durationMs;
    const base: RunBase = { startedAt, full, ...(previousMs !== undefined ? { previousMs } : {}) };
    this.progress.delete(projectId);
    this.recent.set(projectId, []);
    const isGit = project.source.kind === "git";
    this.advance(projectId, base, isGit ? { phase: "fetch", label: "Fetching" } : { phase: "scan", label: "Starting" });
    registry.update(projectId, { status: "indexing", error: undefined });
    this.emit({ type: "status", projectId, status: "indexing", queued: false, at: now() });
    try {
      let root: string;
      let commit: string | undefined;
      let dirty: boolean | undefined;
      if (project.source.kind === "git") {
        root = project.source.checkout;
        this.line(projectId, `fetching ${project.source.url}`);
        const sync = await syncCheckout(project.source.url, root);
        commit = sync.commit;
        if (sync.warning) this.line(projectId, `warning: ${sync.warning}`);
      } else {
        root = project.source.path;
        commit = await headOf(root);
        // The snapshot reads the working tree, so uncommitted changes make the commit label incomplete.
        dirty = await isDirty(root);
      }
      const indexing = this.opts.indexing ?? {};
      const report = await (this.opts.index ?? runIndex)({
        projectPath: root,
        stateDir: project.stateDir,
        full,
        allowBuildTools: project.allowBuildTools && indexing.allowBuildTools !== false,
        projectPlugins: indexing.projectPlugins,
        writeIndexDb: indexing.writeIndexDb,
        limits: indexing.limits,
        keepSnapshots: indexing.keepSnapshots,
        commit,
        onProgress: (line) => this.line(projectId, line),
        onPhase: (p) => this.advance(projectId, base, { ...p }),
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
      this.endRun(projectId);
      registry.update(projectId, { status: "idle", error: undefined, last });
      this.emit({ type: "done", projectId, last, at: now() });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.endRun(projectId);
      registry.update(projectId, { status: "error", error });
      this.emit({ type: "failed", projectId, error, at: now() });
    }
  }

  /** Records a stage. A stage change is sent at once; updates within a stage are throttled. */
  private advance(projectId: string, base: RunBase, stage: StageUpdate): void {
    const prev = this.progress.get(projectId);
    const changed = prev === undefined || prev.phase !== stage.phase || prev.frontend !== stage.frontend;
    const next: RunProgress = {
      ...stage,
      ...base,
      phaseStartedAt: changed || prev === undefined ? now() : prev.phaseStartedAt,
    };
    if (changed) this.flushPhase(projectId); // the pending update of the old stage goes out first
    this.progress.set(projectId, next);
    if (changed) this.sendPhase(projectId);
    else this.throttlePhase(projectId);
  }

  private throttlePhase(projectId: string): void {
    const t = this.throttleState(projectId);
    const wait = PHASE_THROTTLE_MS - (Date.now() - t.last);
    if (wait <= 0) {
      this.sendPhase(projectId);
      return;
    }
    t.dirty = true;
    if (t.timer === undefined) t.timer = setTimeout(() => this.flushPhase(projectId), wait);
  }

  private flushPhase(projectId: string): void {
    if (this.throttle.get(projectId)?.dirty) this.sendPhase(projectId);
  }

  private sendPhase(projectId: string): void {
    const progress = this.progress.get(projectId);
    if (!progress) return;
    const t = this.throttleState(projectId);
    if (t.timer !== undefined) clearTimeout(t.timer);
    t.timer = undefined;
    t.dirty = false;
    t.last = Date.now();
    this.emit({ type: "phase", projectId, progress, at: now() });
  }

  /** Sends any pending stage update, then drops the run's progress. The recent lines stay. */
  private endRun(projectId: string): void {
    this.flushPhase(projectId);
    this.progress.delete(projectId);
    const t = this.throttle.get(projectId);
    if (t?.timer !== undefined) clearTimeout(t.timer);
    this.throttle.delete(projectId);
  }

  private throttleState(projectId: string): PhaseThrottle {
    let t = this.throttle.get(projectId);
    if (!t) {
      t = { last: 0, dirty: false };
      this.throttle.set(projectId, t);
    }
    return t;
  }

  private line(projectId: string, line: string): void {
    const at = now();
    const ring = this.recent.get(projectId) ?? [];
    ring.push({ line, at });
    if (ring.length > RECENT_LINE_LIMIT) ring.splice(0, ring.length - RECENT_LINE_LIMIT);
    this.recent.set(projectId, ring);
    this.emit({ type: "progress", projectId, line, at });
  }

  private emit(event: JobEvent): void {
    this.events.emit("event", event);
  }
}

const now = () => new Date().toISOString();
