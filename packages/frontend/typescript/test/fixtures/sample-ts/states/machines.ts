export type Phase = "idle" | "busy" | "done";
export enum Level {
  Low,
  High,
}

export interface Job {
  id: string;
  status: Phase;
  note: string;
  ready: boolean;
}

export interface Registry {
  update(id: string, patch: Partial<Job>): void;
}

export type Action = { type: "start" } | { type: "finish" } | { type: "reset" };

/** A class field machine with plain assignments, an early exit and a few things that are not states. */
export class Worker {
  phase: Phase = "idle";
  level: Level = Level.Low;
  busy = false;
  label = "w";

  begin(): void {
    if (this.phase !== "idle") return;
    this.phase = "busy";
    this.phase = "done";
  }

  maybe(flag: boolean): void {
    if (this.phase === "idle" || flag) {
      this.phase = "busy";
    }
  }

  dynamic(flag: boolean): void {
    this.phase = flag ? "busy" : "done";
  }

  viaConst(): void {
    const DONE = "done";
    this.phase = DONE;
  }

  raise(): void {
    this.level = Level.High;
    this.busy = true;
    this.label = "x";
  }
}

/** An interface field written by patches. */
export function startJob(registry: Registry, job: Job): void {
  if (job.status === "idle") registry.update(job.id, { status: "busy" });
}

export function finishJob(registry: Registry, id: string): void {
  registry.update(id, { status: "done" });
}

export function makeJob(id: string): Job {
  return { id, status: "idle", note: "", ready: false };
}

/** A reducer: object-literal writes under a switch on a different discriminant. */
export function reducer(s: Job, a: Action): Job {
  switch (a.type) {
    case "start":
      if (s.status !== "idle") return s;
      return { ...s, status: "busy" };
    case "finish":
      return { ...s, status: "done" };
    default:
      return s;
  }
}

/** A switch on the holder itself, with a merged fall-through group. */
export function describe(w: Worker): string {
  switch (w.phase) {
    case "idle":
    case "busy":
      return "working";
    case "done":
      return "finished";
  }
  return "";
}
