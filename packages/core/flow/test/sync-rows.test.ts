import { describe, expect, it } from "vitest";
import type { IREdge, IRNode } from "@insight/ir";
import { couplingChart, couplingFacts, type Item } from "../src/index.js";
import { measure } from "../src/layout.js";
import { indexFixture } from "./coupling-fixture.js";

// Synchronisation and channel rows, lock frames, and their conc coupling. The IR is built by hand (no frontend): one file,
// functions as `structure.function` nodes, their facts as children of those functions, and calls as `calls.call` edges.

const FILE = "src/queue.cc";
const PROVENANCE = { frontend: "test", confidence: "exact" as const };
const fid = (name: string) => `${FILE}#${name}`;

/** A function spanning lines `start`..`end` (0-based). */
function fn(name: string, start: number, end: number): IRNode {
  return {
    id: fid(name),
    facet: "structure",
    kind: "structure.function",
    span: { file: FILE, start: [start, 0], end: [end, 1] },
    attrs: { name, qualifiedName: name },
    provenance: PROVENANCE,
  } as IRNode;
}

/** A fact of `parent` on line `line` (columns 2..30), with its IR facet and kind. */
function fact(id: string, parent: string, facet: string, kind: string, line: number, attrs: Record<string, unknown> = {}): IRNode {
  return {
    id,
    parent,
    facet,
    kind,
    span: { file: FILE, start: [line, 2], end: [line, 30] },
    attrs,
    provenance: PROVENANCE,
  } as IRNode;
}

/** A block-like fact spanning several lines (a branch or one of its arms). */
function block(id: string, parent: string, kind: string, from: number, to: number, attrs: Record<string, unknown> = {}): IRNode {
  return {
    id,
    parent,
    facet: "flow",
    kind,
    span: { file: FILE, start: [from, 2], end: [to, 3] },
    attrs,
    provenance: PROVENANCE,
  } as IRNode;
}

const callEdge = (from: string, to: string, line: number): IREdge =>
  ({
    from,
    to,
    facet: "calls",
    kind: "calls.call",
    span: { file: FILE, start: [line, 2], end: [line, 8] },
    attrs: { callee: to.split("#")[1] ?? to },
    provenance: PROVENANCE,
  }) as IREdge;

const lockAcquire = (fnName: string, line: number, lock: string, mode?: string) =>
  fact(`${fnName}:acq:${line}`, fid(fnName), "sync", "sync.lock-acquire", line, { lock, ...(mode !== undefined ? { mode } : {}) });
const lockRelease = (fnName: string, line: number, lock: string) => fact(`${fnName}:rel:${line}`, fid(fnName), "sync", "sync.lock-release", line, { lock });
const write = (fnName: string, line: number, name: string) => fact(`${fnName}:eff:${line}`, fid(fnName), "effects", "effects.write", line, { name });

/** Facts of one function's items, by the labels of its chart. */
function itemsOf(nodes: IRNode[], edges: IREdge[], name: string): Item[] {
  const facts = couplingFacts(nodes, edges).facts.get(fid(name));
  if (facts === undefined) throw new Error(`no facts for ${name}`);
  return facts.items;
}

/** The step labels of a list, in order (forks and loops are not expanded). */
const labels = (items: readonly Item[]) => items.map((i) => (i.t === "step" ? i.label : i.t === "fork" ? `fork:${i.role}` : i.t));

type Fork = Extract<Item, { t: "fork" }>;
const forkOf = (items: readonly Item[], index: number): Fork => {
  const it = items[index];
  if (it === undefined || it.t !== "fork") throw new Error(`item ${index} is not a fork: ${JSON.stringify(labels(items))}`);
  return it;
};

