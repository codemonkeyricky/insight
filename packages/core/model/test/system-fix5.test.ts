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
