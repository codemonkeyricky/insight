import { afterEach, describe, expect, it, vi } from "vitest";
import type { ElkNode } from "elkjs/lib/elk-api";
import { createWorkerSolver } from "../src/states/elkClient";

class FakeWorker {
  terminated = false;
  posted: unknown[] = [];
  onmessage: ((a: { data: unknown }) => void) | null = null;
  listeners = new Map<string, ((ev: unknown) => void)[]>();
  postMessage(m: unknown) {
    this.posted.push(m);
  }
  addEventListener(t: string, f: (ev: unknown) => void) {
    this.listeners.set(t, [...(this.listeners.get(t) ?? []), f]);
  }
  terminate() {
    this.terminated = true;
  }
  emit(t: string, ev: unknown = {}) {
    for (const f of this.listeners.get(t) ?? []) f(ev);
  }
  /** Answer the latest layout request. */
  answer(graph: ElkNode) {
    const req = [...this.posted].reverse().find((m) => (m as { cmd?: string }).cmd === "layout") as { id: number };
    this.onmessage?.({ data: { id: req.id, data: graph } });
  }
}

const setup = (ms?: number) => {
  const workers: FakeWorker[] = [];
  const solve = createWorkerSolver(() => {
    const w = new FakeWorker();
    workers.push(w);
    return w as unknown as Worker;
  }, ms);
  return { workers, solve };
};
const g: ElkNode = { id: "root" };

afterEach(() => vi.useRealTimers());

describe("createWorkerSolver", () => {
  it("terminates the worker on error and the next layout makes a new one", async () => {
    const { workers, solve } = setup();
    const p = solve(g);
    expect(workers).toHaveLength(1);
    workers[0]!.emit("error", { message: "boom" });
    await expect(p).rejects.toThrow(/boom/);
    expect(workers[0]!.terminated).toBe(true);
    const p2 = solve(g);
    expect(workers).toHaveLength(2);
    workers[1]!.answer({ id: "root", width: 5 });
    await expect(p2).resolves.toMatchObject({ width: 5 });
  });

  it("terminates the worker on messageerror", async () => {
    const { workers, solve } = setup();
    const p = solve(g);
    workers[0]!.emit("messageerror");
    await expect(p).rejects.toThrow(/failed/);
    expect(workers[0]!.terminated).toBe(true);
  });

  it("a late error from an old worker does not reject the new client's layouts", async () => {
    const { workers, solve } = setup();
    const p1 = solve(g);
    workers[0]!.emit("error", { message: "first" });
    await expect(p1).rejects.toThrow();
    const p2 = solve(g);
    workers[0]!.emit("error", { message: "late" });
    expect(workers[1]!.terminated).toBe(false);
    workers[1]!.answer({ id: "root", width: 7 });
    await expect(p2).resolves.toMatchObject({ width: 7 });
    const p3 = solve(g);
    expect(workers).toHaveLength(2);
    workers[1]!.answer({ id: "root", width: 8 });
    await expect(p3).resolves.toMatchObject({ width: 8 });
  });

  it("terminates the worker on a timeout and starts a fresh one next time", async () => {
    vi.useFakeTimers();
    const { workers, solve } = setup(1000);
    const p = solve(g);
    const assertion = expect(p).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(1001);
    await assertion;
    expect(workers[0]!.terminated).toBe(true);
    void solve(g);
    expect(workers).toHaveLength(2);
  });

  it("(a) a timeout of A resubmits queued B to a fresh worker, which resolves", async () => {
    vi.useFakeTimers();
    const { workers, solve } = setup(1000);
    const pa = solve(g);
    const pb = solve({ id: "b" });
    const ea = expect(pa).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(1001);
    await ea;
    expect(workers[0]!.terminated).toBe(true);
    expect(workers).toHaveLength(2);
    workers[1]!.answer({ id: "b", width: 3 });
    await vi.advanceTimersByTimeAsync(1);
    await expect(pb).resolves.toMatchObject({ width: 3 });
  });

  it("B's timeout starts when it is sent, not when queued", async () => {
    vi.useFakeTimers();
    const { workers, solve } = setup(1000);
    const pa = solve(g);
    const pb = solve({ id: "b" });
    await vi.advanceTimersByTimeAsync(900);
    workers[0]!.answer({ id: "root", width: 1 });
    await vi.advanceTimersByTimeAsync(1);
    await pa;
    await vi.advanceTimersByTimeAsync(900);
    workers[0]!.answer({ id: "b", width: 2 });
    await vi.advanceTimersByTimeAsync(1);
    await expect(pb).resolves.toMatchObject({ width: 2 });
  });

  it("(b) aborting a queued job removes it and it never runs", async () => {
    const { workers, solve } = setup();
    const ctl = new AbortController();
    const pa = solve(g);
    const pb = solve({ id: "b" }, ctl.signal);
    ctl.abort();
    await expect(pb).rejects.toMatchObject({ name: "AbortError" });
    workers[0]!.answer({ id: "root", width: 1 });
    await pa;
    expect(workers).toHaveLength(1);
    expect(workers[0]!.posted.filter((m) => (m as { cmd?: string }).cmd === "layout")).toHaveLength(1);
  });

  it("(c) aborting the only running job terminates the worker", async () => {
    const { workers, solve } = setup();
    const ctl = new AbortController();
    const p = solve(g, ctl.signal);
    ctl.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    expect(workers[0]!.terminated).toBe(true);
  });
});
