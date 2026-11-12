import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { IndexReport, PhaseProgress } from "@insight/indexer";
import { buildServer, ProjectRegistry, type JobEvent } from "../src/index.js";

const SCRATCH = resolve(import.meta.dirname, "..", ".insight-test-progress");

function writeProject(dir: string): void {
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "proj", version: "0.0.0", private: true }));
  writeFileSync(join(dir, "src/a.ts"), "export const a = 1;\n");
}

function fakeReport(snapshot: string): IndexReport {
  return {
    projectPath: "",
    durationMs: 1,
    snapshot,
    snapshotChanged: true,
    nodes: 0,
    edges: 0,
    findings: 0,
    resolved: 0,
    unresolved: 0,
    frontends: [],
    skipped: [],
    disabled: [],
    extracted: [],
    reused: 0,
    failed: [],
    removed: [],
    changes: { added: [], changed: [], removed: [] } as unknown as IndexReport["changes"],
    rehashed: 0,
    coverage: [],
    problems: [],
    logs: [],
    lenses: [],
  } as IndexReport;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("index progress", () => {
  const PROJECT = join(SCRATCH, "proj");
  const PROJECT2 = join(SCRATCH, "proj2");
  beforeAll(() => {
    rmSync(SCRATCH, { recursive: true, force: true });
    writeProject(PROJECT);
    writeProject(PROJECT2);
  });
  afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

  it("throttles same-stage updates, sends every stage change, and ends extract at done = total", async () => {
    const home = join(SCRATCH, "throttle-home");
    const server = await buildServer({
      home,
      intervalMs: 0,
      webDist: null,
      autostart: false,
      index: async (opts) => {
        const phase = (p: PhaseProgress) => opts.onPhase?.(p);
        phase({ phase: "scan", label: "Scanning files" });
        phase({ phase: "scan", label: "Scanning files", done: 1, total: 1 });
        for (let i = 0; i <= 500; i++) {
          phase({ phase: "extract", label: "Extracting · typescript", frontend: "typescript", step: 1, steps: 1, done: i, total: 500 });
        }
        phase({ phase: "link", label: "Linking" });
        return fakeReport("snapthrottle0000");
      },
    });
    try {
      const id = server.registry.add({ path: PROJECT }).id;
      const events: Extract<JobEvent, { type: "phase" }>[] = [];
      server.jobs.subscribe(id, (e) => {
        if (e.type === "phase") events.push(e);
      });
      server.jobs.trigger(id);
      await server.jobs.whenIdle(id);

      // 504 raw updates in a burst: far fewer phase events, but no stage change is lost.
      expect(events.length).toBeLessThan(20);
      const stages = events.map((e) => e.progress.phase);
      const ordered = stages.filter((s, i) => i === 0 || stages[i - 1] !== s);
      expect(ordered).toEqual(["scan", "extract", "link"]);

      const lastExtract = [...events].reverse().find((e) => e.progress.phase === "extract");
      expect(lastExtract?.progress.done).toBe(500);
      expect(lastExtract?.progress.total).toBe(500);

      // Within one stage, trailing sends are at least the throttle window apart (timer slack allowed). A send
      // that flushes the pending update just before a stage change is not a trailing send and is not checked.
      const same = (x: (typeof events)[number], y: (typeof events)[number]) =>
        x.progress.phase === y.progress.phase && x.progress.frontend === y.progress.frontend;
      for (let i = 1; i + 1 < events.length; i++) {
        const a = events[i - 1]!;
        const b = events[i]!;
        const next = events[i + 1]!;
        if (same(a, b) && same(b, next)) {
          expect(Date.parse(b.at) - Date.parse(a.at)).toBeGreaterThanOrEqual(130);
        }
      }

      // The run is over: no live stage, the recent lines are kept.
      expect(server.jobs.progressOf(id)).toBeUndefined();
    } finally {
      await server.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("replays status, the current stage and recent lines to a client that connects mid-run", async () => {
    const home = join(SCRATCH, "replay-home");
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const server = await buildServer({
      home,
      intervalMs: 0,
      webDist: null,
      autostart: false,
      index: async (opts) => {
        opts.onProgress?.("line one");
        opts.onPhase?.({ phase: "extract", label: "Extracting · typescript", frontend: "typescript", step: 1, steps: 1, done: 3, total: 9 });
        opts.onProgress?.("line two");
        await gate;
        return fakeReport("snapreplay000000");
      },
    });
    try {
      const id = server.registry.add({ path: PROJECT }).id;
      server.jobs.trigger(id);
      await sleep(20);
      await server.app.listen({ port: 0, host: "127.0.0.1" });
      const address = server.app.server.address();
      const port = typeof address === "object" && address ? address.port : 0;

      const text = await readUntil(`http://127.0.0.1:${port}/api/projects/${id}/events`, `"line":"line two"`);
      const statusAt = text.indexOf("event: status");
      const phaseAt = text.indexOf("event: phase");
      const replayOne = text.indexOf(`"line":"line one"`);
      const replayTwo = text.indexOf(`"line":"line two"`);
      expect(statusAt).toBeGreaterThanOrEqual(0);
      expect(phaseAt).toBeGreaterThan(statusAt);
      expect(text).toContain(`"done":3`);
      expect(replayOne).toBeGreaterThan(phaseAt);
      expect(replayTwo).toBeGreaterThan(replayOne);
      const replayLine = text.slice(replayOne, text.indexOf("}", replayOne));
      expect(replayLine).toContain(`"replay":true`);

      release();
      await server.jobs.whenIdle(id);
      expect(server.jobs.recentLines(id).map((r) => r.line)).toEqual(["line one", "line two"]);
    } finally {
      release();
      await server.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("includes progress in the project list only while the project is indexing", async () => {
    const home = join(SCRATCH, "list-home");
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const server = await buildServer({
      home,
      intervalMs: 0,
      webDist: null,
      autostart: false,
      index: async (opts) => {
        opts.onPhase?.({ phase: "link", label: "Linking" });
        await gate;
        return fakeReport("snaplist00000000");
      },
    });
    try {
      const id = server.registry.add({ path: PROJECT }).id;
      server.jobs.trigger(id);
      await sleep(20);
      const busy = await server.app.inject({ method: "GET", url: "/api/projects" });
      const busyProject = busy.json().projects.find((p: { id: string }) => p.id === id);
      expect(busyProject.status).toBe("indexing");
      expect(busyProject.progress.phase).toBe("link");
      expect(busyProject.progress.label).toBe("Linking");
      expect(typeof busyProject.progress.startedAt).toBe("string");

      release();
      await server.jobs.whenIdle(id);
      const idle = await server.app.inject({ method: "GET", url: "/api/projects" });
      const idleProject = idle.json().projects.find((p: { id: string }) => p.id === id);
      expect(idleProject.status).toBe("idle");
      expect(idleProject.progress).toBeUndefined();
    } finally {
      release();
      await server.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("starts no run by itself: not at startup, and one run when a project is added", async () => {
    const home = join(SCRATCH, "demand-home");
    // A project already registered before the server starts.
    new ProjectRegistry(home).add({ path: PROJECT });
    const calls: string[] = [];
    const server = await buildServer({
      home,
      webDist: null,
      index: async (opts) => {
        calls.push(opts.projectPath);
        return fakeReport("snapdemand000000");
      },
    });
    try {
      await sleep(50);
      expect(calls).toEqual([]);
      const [existing] = server.registry.list();
      expect(existing?.status).toBe("idle");

      const res = await server.app.inject({ method: "POST", url: "/api/projects", payload: { path: PROJECT2 } });
      expect(res.statusCode).toBe(201);
      const added = res.json().project.id as string;
      await server.jobs.whenIdle(added);
      expect(calls).toEqual([PROJECT2]);
    } finally {
      await server.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

/** Reads an SSE stream until the marker appears, then stops. */
async function readUntil(url: string, marker: string, timeoutMs = 10_000): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    while (!text.includes(marker)) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    await reader.cancel();
    return text;
  } finally {
    clearTimeout(timer);
  }
}
