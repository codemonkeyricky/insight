import { describe, expect, it } from "vitest";
import type { IRDocument, IRNode, IREdge } from "@insight/ir";
import * as fx from "@insight/sdk/testing";
import { buildProjectModel, systemModel, type SystemModel } from "../src/index.js";

// Hand-built IR for the review fixes of the System tab: test-file spawns, test-file processes, message handoffs to an
// unthreaded handler, flat-mode syscall evidence.

const file = (path: string): IRNode => fx.node(path, "structure", "structure.file", { attrs: { path }, span: fx.span(path, 0, 0, 0, 0) });

function fn(path: string, name: string): IRNode {
  return fx.node(`${path}#${name}`, "structure", "structure.function", { attrs: { name }, parent: path, span: fx.span(path, 2, 0, 9, 1) });
}

function moduleFn(path: string, attrs: Record<string, unknown> = {}): IRNode {
  return fx.node(`${path}#(module)`, "structure", "structure.function", { attrs: { name: "(module)", module: true, ...attrs }, parent: path, span: fx.span(path, 0, 0, 0, 0) });
}

function effect(path: string, owner: string, line: number, kind: string, attrs: Record<string, unknown>): IRNode {
  return fx.node(`${path}@${kind}:${line}`, "effects", kind, { attrs, parent: `${path}#${owner}`, span: fx.span(path, line, 2, line, 20) });
}

/** A thread or process spawn in `owner`, and its spawns edge to `target`. */
function spawn(path: string, owner: string, line: number, target: string, how: "thread" | "process" = "thread"): { node: IRNode; edge: IREdge } {
  const id = `${path}@spawn:${line}`;
  const kind = how === "thread" ? "concurrency.spawn-thread" : "concurrency.spawn-process";
  const api = how === "thread" ? "std::thread" : "child_process.fork";
  return {
    node: fx.node(id, "concurrency", kind, { attrs: { api }, parent: `${path}#${owner}`, span: fx.span(path, line, 2, line, 20) }),
    edge: fx.edge(id, target, "concurrency", "concurrency.spawns", { attrs: { how }, span: fx.span(path, line, 2, line, 20) }),
  };
}

function dispatch(from: string, to: string, path: string, line: number, how: string): IREdge {
  return fx.edge(from, to, "concurrency", "concurrency.dispatches", { attrs: { how }, span: fx.span(path, line, 2, line, 12) });
}

const threadsOf = (s: SystemModel) => (s.runtimes ?? []).filter((r) => r.kind === "thread" && r.label !== "Main thread");

describe("System fixes: spawns from test files", () => {
  // src/main.ts starts a thread on src/worker.ts; test/spawn.test.ts starts one on its own helper.
  const doc = (): IRDocument => {
    const src = spawn("src/main.ts", "main", 12, "src/worker.ts#work");
    const tst = spawn("test/spawn.test.ts", "check", 5, "test/spawn.test.ts#helper");
    return {
      nodes: [
        file("package.json"), file("src/main.ts"), file("src/worker.ts"), file("test/spawn.test.ts"),
        moduleFn("src/main.ts", { nodeEntry: true }), fn("src/main.ts", "main"),
        fn("src/worker.ts", "work"),
        fn("test/spawn.test.ts", "check"), fn("test/spawn.test.ts", "helper"),
        src.node, tst.node,
      ],
      edges: [
        fx.edge("src/main.ts#(module)", "src/main.ts#main", "calls", "calls.call", { span: fx.span("src/main.ts", 1, 2, 1, 12) }),
        src.edge, tst.edge,
      ],
      findings: [],
    };
  };
  const sys = (tests: boolean): SystemModel => systemModel(buildProjectModel(doc()), "", { tests });

  it("draws the src thread alone when tests are off", () => {
    const threads = threadsOf(sys(false));
    expect(threads.map((t) => t.id)).toEqual(["thread:src/main.ts@spawn:12"]);
    expect(threads[0]?.label).toBe("Thread · std::thread");
  });

  it("draws the test-file thread too when tests are on", () => {
    expect(threadsOf(sys(true)).map((t) => t.id).sort()).toEqual(["thread:src/main.ts@spawn:12", "thread:test/spawn.test.ts@spawn:5"]);
  });
});

