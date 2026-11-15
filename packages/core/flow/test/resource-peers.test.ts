import { describe, expect, it } from "vitest";
import type { ExecModel, ExecResource, ExecThread } from "../src/exec-model.js";
import { withResourcePeers } from "../src/resource-peers.js";
import type { FlowNode, FunctionFlow } from "../src/types.js";

const node = (id: string, role: FlowNode["role"], label: string): FlowNode =>
  ({ id, role, shape: "box", label }) as unknown as FlowNode;

const chartOf = (nodes: FlowNode[]): FunctionFlow => ({ id: "src/a.ts#worker", name: "worker", async: false, nodes, edges: [] }) as unknown as FunctionFlow;

const thread = (id: string, kind: ExecThread["kind"], roots: string[]): ExecThread =>
  ({ id, kind, grounded: true, roots, reach: roots.length, reached: roots, coroutines: [], coroutineOnly: [] }) as unknown as ExecThread;

const res = (kind: ExecResource["kind"], name: string, sites: ExecResource["sites"]): ExecResource => ({ id: `${kind}:${name}`, kind, name, threads: [], sites });

const model = (resources: ExecResource[]): ExecModel =>
  ({
    scope: "src",
    truncated: false,
    functions: [
      { id: "src/a.ts#worker", name: "worker", file: "src/a.ts", line: 1, inScope: true, runtime: "thread" },
      { id: "src/a.ts#consume", name: "consume", file: "src/a.ts", line: 5, inScope: true, runtime: "thread" },
      { id: "src/a.ts#produce", name: "produce", file: "src/a.ts", line: 9, inScope: true, runtime: "thread" },
      { id: "src/a.ts#reader", name: "reader", file: "src/a.ts", line: 13, inScope: true, runtime: "thread" },
    ],
    threads: [
      thread("main:a", "main", ["src/a.ts#produce"]),
      thread("spawn:1", "thread", ["src/a.ts#consume"]),
      thread("spawn:2", "thread", ["src/a.ts#reader"]),
    ],
    programs: [],
    resources,
  }) as unknown as ExecModel;

const site = (fn: string, op: "acquire" | "send" | "recv" | "release", line: number) => ({ fn, op, file: "src/a.ts", line });

describe("withResourcePeers", () => {
  it("names the receiver of a send, with its thread", () => {
    const m = model([res("channel", "jobs", [site("src/a.ts#consume", "recv", 6), site("src/a.ts#worker", "send", 2)])]);
    const chart = chartOf([node("1", "sync", "▶ send jobs")]);
    const out = withResourcePeers(chart, "src/a.ts#worker", m);
    expect(out.nodes[0]?.title).toBe("▶ send jobs · → consume @ Thread · consume");
    expect(out.nodes[0]?.label).toBe("▶ send jobs");
  });

  it("names the sender of a recv, with its thread", () => {
    const m = model([res("channel", "jobs", [site("src/a.ts#produce", "send", 10), site("src/a.ts#consume", "recv", 6)])]);
    const chart = chartOf([node("1", "sync", "◀ recv jobs")]);
    const out = withResourcePeers(chart, "src/a.ts#consume", m);
    expect(out.nodes[0]?.title).toBe("◀ recv jobs · ← produce @ Main thread");
  });

  it("lists the other threads that take a lock, and leaves the lock's label as it is", () => {
    const m = model([res("lock", "queue_mu", [site("src/a.ts#worker", "acquire", 2), site("src/a.ts#reader", "acquire", 14), site("src/a.ts#produce", "acquire", 20)])]);
    const chart = chartOf([node("1", "sync", "🔒 queue_mu"), node("2", "sync", "🔒 queue_mu (shared)")]);
    const out = withResourcePeers(chart, "src/a.ts#worker", m);
    expect(out.nodes[0]?.label).toBe("🔒 queue_mu");
    expect(out.nodes[0]?.title).toBe("🔒 queue_mu · also taken on: Thread · reader, Main thread");
    expect(out.nodes[1]?.title).toBe("🔒 queue_mu (shared) · also taken on: Thread · reader, Main thread");
  });

  it("leaves non-sync rows and unmatched resources unchanged", () => {
    const m = model([res("channel", "jobs", [site("src/a.ts#consume", "recv", 6)])]);
    const chart = chartOf([node("1", "call", "▶ send jobs"), node("2", "sync", "▶ send other"), node("3", "sync", "🔒 nothing")]);
    const out = withResourcePeers(chart, "src/a.ts#worker", m);
    expect(out).toBe(chart);
  });

  it("returns the chart as it is when the model has no resources", () => {
    const chart = chartOf([node("1", "sync", "▶ send jobs")]);
    expect(withResourcePeers(chart, "src/a.ts#worker", model([]))).toBe(chart);
  });
});
