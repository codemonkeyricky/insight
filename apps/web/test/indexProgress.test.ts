import { describe, expect, it } from "vitest";
import type { PhaseProgress, RunProgress } from "../src/api";
import { initialIndexState, LOG_LIMIT, progressFraction, reduceIndexState, type IndexState } from "../src/indexProgress";
import type { RunEvent } from "../src/useEvents";

const T0 = "2026-11-10T10:00:00.000Z";
const run = (over: Partial<RunProgress>): RunProgress => ({
  phase: "scan",
  label: "Scanning files",
  startedAt: T0,
  phaseStartedAt: T0,
  full: false,
  ...over,
});

/** A recorded run: two frontends extract, the counted phases move, the rest sit at their start. */
const recorded: PhaseProgress[] = [
  { phase: "fetch", label: "Fetching" },
  { phase: "scan", label: "Scanning files" },
  { phase: "scan", label: "Scanning files", total: 900 },
  { phase: "extract", label: "Extracting · typescript", frontend: "typescript", step: 1, steps: 2, done: 0, total: 491 },
  { phase: "extract", label: "Extracting · typescript", frontend: "typescript", step: 1, steps: 2, done: 120, total: 491 },
  { phase: "extract", label: "Extracting · typescript", frontend: "typescript", step: 1, steps: 2, done: 312, total: 491 },
  { phase: "extract", label: "Extracting · typescript", frontend: "typescript", step: 1, steps: 2, done: 491, total: 491 },
  { phase: "extract", label: "Extracting · python", frontend: "python", step: 2, steps: 2, done: 0, total: 50 },
  { phase: "extract", label: "Extracting · python", frontend: "python", step: 2, steps: 2, done: 50, total: 50 },
  { phase: "link", label: "Linking" },
  { phase: "analyze", label: "Running lenses", done: 0, total: 3 },
  { phase: "analyze", label: "Running lenses", done: 2, total: 3 },
  { phase: "analyze", label: "Running lenses", done: 3, total: 3 },
  { phase: "save", label: "Saving" },
];

describe("progressFraction", () => {
  it("never decreases across a recorded run and reaches 1 at save", () => {
    const fractions = recorded.map(progressFraction);
    for (let i = 1; i < fractions.length; i++) {
      expect(fractions[i]).toBeGreaterThanOrEqual(fractions[i - 1]!);
    }
    expect(fractions.at(-1)).toBe(1);
  });

  it("starts each phase where the one before it ended, with the weights summing to one", () => {
    expect(progressFraction({ phase: "fetch", label: "" })).toBe(0);
    expect(progressFraction({ phase: "scan", label: "" })).toBeCloseTo(0.05);
    expect(progressFraction({ phase: "link", label: "" })).toBeCloseTo(0.8);
    expect(progressFraction({ phase: "analyze", label: "" })).toBeCloseTo(0.9);
    expect(progressFraction({ phase: "analyze", label: "", done: 3, total: 3 })).toBeCloseTo(0.97);
  });

  it("fills extract across its frontends in turn, and an empty count is the start of the phase", () => {
    expect(progressFraction({ phase: "extract", label: "", step: 1, steps: 2, done: 491, total: 491 })).toBeCloseTo(0.1 + 0.35);
    expect(progressFraction({ phase: "extract", label: "", step: 2, steps: 2, done: 0, total: 50 })).toBeCloseTo(0.1 + 0.35);
    expect(progressFraction({ phase: "extract", label: "", done: 0, total: 0 })).toBeCloseTo(0.1);
    // Without the detect pass's steps the frontend is the only one: the whole extract share.
    expect(progressFraction({ phase: "extract", label: "", done: 491, total: 491 })).toBeCloseTo(0.8);
  });
});

describe("index run reducer", () => {
  const phase = (p: RunProgress): RunEvent => ({ type: "phase", projectId: "p", progress: p, at: T0 });
  const line = (text: string, at: string, replay = false): RunEvent => ({ type: "progress", projectId: "p", line: text, at, replay });

  it("merges replayed and live lines once each", () => {
    let state: IndexState = initialIndexState;
    state = reduceIndexState(state, { type: "event", event: phase(run({ startedAt: T0 })) });
    // The connect replays two lines; a third arrives live and overlaps the replay's last one.
    state = reduceIndexState(state, { type: "event", event: line("fetching a", "2026-11-10T10:00:01.000Z", true) });
    state = reduceIndexState(state, { type: "event", event: line("extract b", "2026-11-10T10:00:02.000Z", true) });
    state = reduceIndexState(state, { type: "event", event: line("extract b", "2026-11-10T10:00:02.000Z") });
    state = reduceIndexState(state, { type: "event", event: line("link c", "2026-11-10T10:00:03.000Z") });
    expect(state.entries.map((e) => e.text)).toEqual(["10:00:01  fetching a", "10:00:02  extract b", "10:00:03  link c"]);
  });

  it("keeps the last LOG_LIMIT lines", () => {
    let state: IndexState = reduceIndexState(initialIndexState, { type: "event", event: phase(run({})) });
    for (let i = 0; i < LOG_LIMIT + 5; i++) {
      const at = new Date(Date.parse(T0) + i * 1000).toISOString();
      state = reduceIndexState(state, { type: "event", event: line(`n${i}`, at) });
    }
    expect(state.entries).toHaveLength(LOG_LIMIT);
    expect(state.entries[0]!.text).toContain("n5");
  });

  it("clears the last run's lines when a new run starts, and keeps them within a run", () => {
    let state = reduceIndexState(initialIndexState, { type: "event", event: phase(run({ startedAt: T0 })) });
    state = reduceIndexState(state, { type: "event", event: line("old", T0) });
    state = reduceIndexState(state, { type: "event", event: phase(run({ startedAt: T0, phase: "link", label: "Linking" })) });
    expect(state.entries).toHaveLength(1);
    state = reduceIndexState(state, { type: "event", event: phase(run({ startedAt: "2026-11-10T11:00:00.000Z" })) });
    expect(state.entries).toHaveLength(0);
  });

  it("never lets the shown fraction go down within a run", () => {
    let state = reduceIndexState(initialIndexState, { type: "event", event: phase(run({ phase: "extract", label: "", done: 300, total: 491 })) });
    const high = state.fraction;
    state = reduceIndexState(state, { type: "event", event: phase(run({ phase: "extract", label: "", done: 100, total: 491 })) });
    expect(state.fraction).toBe(high);
    expect(state.progress?.done).toBe(100);
  });

  it("ends a run as done or failed", () => {
    let state = reduceIndexState(initialIndexState, { type: "event", event: phase(run({ phase: "link", label: "Linking" })) });
    expect(state.running).toBe(true);
    state = reduceIndexState(state, { type: "event", event: { type: "failed", projectId: "p", error: "boom", at: T0 } });
    expect(state.running).toBe(false);
    expect(state.lastError).toBe("boom");
    state = reduceIndexState(state, { type: "event", event: { type: "done", projectId: "p", at: "2026-11-10T10:01:00.000Z" } });
    expect(state.running).toBe(false);
    expect(state.fraction).toBe(1);
    expect(state.finishedAt).toBe("2026-11-10T10:01:00.000Z");
    expect(state.lastError).toBeUndefined();
  });
});