describe("System fixes: processes started from test files", () => {
  // src/main.ts forks a child whose root file is a fixture: no program is drawn for it unless tests are on.
  const doc = (): IRDocument => {
    const child = spawn("src/main.ts", "main", 8, "test/fixtures/child/run.ts#run", "process");
    return {
      nodes: [
        file("package.json"), file("src/main.ts"), file("test/fixtures/child/run.ts"),
        moduleFn("src/main.ts", { nodeEntry: true }), fn("src/main.ts", "main"),
        fn("test/fixtures/child/run.ts", "run"),
        child.node,
      ],
      edges: [
        fx.edge("src/main.ts#(module)", "src/main.ts#main", "calls", "calls.call", { span: fx.span("src/main.ts", 1, 2, 1, 12) }),
        child.edge,
      ],
      findings: [],
    };
  };
  const programs = (tests: boolean) => (systemModel(buildProjectModel(doc()), "", { tests }).runtimes ?? []).filter((r) => r.kind === "program");

  it("creates no program frame for a fixture root when tests are off", () => {
    expect(programs(false).map((p) => p.label)).not.toContain("test/fixtures/child/run.ts");
  });

  it("creates the fixture program frame when tests are on", () => {
    expect(programs(true).map((p) => p.label)).toContain("test/fixtures/child/run.ts");
  });
});

describe("System fixes: message to a handler on no thread", () => {
  // src/main.ts posts to src/inbox.ts#handle, which no thread runs (nothing calls or spawns it).
  const doc = (): IRDocument => {
    const w = spawn("src/main.ts", "main", 12, "src/worker.ts#work");
    return {
      nodes: [
        file("package.json"), file("src/main.ts"), file("src/worker.ts"), file("src/inbox.ts"),
        moduleFn("src/main.ts", { nodeEntry: true }), fn("src/main.ts", "main"), fn("src/worker.ts", "work"), fn("src/inbox.ts", "handle"),
        w.node,
      ],
      edges: [
        fx.edge("src/main.ts#(module)", "src/main.ts#main", "calls", "calls.call", { span: fx.span("src/main.ts", 1, 2, 1, 12) }),
        w.edge,
        dispatch("src/main.ts#main", "src/inbox.ts#handle", "src/main.ts", 14, "message"),
      ],
      findings: [],
    };
  };

  it("drops the message into the peer inbox with an enqueues edge", () => {
    const s = systemModel(buildProjectModel(doc()), "");
    expect(s.runtime).toBe("grounded");
    const inbox = (s.resources ?? []).find((r) => r.label === "inbox (unknown peer)");
    expect(inbox).toBeDefined();
    const enq = s.edges.filter((e) => e.verb === "enqueues" && e.to === inbox?.id);
    expect(enq).toHaveLength(1);
    expect(enq[0]?.from).toMatch(/\|/);
    expect(enq[0]?.count).toBe(1);
  });
});

describe("System fixes: flat mode keeps syscall evidence", () => {
  // No spawn and no entry: the flat model. A file read with a syscall and a kernel op both keep their evidence.
  const doc = (): IRDocument => ({
    nodes: [
      file("package.json"), file("src/io.ts"), file("src/sig.ts"),
      fn("src/io.ts", "readIt"), fn("src/sig.ts", "stop"),
      effect("src/io.ts", "readIt", 4, "effects.fs.read", { api: "fs.readFileSync", path: "config.json", syscall: "openat" }),
      effect("src/sig.ts", "stop", 5, "effects.os.call", { api: "process.kill", op: "signal", syscall: "kill", target: "SIGTERM" }),
    ],
    edges: [],
    findings: [],
  });

  it("keeps the syscall on the flat file read and on the kernel op", () => {
    const s = systemModel(buildProjectModel(doc()), "");
    expect(s.runtime).toBe("none");
    const fsEdge = s.edges.find((e) => e.verb === "reads");
    expect(fsEdge?.evidence?.map((e) => e.syscall)).toContain("openat");
    const osEdge = s.edges.find((e) => e.verb === "signals");
    expect(osEdge?.evidence?.map((e) => e.syscall)).toContain("kill");
  });
});