describe("sync rows and lock frames", () => {
  it("a: producer and consumer share a lock, a condvar and a queue", () => {
    const nodes: IRNode[] = [
      fn("publish", 10, 20),
      lockAcquire("publish", 11, "queue_mu"),
      write("publish", 12, "push_back"),
      fact("publish:notify", fid("publish"), "sync", "sync.condvar", 14, { op: "notify", name: "cv" }),
      lockRelease("publish", 16, "queue_mu"),
      fn("take", 22, 30),
      lockAcquire("take", 23, "queue_mu"),
      fact("take:wait", fid("take"), "sync", "sync.condvar", 24, { op: "wait", name: "cv", lock: "queue_mu" }),
      lockRelease("take", 26, "queue_mu"),
    ];
    const publish = itemsOf(nodes, [], "publish");
    expect(publish).toHaveLength(1);
    const frame = forkOf(publish, 0);
    expect(frame.role).toBe("lock");
    expect(frame.label).toBe("🔒 queue_mu");
    expect(frame.lock).toBe("queue_mu");
    expect(labels(frame.arms[0]?.body ?? [])).toEqual(["write · push_back", "↻ notify cv", "🔓 queue_mu"]);

    const take = itemsOf(nodes, [], "take");
    const takeFrame = forkOf(take, 0);
    expect(labels(takeFrame.arms[0]?.body ?? [])).toEqual(["⏸ wait cv (queue_mu)", "🔓 queue_mu"]);
  });

  it("b: an RAII guard inside a branch arm runs to the end of that arm", () => {
    const nodes: IRNode[] = [
      fn("drain", 40, 50),
      block("drain:if", fid("drain"), "flow.branch", 41, 45, { condition: "n > 0" }),
      block("drain:then", fid("drain"), "flow.branch-arm", 41, 44, { label: "then" }),
      fact("drain:guard", fid("drain"), "sync", "x-cpp.scoped-lock", 42, { lock: "queue_mu", mode: "exclusive", api: "std::lock_guard" }),
      write("drain", 43, "flush"),
      write("drain", 47, "after"),
    ];
    const items = itemsOf(nodes, [], "drain");
    // The branch fork, then the write after the branch, outside any frame.
    const branch = items.find((i) => i.t === "fork");
    expect(branch?.t === "fork" && branch.role).toBe("branch");
    const thenArm = branch?.t === "fork" ? branch.arms.find((a) => a.kind === "true") : undefined;
    expect(thenArm).toBeDefined();
    const frame = forkOf(thenArm?.body ?? [], 0);
    expect(frame.role).toBe("lock");
    expect(labels(frame.arms[0]?.body ?? [])).toEqual(["write · flush"]);
    const tail = items.filter((i) => i.t === "step").map((i) => (i.t === "step" ? i.label : ""));
    expect(tail).toEqual(["write · after"]);
  });

  it("c: a BroadcastChannel send and recv in two functions", () => {
    const nodes: IRNode[] = [
      fn("producer", 1, 5),
      fact("producer:send", fid("producer"), "concurrency", "concurrency.channel-send", 3, { channel: "jobs", api: "BroadcastChannel.postMessage" }),
      fn("consumer", 7, 11),
      fact("consumer:recv", fid("consumer"), "concurrency", "concurrency.channel-recv", 9, { channel: "jobs", api: "BroadcastChannel.onmessage" }),
    ];
    expect(labels(itemsOf(nodes, [], "producer"))).toEqual(["▶ send jobs"]);
    expect(labels(itemsOf(nodes, [], "consumer"))).toEqual(["◀ recv jobs"]);
  });

  it("d: a dynamic channel is shown unpaired", () => {
    const nodes: IRNode[] = [
      fn("sender", 1, 5),
      fact("sender:send", fid("sender"), "concurrency", "concurrency.channel-send", 3, { channel: "<dynamic>" }),
    ];
    expect(labels(itemsOf(nodes, [], "sender"))).toEqual(["▶ send ⟨dynamic⟩"]);
  });

  it("e: a lock taken in a same-module helper is hoisted into the caller's coupling row", () => {
    const nodes: IRNode[] = [
      fn("push", 1, 8),
      fact("push:call", fid("push"), "calls", "calls.call", 4, {}),
      fn("helper", 20, 24),
      lockAcquire("helper", 21, "queue_mu"),
      lockRelease("helper", 22, "queue_mu"),
    ];
    // The helper's call is a real call edge, so the caller's chart has a call row for it.
    const edges = [callEdge(fid("push"), fid("helper"), 4)];
    const { modules, facts, footprints } = couplingFacts(nodes, edges);
    const caller = facts.get(fid("push"));
    expect(caller).toBeDefined();
    const chart = couplingChart(fid("push"), caller?.items ?? [], modules, footprints);
    const call = chart.items.find((i) => i.t === "step" && i.label.startsWith("helper()"));
    expect(call?.t === "step" && call.coupling).toBe("conc");
    expect(call?.t === "step" && call.label).toBe("helper() ⇢ lock queue_mu");
    expect(footprints.get(fid("helper"))?.entries.map((e) => [e.cls, e.label])).toEqual([["conc", "lock queue_mu"]]);
  });

  it("f: nested locks give nested frames", () => {
    const nodes: IRNode[] = [
      fn("nest", 1, 10),
      lockAcquire("nest", 2, "outer_mu"),
      lockAcquire("nest", 3, "inner_mu"),
      write("nest", 4, "touch"),
      lockRelease("nest", 5, "inner_mu"),
      lockRelease("nest", 6, "outer_mu"),
    ];
    const items = itemsOf(nodes, [], "nest");
    const outer = forkOf(items, 0);
    expect(outer.lock).toBe("outer_mu");
    const outerBody = outer.arms[0]?.body ?? [];
    const inner = forkOf(outerBody, 0);
    expect(inner.lock).toBe("inner_mu");
    expect(labels(inner.arms[0]?.body ?? [])).toEqual(["write · touch", "🔓 inner_mu"]);
    expect(labels(outerBody.slice(1))).toEqual(["🔓 outer_mu"]);
  });

  it("g: in the coupling chart, local rows inside a lock frame fold and the head stays conc", () => {
    const nodes: IRNode[] = [
      fn("guarded", 1, 10),
      lockAcquire("guarded", 2, "queue_mu"),
      fact("guarded:call", fid("guarded"), "calls", "calls.call", 3, {}),
      lockRelease("guarded", 5, "queue_mu"),
      fn("pure", 30, 33),
    ];
    const edges = [callEdge(fid("guarded"), fid("pure"), 3)];
    const { modules, facts, footprints } = couplingFacts(nodes, edges);
    const chart = couplingChart(fid("guarded"), facts.get(fid("guarded"))?.items ?? [], modules, footprints);
    const frame = forkOf(chart.items, 0);
    expect(frame.role).toBe("lock");
    expect(frame.coupling).toBe("conc");
    const body = frame.arms[0]?.body ?? [];
    expect(body[0]?.t === "step" && body[0].role).toBe("marker");
    expect(body[0]?.t === "step" && body[0].label).toBe("⋯ 1 local");
    expect(labels(body.slice(1))).toEqual(["🔓 queue_mu"]);
  });

  it("h: the coupling-chart await label carries the suspension marker", () => {
    const nodes: IRNode[] = [fn("task", 1, 5), fact("task:await", fid("task"), "concurrency", "concurrency.await", 3)];
    const chart = couplingChart(fid("task"), itemsOf(nodes, [], "task"), couplingFacts(nodes, []).modules, couplingFacts(nodes, []).footprints);
    const aw = chart.items.find((i) => i.t === "step" && i.role === "await");
    expect(aw?.t === "step" && aw.label).toBe("⏸ await");
    expect(aw?.t === "step" && aw.title).toBe("await (other coroutines may run here)");
  });
});

