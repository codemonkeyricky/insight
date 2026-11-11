import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stepFor, watchIndex, type PollStatus } from "../src/indexPoll";

describe("stepFor", () => {
  it("maps running to wait, done to done, failed to failed", () => {
    expect(stepFor({ state: "running", phase: "scan", done: 1, total: 4 })).toEqual({ kind: "wait" });
    expect(stepFor({ state: "done" })).toEqual({ kind: "done" });
    expect(stepFor({ state: "failed", error: { code: "too_large", message: "big" } })).toEqual({
      kind: "failed",
      error: { code: "too_large", message: "big" },
    });
  });

  it("gives a failed run with no error the generic code", () => {
    expect(stepFor({ state: "failed" })).toEqual({ kind: "failed", error: { code: "index_failed", message: "Indexing failed." } });
  });
});

describe("watchIndex", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /** A reader that hands out the given answers in order, the last one forever. */
  function reader(answers: (PollStatus | undefined | Error)[]) {
    let i = 0;
    return vi.fn(async () => {
      const a = answers[Math.min(i, answers.length - 1)];
      i += 1;
      if (a instanceof Error) throw a;
      return a;
    });
  }

  function hooks() {
    return { onProgress: vi.fn(), onDone: vi.fn(), onFailed: vi.fn(), onError: vi.fn() };
  }

  it("polls every 1.5 s, reports progress, then ends on done", async () => {
    const read = reader([
      { state: "running", phase: "scan", done: 1, total: 4 },
      { state: "running", phase: "extract", done: 3, total: 4 },
      { state: "done" },
    ]);
    const h = hooks();
    watchIndex({ read, ...h });
    expect(read).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1500);
    expect(read).toHaveBeenCalledTimes(1);
    expect(h.onProgress).toHaveBeenLastCalledWith({ state: "running", phase: "scan", done: 1, total: 4 });

    await vi.advanceTimersByTimeAsync(1500);
    expect(h.onProgress).toHaveBeenLastCalledWith({ state: "running", phase: "extract", done: 3, total: 4 });
    expect(h.onDone).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1500);
    expect(h.onDone).toHaveBeenCalledTimes(1);
    expect(h.onFailed).not.toHaveBeenCalled();

    // Nothing is read once the run has ended.
    await vi.advanceTimersByTimeAsync(10000);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("ends on failed with the server's error", async () => {
    const read = reader([{ state: "running" }, { state: "failed", error: { code: "timeout", message: "stopped" } }]);
    const h = hooks();
    watchIndex({ read, ...h });
    await vi.advanceTimersByTimeAsync(3000);
    expect(h.onFailed).toHaveBeenCalledWith({ code: "timeout", message: "stopped" });
    expect(h.onDone).not.toHaveBeenCalled();
  });

  it("gives up as failed when no status is written", async () => {
    const read = reader([undefined]);
    const h = hooks();
    watchIndex({ read, maxMissing: 3, ...h });
    await vi.advanceTimersByTimeAsync(10000);
    expect(read).toHaveBeenCalledTimes(3);
    expect(h.onFailed).toHaveBeenCalledWith({ code: "index_failed", message: "The server wrote no status for this run." });
  });

  it("reports an error after repeated read failures, and recovers from a single one", async () => {
    const read = reader([new Error("offline"), { state: "running" }, new Error("offline"), new Error("offline"), new Error("offline")]);
    const h = hooks();
    watchIndex({ read, ...h });
    await vi.advanceTimersByTimeAsync(1500); // first error
    await vi.advanceTimersByTimeAsync(1500); // recovers
    expect(h.onError).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(4500); // three errors in a row
    expect(h.onError).toHaveBeenCalledTimes(1);
  });

  it("stops when the returned function is called", async () => {
    const read = reader([{ state: "running" }]);
    const h = hooks();
    const stop = watchIndex({ read, ...h });
    await vi.advanceTimersByTimeAsync(1500);
    stop();
    await vi.advanceTimersByTimeAsync(10000);
    expect(read).toHaveBeenCalledTimes(1);
    expect(h.onDone).not.toHaveBeenCalled();
  });
});