describe("System fixes: programs with nothing in scope", () => {
  // tools/cli.ts is a Node entry that imports src/lib.ts; the scope shows both files' programs only where they hold code.
  const doc = (): IRDocument => ({
    nodes: [
      file("package.json"), file("src/lib.ts"), file("tools/cli.ts"),
      fx.node("tools/cli.ts#(module)", "structure", "structure.function", { attrs: { name: "(module)", module: true, nodeEntry: true }, parent: "tools/cli.ts", span: fx.span("tools/cli.ts", 0, 0, 0, 0) }),
      fx.node("src/lib.ts#(module)", "structure", "structure.function", { attrs: { name: "(module)", module: true }, parent: "src/lib.ts", span: fx.span("src/lib.ts", 0, 0, 0, 0) }),
      fn("src/lib.ts", "util"),
    ],
    edges: [fx.edge("tools/cli.ts", "src/lib.ts", "packaging", "packaging.import", { span: fx.span("tools/cli.ts", 1, 0, 1, 10) })],
    findings: [],
  });

  it("draws a program frame only when it holds a slice, a drawn thread, a resource or an edge", () => {
    for (const scope of ["", "src", "src/lib.ts", "tools"]) {
      const s = systemModel(buildProjectModel(doc()), scope);
      const runtimes = s.runtimes ?? [];
      const slices = s.slices ?? [];
      for (const p of runtimes.filter((r) => r.kind === "program")) {
        const busy =
          slices.some((sl) => runtimes.some((r) => r.id === sl.runtime && r.parent === p.id)) ||
          runtimes.some((r) => r.parent === p.id && r.implicit !== true) ||
          (p.resources?.length ?? 0) > 0 ||
          s.edges.some((e) => e.from === p.id || e.to === p.id);
        expect(busy, `${scope}: ${p.id}`).toBe(true);
      }
    }
  });
});