describe("lock frames that cross, and what they count", () => {
  it("frames no pair of locks that cross, and keeps both as plain rows in source order", () => {
    const nodes: IRNode[] = [
      fn("cross", 10, 20),
      lockAcquire("cross", 11, "a"),
      lockAcquire("cross", 12, "b"),
      write("cross", 13, "x"),
      lockRelease("cross", 14, "a"),
      write("cross", 15, "y"),
      lockRelease("cross", 16, "b"),
    ];
    const items = itemsOf(nodes, [], "cross");
    expect(items.some((i) => i.t === "fork")).toBe(false);
    expect(labels(items)).toEqual(["🔒 a", "🔒 b", "write · x", "🔓 a", "write · y", "🔓 b"]);
  });

  it("still frames locks that nest, with the inner one inside the outer", () => {
    const nodes: IRNode[] = [
      fn("nest", 10, 20),
      lockAcquire("nest", 11, "a"),
      lockAcquire("nest", 12, "b"),
      write("nest", 13, "x"),
      lockRelease("nest", 14, "b"),
      lockRelease("nest", 15, "a"),
    ];
    const outer = forkOf(itemsOf(nodes, [], "nest"), 0);
    expect(outer.role).toBe("lock");
    expect(labels(outer.arms[0]?.body ?? [])).toEqual(["fork:lock", "🔓 a"]);
  });

  it("does not count a function's lock frame as a try", () => {
    const nodes: IRNode[] = [fn("hold", 10, 20), lockAcquire("hold", 11, "m"), write("hold", 12, "x"), lockRelease("hold", 13, "m")];
    const items = itemsOf(nodes, [], "hold");
    expect(items.some((i) => i.t === "fork" && i.role === "lock")).toBe(true);
    expect(measure(items).tries).toBe(0);
  });

  it("keeps the (shared) suffix on a lock frame's footprint entry, as a lone acquire row keeps it", () => {
    const nodes: IRNode[] = [
      fn("hold", 10, 20),
      fact("hold:acq", fid("hold"), "sync", "sync.lock-acquire", 11, { lock: "queue_mu", mode: "shared" }),
      write("hold", 12, "push_back"),
      lockRelease("hold", 14, "queue_mu"),
    ];
    const ix = couplingFacts(nodes, []);
    const f = ix.facts.get(fid("hold"));
    if (!f) throw new Error("no facts for hold");
    const { info } = couplingChart(fid("hold"), f.items, ix.modules, ix.footprints);
    expect(info.footprint.entries.map((e) => e.label)).toContain("lock queue_mu (shared)");
  });
});