describe("System fixes: unresolved thread spawns are placeholders", () => {
  // src/main.ts runs main, which calls dispatch; dispatch starts std::thread(fn) with a dynamic fn that resolves to no function.
  const placeholderDoc = (spawnPath: string, owner: string): IRDocument => {
    const spawnNode = fx.node(`${spawnPath}@spawn:12`, "concurrency", "concurrency.spawn-thread", {
      attrs: { api: "std::thread", target: "fn" },
      parent: `${spawnPath}#${owner}`,
      span: fx.span(spawnPath, 12, 2, 12, 30),
    });
    return {
      nodes: [
        file("package.json"), file("src/main.ts"), file(spawnPath), file("src/work.ts"),
        moduleFn("src/main.ts", { nodeEntry: true }), fn("src/main.ts", "main"), fn("src/main.ts", "dispatch"), fn("src/work.ts", "work"),
        fn(spawnPath, owner),
        spawnNode,
      ],
      edges: [
        fx.edge("src/main.ts#(module)", "src/main.ts#main", "calls", "calls.call", { span: fx.span("src/main.ts", 1, 2, 1, 12) }),
        fx.edge("src/main.ts#main", "src/main.ts#dispatch", "calls", "calls.call", { span: fx.span("src/main.ts", 3, 2, 3, 12) }),
        ...(spawnPath === "src/main.ts" ? [] : [fx.edge("src/main.ts#dispatch", `${spawnPath}#${owner}`, "calls", "calls.call", { span: fx.span("src/main.ts", 4, 2, 4, 12) })]),
      ],
      findings: [],
    };
  };
  const placeholdersOf = (doc: IRDocument, tests: boolean) => {
    const s = systemModel(buildProjectModel(doc), "", { tests });
    return { s, threads: (s.runtimes ?? []).filter((r) => r.unresolved === true) };
  };

  it("draws one placeholder thread under the program whose main reaches the spawn site", () => {
    // The spawn sits in dispatch itself, which main reaches.
    const { s, threads } = placeholdersOf(placeholderDoc("src/main.ts", "dispatch"), false);
    expect(threads).toHaveLength(1);
    const ph = threads[0];
    expect(ph?.kind).toBe("thread");
    expect(ph?.label).toBe("Thread · std::thread");
    expect(ph?.note).toBe("target unresolved: fn");
    expect(ph?.parent).toMatch(/^prog:/);
    // No slice of its own, and a spawns edge from the spawning slice into it.
    expect((s.slices ?? []).some((sl) => sl.runtime === ph?.id)).toBe(false);
    const edge = s.edges.find((e) => e.verb === "spawns" && e.to === ph?.id);
    expect(edge).toBeDefined();
    expect(edge?.from).toMatch(/\|src\/main\.ts$/);
  });

  it("draws no placeholder for the same spawn in a test file when tests are off", () => {
    const doc = placeholderDoc("test/spawn.test.ts", "run");
    expect(placeholdersOf(doc, false).threads).toHaveLength(0);
    expect(placeholdersOf(doc, true).threads).toHaveLength(1);
  });

  it("emits one spawns edge from each host thread that reaches the spawn, from existing non-empty slices", () => {
    // main starts a worker thread on src/work.ts#work, which also calls dispatch: two threads reach the unresolved spawn.
    const doc = placeholderDoc("src/main.ts", "dispatch");
    const sp = spawn("src/main.ts", "main", 20, "src/work.ts#work");
    doc.nodes.push(sp.node);
    doc.edges.push(sp.edge, fx.edge("src/work.ts#work", "src/main.ts#dispatch", "calls", "calls.call", { span: fx.span("src/work.ts", 3, 2, 3, 12) }));
    const { s, threads } = placeholdersOf(doc, false);
    expect(threads).toHaveLength(1);
    const edges = s.edges.filter((e) => e.verb === "spawns" && e.to === threads[0]?.id);
    expect(edges).toHaveLength(2);
    expect(new Set(edges.map((e) => e.from)).size).toBe(2);
    const slices = new Map((s.slices ?? []).map((sl) => [sl.id, sl] as const));
    const rts = new Set((s.runtimes ?? []).map((r) => r.id));
    for (const e of s.edges.filter((x) => x.verb === "spawns" && threads.some((t) => t.id === x.to))) {
      const sl = slices.get(e.from);
      expect(sl !== undefined ? sl.functions > 0 : rts.has(e.from)).toBe(true);
    }
  });

  it("falls back to a non-empty slice (never an empty one) when the spawn site's own component has none on the host", () => {
    // The spawn node's span names a file outside every component slice of the host (tools/z.ts), while its owner is src/main.ts#dispatch.
    const doc = placeholderDoc("src/main.ts", "dispatch");
    const node = doc.nodes.find((n) => n.id === "src/main.ts@spawn:12") as IRNode;
    node.span = fx.span("tools/z.ts", 12, 2, 12, 30);
    const { s, threads } = placeholdersOf(doc, false);
    const slices = new Map((s.slices ?? []).map((sl) => [sl.id, sl] as const));
    const rts = new Set((s.runtimes ?? []).map((r) => r.id));
    for (const t of threads) {
      for (const e of s.edges.filter((x) => x.verb === "spawns" && x.to === t.id)) {
        const sl = slices.get(e.from);
        expect(sl !== undefined ? sl.functions > 0 : rts.has(e.from)).toBe(true);
      }
    }
  });
});