describe("unnamed locks", () => {
  it("leaves unnamed acquires and releases as plain rows, never framed with each other", () => {
    const nodes: IRNode[] = [
      fn("grab", 60, 70),
      fact("grab:acq1", fid("grab"), "sync", "sync.lock-acquire", 61, {}),
      write("grab", 62, "a"),
      fact("grab:rel1", fid("grab"), "sync", "sync.lock-release", 63, {}),
      fact("grab:acq2", fid("grab"), "sync", "sync.lock-acquire", 64, {}),
      write("grab", 65, "b"),
      fact("grab:rel2", fid("grab"), "sync", "sync.lock-release", 66, {}),
    ];
    const items = itemsOf(nodes, [], "grab");
    expect(items.some((i) => i.t === "fork")).toBe(false);
    expect(labels(items)).toEqual(["🔒 (unnamed)", "write · a", "🔓 (unnamed)", "🔒 (unnamed)", "write · b", "🔓 (unnamed)"]);
  });
});

describe("lock frames need a release or a scoped guard", () => {
  const webLockAcquire = (fnName: string, line: number, lock: string) =>
    fact(`${fnName}:web:${line}`, fid(fnName), "sync", "sync.lock-acquire", line, { lock, api: "navigator.locks.request" });
  const guardAcquire = (fnName: string, line: number, lock: string) =>
    fact(`${fnName}:guard:${line}`, fid(fnName), "sync", "x-cpp.scoped-lock", line, { lock, mode: "exclusive", api: "std::lock_guard" });

  it("leaves two Web Lock requests with no release as plain rows, the second not nested under the first", () => {
    const nodes: IRNode[] = [fn("work", 10, 20), webLockAcquire("work", 11, "cache"), webLockAcquire("work", 12, "other"), write("work", 13, "x")];
    const items = itemsOf(nodes, [], "work");
    expect(items.some((i) => i.t === "fork")).toBe(false);
    expect(labels(items)).toEqual(["🔒 cache", "🔒 other", "write · x"]);
  });

  it("frames a C++ scoped guard with no release to the end of the list", () => {
    const nodes: IRNode[] = [fn("guard", 10, 20), guardAcquire("guard", 11, "m"), write("guard", 12, "x"), write("guard", 13, "y")];
    const frame = forkOf(itemsOf(nodes, [], "guard"), 0);
    expect(frame.role).toBe("lock");
    expect(labels(frame.arms[0]?.body ?? [])).toEqual(["write · x", "write · y"]);
  });

  it("frames an acquire with a matching release only up to the release", () => {
    const nodes: IRNode[] = [fn("bounded", 10, 20), lockAcquire("bounded", 11, "m"), write("bounded", 12, "x"), lockRelease("bounded", 13, "m"), write("bounded", 14, "y")];
    const items = itemsOf(nodes, [], "bounded");
    const frame = forkOf(items, 0);
    expect(labels(frame.arms[0]?.body ?? [])).toEqual(["write · x", "🔓 m"]);
    expect(labels(items)).toEqual(["fork:lock", "write · y"]);
  });

  it("keeps <dynamic> locks from pairing, so nested <dynamic> acquires stay plain rows", () => {
    const nodes: IRNode[] = [
      fn("dyn", 10, 20),
      lockAcquire("dyn", 11, "<dynamic>"),
      lockAcquire("dyn", 12, "<dynamic>"),
      write("dyn", 13, "x"),
      lockRelease("dyn", 14, "<dynamic>"),
      lockRelease("dyn", 15, "<dynamic>"),
    ];
    const items = itemsOf(nodes, [], "dyn");
    expect(items.some((i) => i.t === "fork")).toBe(false);
    expect(labels(items)).toEqual(["🔒 <dynamic>", "🔒 <dynamic>", "write · x", "🔓 <dynamic>", "🔓 <dynamic>"]);
  });

  it("frames the TS frontend's lockWork: the second request is a plain row, not nested under cache", async () => {
    const src = [
      "export function lockWork(name: string): void {",
      '  navigator.locks.request("cache", async () => undefined);',
      "  navigator.locks.request(name, async () => undefined);",
      "}",
      "",
    ].join("\n");
    const { nodes, edges } = await indexFixture({ "src/lib/channels.ts": src });
    const facts = couplingFacts(nodes, edges).facts.get("src/lib/channels.ts#lockWork");
    if (facts === undefined) throw new Error("no facts for lockWork");
    expect(facts.items.some((i) => i.t === "fork")).toBe(false);
    expect(labels(facts.items)).toEqual(["🔒 cache", "🔒 <dynamic>"]);
  });
});
