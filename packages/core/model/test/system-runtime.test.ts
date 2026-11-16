import { describe, expect, it } from "vitest";
import type { IRDocument, IRNode, IREdge } from "@insight/ir";
import * as fx from "@insight/sdk/testing";
import { buildProjectModel, systemModel, type SystemModel } from "../src/index.js";

// Hand-built IR for the runtime model: a Node program with a worker, a started task and an awaited chain, a timer, file,
// network, env and kernel effects; a single-thread program; and a C++ program with two std::threads sharing a mutex, a
// guarded queue, a condvar and a semaphore.

const file = (path: string): IRNode => fx.node(path, "structure", "structure.file", { attrs: { path }, span: fx.span(path, 0, 0, 0, 0) });

function fn(path: string, name: string, attrs: Record<string, unknown> = {}): IRNode {
  return fx.node(`${path}#${name}`, "structure", "structure.function", { attrs: { name, ...attrs }, parent: path, span: fx.span(path, 2, 0, 9, 1) });
}

/** The module entry of a file: the code the file runs when it loads. */
function moduleFn(path: string, attrs: Record<string, unknown> = {}): IRNode {
  return fx.node(`${path}#(module)`, "structure", "structure.function", { attrs: { name: "(module)", module: true, ...attrs }, parent: path, span: fx.span(path, 0, 0, 0, 0) });
}

/** An effect owned by a function: its span is the line of the call. */
function effect(path: string, owner: string, line: number, kind: string, attrs: Record<string, unknown>): IRNode {
  return fx.node(`${path}@${kind}:${line}`, "effects", kind, { attrs, parent: `${path}#${owner}`, span: fx.span(path, line, 2, line, 20) });
}

/** A node in a function: a spawn, a lock, a channel operation. */
function inFn(path: string, owner: string, line: number, facet: string, kind: string, attrs: Record<string, unknown>): IRNode {
  return fx.node(`${path}@${kind}:${line}`, facet, kind, { attrs, parent: `${path}#${owner}`, span: fx.span(path, line, 2, line, 20) });
}

const call = (from: string, to: string, path: string, line: number): IREdge => fx.edge(from, to, "calls", "calls.call", { span: fx.span(path, line, 2, line, 12) });

function dispatch(from: string, to: string, path: string, line: number, how: string): IREdge {
  return fx.edge(from, to, "concurrency", "concurrency.dispatches", { attrs: { how }, span: fx.span(path, line, 2, line, 12) });
}

function spawn(path: string, owner: string, line: number, api: string, target: string, how: "thread" | "process" = "thread"): { node: IRNode; edge: IREdge } {
  const id = `${path}@spawn:${line}`;
  const kind = how === "thread" ? "concurrency.spawn-thread" : "concurrency.spawn-process";
  return {
    node: fx.node(id, "concurrency", kind, { attrs: { api }, parent: `${path}#${owner}`, span: fx.span(path, line, 2, line, 20) }),
    edge: fx.edge(id, target, "concurrency", "concurrency.spawns", { attrs: { how }, span: fx.span(path, line, 2, line, 20) }),
  };
}

const TS = {
  main: "src/main.ts",
  io: "src/io.ts",
  net: "src/net.ts",
  server: "src/server.ts",
  config: "src/config.ts",
  worker: "src/worker.ts",
  util: "src/util.ts",
  child: "tools/child.ts",
  build: "scripts/build.ts",
};

/** The TypeScript fixture: a server program (main thread, worker, started task, awaited chain, timer) and a one-thread script. */
function tsDoc(order: "forward" | "reverse" = "forward"): IRDocument {
  const { main, io, net, server, config, worker, util, child, build } = TS;
  const nodes: IRNode[] = [
    file("package.json"),
    file(main), file(io), file(net), file(server), file(config), file(worker), file(util), file(child), file(build),
    moduleFn(main, { nodeEntry: true }),
    fn(main, "main"),
    fn(main, "tick"),
    fn(main, "refresh"),
    fn(main, "pull"),
    fn(main, "load"),
    fn(main, "onReply"),
    fn(main, "stop"),
    fn(main, "serve"),
    moduleFn(io),
    fn(io, "readConfig"),
    fn(io, "writeReport"),
    fn(net, "fetchJobs"),
    fn(server, "listen"),
    fn(config, "loadEnv"),
    moduleFn(worker),
    fn(worker, "handle"),
    fn(util, "shared"),
    moduleFn(child, { nodeEntry: true }),
    fn(child, "run"),
    moduleFn(build, { nodeEntry: true }),
    fn(build, "buildAll"),
    effect(main, "stop", 40, "effects.os.call", { api: "process.kill", op: "signal", syscall: "kill", target: "SIGTERM" }),
    effect(main, "stop", 41, "effects.os.call", { api: "process.on", op: "signal", target: "<dynamic>" }),
    effect(io, "readConfig", 4, "effects.fs.read", { api: "fs.readFileSync", path: "config.json" }),
    effect(io, "writeReport", 5, "effects.fs.write", { api: "fs.writeFile", path: "report.json" }),
    effect(net, "fetchJobs", 4, "effects.net.connect", { api: "fetch", host: "api.example.com", path: "/jobs", method: "GET", confidence: "exact" }),
    effect(server, "listen", 3, "effects.net.listen", { port: 8080 }),
    effect(config, "loadEnv", 3, "effects.env.read", { api: "process.env", name: "API_KEY" }),
    effect(main, "main", 14, "effects.proc.exec", { api: "child_process.execFile", command: "git" }),
    effect(worker, "handle", 6, "effects.message.post", { api: "postMessage" }),
    effect(main, "onReply", 9, "effects.message.post", { api: "postMessage" }),
    inFn(main, "main", 12, "concurrency", "concurrency.spawn-process", { api: "child_process.fork" }),
    spawn(main, "main", 10, "Worker", `${worker}#(module)`).node,
    spawn(main, "main", 11, "fork", `${child}#run`, "process").node,
    fx.node(`${main}@spawn:20`, "concurrency", "concurrency.spawn-thread", { attrs: { api: "Worker" }, parent: `${main}#serve`, span: fx.span(main, 20, 2, 20, 20) }),
    fn(worker, "reply"),
  ];
  const edges: IREdge[] = [
    call(`${main}#(module)`, `${main}#main`, main, 30),
    call(`${main}#main`, `${main}#load`, main, 5),
    call(`${main}#main`, `${main}#serve`, main, 6),
    call(`${main}#main`, `${main}#onReply`, main, 7),
    call(`${main}#main`, `${io}#readConfig`, main, 8),
    call(`${main}#main`, `${config}#loadEnv`, main, 9),
    call(`${main}#main`, `${net}#fetchJobs`, main, 10),
    call(`${main}#main`, `${main}#stop`, main, 11),
    call(`${main}#main`, `${util}#shared`, main, 12),
    call(`${main}#load`, `${io}#writeReport`, main, 20),
    call(`${main}#refresh`, `${main}#pull`, main, 22),
    call(`${main}#pull`, `${util}#shared`, main, 23),
    call(`${main}#serve`, `${server}#listen`, main, 24),
    call(`${worker}#(module)`, `${worker}#handle`, worker, 1),
    call(`${worker}#handle`, `${util}#shared`, worker, 5),
    call(`${main}#tick`, `${util}#shared`, main, 26),
    call(`${build}#(module)`, `${build}#buildAll`, build, 1),
    call(`${child}#(module)`, `${child}#run`, child, 1),
    spawn(main, "main", 10, "Worker", `${worker}#(module)`).edge,
    spawn(main, "main", 11, "fork", `${child}#run`, "process").edge,
    dispatch(`${main}#main`, `${main}#tick`, main, 13, "timer"),
    dispatch(`${main}#main`, `${main}#refresh`, main, 14, "start"),
    dispatch(`${main}#main`, `${main}#load`, main, 15, "await"),
    dispatch(`${main}#main`, `${worker}#handle`, main, 16, "message"),
    dispatch(`${worker}#handle`, `${main}#onReply`, worker, 6, "message"),
  ];
  const ordered = order === "forward" ? nodes : [...nodes].reverse();
  const orderedEdges = order === "forward" ? edges : [...edges].reverse();
  return { nodes: ordered, edges: orderedEdges, findings: [] };
}

function tsSystem(scope = "", doc: IRDocument = tsDoc()): SystemModel {
  return systemModel(buildProjectModel(doc), scope);
}

describe("runtime model: TypeScript fixture", () => {
  const sys = (): SystemModel => tsSystem();

  it("is grounded, with the program, its threads, and a single implicit main thread for the one-thread script", () => {
    const s = sys();
    expect(s.runtime).toBe("grounded");
    const labels = (s.runtimes ?? []).map((r) => `${r.kind}:${r.label}`);
    expect(labels).toContain("program:src/main.ts");
    expect(labels).toContain("thread:Main thread");
    expect(labels).toContain("thread:Thread · Worker");
    expect(labels).toContain("program:tools/child.ts");
    expect(labels).not.toContain("thread:Process · fork");
    const script = (s.runtimes ?? []).find((r) => r.label === "scripts/build.ts" && r.kind === "program");
    expect(script).toBeDefined();
    const scriptMain = (s.runtimes ?? []).find((r) => r.kind === "thread" && r.parent === script?.id);
    expect(scriptMain?.implicit).toBe(true);
  });

  it("runs a started task as its own coroutine and counts an awaited one inline on the main thread", () => {
    const s = sys();
    const co = (s.runtimes ?? []).filter((r) => r.kind === "coroutine");
    expect(co.map((r) => r.label)).toEqual(["refresh"]);
    const mainSlice = (s.slices ?? []).find((x) => x.runtime.startsWith("thread:main:entry:node:src/main.ts"));
    expect(mainSlice?.awaits).toBe(1);
  });

  it("gives the worker and the main thread a message each way through their inboxes", () => {
    const s = sys();
    const toWorker = (s.edges ?? []).find((e) => e.verb === "enqueues" && e.to.includes("spawn:10:inbox"));
    const fromWorker = (s.edges ?? []).find((e) => e.verb === "enqueues" && e.to.includes("main:entry:node:src/main.ts:inbox"));
    expect(toWorker).toBeDefined();
    expect(fromWorker).toBeDefined();
    expect((s.edges ?? []).some((e) => e.verb === "dequeues" && e.from.includes("spawn:10:inbox"))).toBe(true);
    expect((s.edges ?? []).some((e) => e.verb === "dequeues" && e.from.includes("main:entry:node:src/main.ts:inbox"))).toBe(true);
  });

  it("puts the timer on the main program's Timers queue", () => {
    const s = sys();
    const timers = (s.resources ?? []).find((r) => r.label === "Timers");
    expect(timers?.program).toBe("prog:entry:node:src/main.ts");
  });

  it("puts a worker-only function on the worker's slice, and a shared one on each thread that runs it", () => {
    const s = sys();
    const workerSlice = (s.slices ?? []).find((x) => x.id === "thread:src/main.ts@spawn:10|src");
    expect(workerSlice?.functions).toBe(3);
    const owners = (s.slices ?? []).filter((x) => x.component === "src" && x.functions > 0).map((x) => x.id);
    expect(owners).toEqual(expect.arrayContaining(["thread:src/main.ts@spawn:10|src", "co:main:entry:node:src/main.ts:src/main.ts#refresh|src"]));
  });

  it("gives process effects their evidence: kill at the syscall level, a dynamic signal as unknown", () => {
    const s = sys();
    const signal = (s.edges ?? []).find((e) => e.verb === "signals");
    expect(signal).toBeDefined();
    const levels = (signal?.evidence ?? []).map((ev) => `${ev.api}:${ev.level}`).sort();
    expect(levels).toEqual(["process.kill:syscall", "process.on:unknown"]);
    const sig = (s.resources ?? []).find((r) => r.kind === "os" && r.label === "Signals");
    expect(sig?.names).toEqual(["SIGTERM"]);
  });

  it("models file, network, env and listen effects as their own edges and resources", () => {
    const s = sys();
    expect((s.edges ?? []).some((e) => e.verb === "reads" && e.to === "fs")).toBe(true);
    expect((s.edges ?? []).some((e) => e.verb === "writes" && e.to === "fs")).toBe(true);
    expect((s.edges ?? []).some((e) => e.verb === "reads" && e.to === "host:api.example.com")).toBe(true);
    expect((s.edges ?? []).some((e) => e.verb === "listens" && e.to === "listen:8080")).toBe(true);
    const env = (s.resources ?? []).find((r) => r.kind === "env");
    expect(env?.names).toEqual(["API_KEY"]);
  });

  it("runs a resolved child process as a program with its spawn, and draws the spawn to that program", () => {
    const s = sys();
    const prog = (s.runtimes ?? []).find((r) => r.kind === "program" && r.label === "tools/child.ts");
    expect(prog).toBeDefined();
    expect(prog?.parent).toBeUndefined();
    expect(prog?.spawn).toMatchObject({ api: "fork", status: "resolved", file: TS.main });
    const spawns = (s.edges ?? []).filter((e) => e.verb === "spawns" && e.to === prog?.id);
    expect(spawns.map((e) => e.from.split("|")[0])).toEqual([(s.runtimes ?? []).find((r) => r.kind === "thread" && r.label === "Main thread" && r.parent?.includes("src/main.ts"))?.id]);
    expect((s.externals ?? []).some((x) => x.id === "proc:fork")).toBe(false);
  });

  it("keeps a child process the IR cannot resolve as an external process box, by its API name", () => {
    const base = tsDoc();
    const missing = spawn(TS.main, "main", 13, "fork", `${TS.child}#missing`, "process");
    const doc: IRDocument = { ...base, nodes: [...base.nodes, missing.node], edges: [...base.edges, missing.edge], findings: [] };
    const s = tsSystem("", doc);
    const box = (s.externals ?? []).find((x) => x.id === "proc:fork");
    expect(box?.category).toBe("process");
    expect((s.edges ?? []).some((e) => e.verb === "spawns" && e.to === "proc:fork")).toBe(true);
    expect((s.runtimes ?? []).some((r) => r.kind === "program" && r.label === "tools/child.ts")).toBe(true);
  });

  it("never gives a thread or a coroutine the program kind, and gives every program no parent", () => {
    const s = sys();
    const rts = s.runtimes ?? [];
    expect(rts.filter((r) => r.kind === "program").every((r) => r.parent === undefined)).toBe(true);
    expect(rts.filter((r) => r.kind === "thread" || r.kind === "coroutine").every((r) => r.kind !== "program")).toBe(true);
  });

  it("counts a fact that runs on two runtimes once in the external's ops, but once per edge", () => {
    const base = tsDoc();
    const shared = effect(TS.util, "shared", 3, "effects.fs.read", { api: "fs.readFileSync", path: "shared.json" });
    const s = tsSystem("", { ...base, nodes: [...base.nodes, shared], findings: [] });
    const fs = (s.externals ?? []).find((x) => x.id === "fs");
    // readConfig and shared are the two facts.
    expect(fs?.ops?.find((o) => o.api === "fs.readFileSync")?.count).toBe(2);
    // Per edge, shared counts once on each runtime that runs it: the main thread, the worker, and the refresh coroutine.
    const edgeCounts = (s.edges ?? []).filter((e) => e.verb === "reads" && e.to === "fs").flatMap((e) => e.evidence ?? []).filter((o) => o.api === "fs.readFileSync");
    expect(edgeCounts.reduce((n, o) => n + o.count, 0)).toBe(4);
  });

  it("draws a call from the caller's slice to the callee's slice on the runtime that runs the caller", () => {
    const base = tsDoc();
    const pkgs: IRNode[] = [file("packages/a/package.json"), file("packages/b/package.json"), file("packages/a/src/main.ts"), file("packages/b/src/lib.ts"), file("packages/b/src/w.ts")];
    const extra: IRNode[] = [
      ...pkgs,
      moduleFn("packages/a/src/main.ts", { nodeEntry: true }),
      fn("packages/a/src/main.ts", "main"),
      fn("packages/b/src/lib.ts", "shared"),
      fn("packages/b/src/w.ts", "work"),
      spawn("packages/a/src/main.ts", "main", 5, "Worker", "packages/b/src/w.ts#work").node,
    ];
    const extraEdges: IREdge[] = [
      call("packages/a/src/main.ts#(module)", "packages/a/src/main.ts#main", "packages/a/src/main.ts", 1),
      call("packages/a/src/main.ts#main", "packages/b/src/lib.ts#shared", "packages/a/src/main.ts", 3),
      call("packages/b/src/w.ts#work", "packages/b/src/lib.ts#shared", "packages/b/src/w.ts", 4),
      spawn("packages/a/src/main.ts", "main", 5, "Worker", "packages/b/src/w.ts#work").edge,
    ];
    const s = tsSystem("packages", { ...base, nodes: [...base.nodes, ...extra], edges: [...base.edges, ...extraEdges], findings: [] });
    expect(s.runtime).toBe("grounded");
    const calls = (s.edges ?? []).filter((e) => e.verb === "calls");
    expect(calls.length).toBeGreaterThan(0);
    // Each call stays on one runtime: the shared function runs on the main thread, and the call from main lands there.
    for (const e of calls) expect(e.from.split("|")[0]).toBe(e.to.split("|")[0]);
  });

  it("keeps the component-level calls in the flat model", () => {
    const doc: IRDocument = {
      nodes: [file("packages/a/package.json"), file("packages/b/package.json"), file("packages/a/a.ts"), file("packages/b/b.ts"), fn("packages/a/a.ts", "run"), fn("packages/b/b.ts", "help")],
      edges: [call("packages/a/a.ts#run", "packages/b/b.ts#help", "packages/a/a.ts", 2)],
      findings: [],
    };
    const s = systemModel(buildProjectModel(doc), "");
    expect(s.runtime).toBe("none");
    expect(s.edges.map((e) => `${e.from}>${e.verb}>${e.to}`)).toEqual(["packages/a>calls>packages/b"]);
  });

  it("lists each runtime's in-scope roots, sorted and capped", () => {
    const s = sys();
    const worker = (s.runtimes ?? []).find((r) => r.id === "thread:src/main.ts@spawn:10");
    expect(worker?.roots).toEqual(expect.arrayContaining(["src/worker.ts#(module)"]));
    for (const r of s.runtimes ?? []) {
      if (r.roots === undefined) continue;
      expect(r.roots).toEqual([...r.roots].sort());
      expect(r.roots.length).toBeLessThanOrEqual(20);
    }
  });

  it("counts each sync.atomic-op fact once in each slice that runs its function", () => {
    expect((sys().slices ?? []).some((x) => x.atomics !== undefined)).toBe(false);
    const doc = tsDoc();
    doc.nodes.push(inFn(TS.worker, "(module)", 3, "sync", "sync.atomic-op", { api: "Atomics.add", op: "op" }));
    const s = tsSystem("", doc);
    const worker = (s.slices ?? []).find((x) => x.id === "thread:src/main.ts@spawn:10|src");
    expect(worker?.atomics).toBe(1);
  });

  it("matches the committed snapshot of the grounded TypeScript runtime", () => {
    const s = sys();
    expect({ runtimes: s.runtimes, slices: s.slices, resources: s.resources, edges: s.edges }).toMatchSnapshot();
  });

  it("gives the same JSON for the same code, whatever the input order, and across two builds", () => {
    const a = JSON.stringify(tsSystem("", tsDoc("forward")));
    expect(JSON.stringify(tsSystem("", tsDoc("reverse")))).toBe(a);
    expect(JSON.stringify(tsSystem())).toBe(JSON.stringify(tsSystem()));
  });
});


// ---- C++ fixture: two std::threads sharing a mutex, a guarded queue, a condvar and a semaphore ----

const CPP = { main: "cpp/main.cpp", work: "cpp/work.cpp", queue: "cpp/queue.cpp" };

function cppDoc(): IRDocument {
  const { main, work, queue } = CPP;
  const nodes: IRNode[] = [
    file(main), file(work), file(queue),
    fn(main, "main"),
    fn(work, "produce"),
    fn(work, "consume"),
    fn(queue, "push"),
    fn(queue, "pop"),
    inFn(main, "main", 5, "concurrency", "concurrency.spawn-thread", { api: "std::thread" }),
    inFn(main, "main", 6, "concurrency", "concurrency.spawn-thread", { api: "std::thread" }),
    inFn(work, "produce", 3, "sync", "sync.lock-acquire", { lock: "m" }),
    inFn(work, "consume", 13, "sync", "sync.lock-acquire", { lock: "m" }),
    inFn(work, "produce", 4, "concurrency", "concurrency.channel-send", { channel: "q" }),
    inFn(work, "consume", 14, "concurrency", "concurrency.channel-recv", { channel: "q" }),
    inFn(work, "consume", 15, "sync", "sync.condvar", { op: "wait", name: "cv" }),
    inFn(work, "produce", 5, "sync", "sync.condvar", { op: "notify", name: "cv" }),
    inFn(work, "consume", 16, "sync", "sync.semaphore", { op: "acquire", name: "slots" }),
  ];
  const edges: IREdge[] = [
    call(`${work}#produce`, `${queue}#push`, work, 8),
    call(`${work}#consume`, `${queue}#pop`, work, 9),
    fx.edge(`${main}@concurrency.spawn-thread:5`, `${work}#produce`, "concurrency", "concurrency.spawns", { attrs: { how: "thread" }, span: fx.span(main, 5, 2, 5, 20) }),
    fx.edge(`${main}@concurrency.spawn-thread:6`, `${work}#consume`, "concurrency", "concurrency.spawns", { attrs: { how: "thread" }, span: fx.span(main, 6, 2, 6, 20) }),
  ];
  // The native program: a cc_binary that links the three files, and its main() starts the threads.
  nodes.push(fx.node("cpp:app", "packaging", "packaging.build-target", { attrs: { name: "app", targetKind: "cc_binary" } }));
  edges.push(
    fx.edge("cpp:app", main, "packaging", "packaging.target-contains"),
    fx.edge("cpp:app", work, "packaging", "packaging.target-contains"),
    fx.edge("cpp:app", queue, "packaging", "packaging.target-contains"),
  );
  return { nodes, edges, findings: [] };
}

describe("runtime model: C++ fixture", () => {
  const sys = (): SystemModel => systemModel(buildProjectModel(cppDoc()), "");

  it("puts each std::thread on its own thread of the one program", () => {
    const s = sys();
    expect(s.runtime).toBe("grounded");
    const labels = (s.runtimes ?? []).filter((r) => r.kind === "thread").map((t) => t.label).sort();
    expect(labels).toEqual(["Main thread", "Thread · std::thread", "Thread · std::thread"]);
  });

  it("makes the native program the parent of both threads, and of every resource's program", () => {
    const s = sys();
    const prog = (s.runtimes ?? []).find((r) => r.kind === "program");
    expect(prog?.programKind).toBe("native");
    expect(prog?.label).toBe("app");
    const threads = (s.runtimes ?? []).filter((r) => r.kind === "thread");
    expect(threads.length).toBe(3);
    expect(threads.every((r) => r.parent === prog?.id)).toBe(true);
    const lock = (s.resources ?? []).find((r) => r.kind === "lock" && r.label === "m");
    expect(lock?.program).toBe(prog?.id);
    for (const r of s.resources ?? []) expect(r.program === undefined || r.program === prog?.id).toBe(true);
    expect((s.resources ?? []).some((r) => r.id.includes("thread:"))).toBe(false);
  });

  it("gives a lock no dequeue, so an unlock and a condvar wait on a lock add no fact", () => {
    const s = sys();
    const lockIds = new Set((s.resources ?? []).filter((r) => r.kind === "lock").map((r) => r.id));
    expect(lockIds.size).toBeGreaterThan(0);
    expect((s.edges ?? []).filter((e) => e.verb === "dequeues" && lockIds.has(e.from))).toEqual([]);
  });

  it("matches the committed snapshot of the grounded C++ runtime", () => {
    const s = sys();
    expect({ runtimes: s.runtimes, slices: s.slices, resources: s.resources, edges: s.edges }).toMatchSnapshot();
  });

  it("gives the one component two slices, one per thread", () => {
    const s = sys();
    const workSlices = (s.slices ?? []).filter((x) => x.component === "cpp/work.cpp" && x.runtime.startsWith("thread:cpp/main.cpp@"));
    expect(workSlices.map((x) => x.runtime).sort()).toEqual(["thread:cpp/main.cpp@concurrency.spawn-thread:5", "thread:cpp/main.cpp@concurrency.spawn-thread:6"]);
  });

  it("models the mutex as a lock both threads take, the queue as a channel between them, and the condvar and semaphore", () => {
    const s = sys();
    const res = (s.resources ?? []).map((r) => `${r.kind}:${r.label}`);
    expect(res).toEqual(expect.arrayContaining(["lock:m", "queue:q", "condvar:cv", "semaphore:slots"]));
    const locks = (s.edges ?? []).filter((e) => e.verb === "locks" && e.to.endsWith(":m"));
    expect(new Set(locks.map((e) => e.from)).size).toBe(2);
    const enq = (s.edges ?? []).find((e) => e.verb === "enqueues" && e.to.includes(":q"));
    const deq = (s.edges ?? []).find((e) => e.verb === "dequeues" && e.from.includes(":q"));
    expect(enq?.from).toBe("thread:cpp/main.cpp@concurrency.spawn-thread:5|cpp/work.cpp");
    expect(deq?.to).toBe("thread:cpp/main.cpp@concurrency.spawn-thread:6|cpp/work.cpp");
    expect((s.edges ?? []).some((e) => e.verb === "waits" && e.to.startsWith("condvar:"))).toBe(true);
    expect((s.edges ?? []).some((e) => e.verb === "waits" && e.to.startsWith("semaphore:"))).toBe(true);
  });
});

// ---- Checks that hold for both fixtures ----

describe("runtime model: C++ threads with no build target", () => {
  it("gives threads no program owns one native program of the scope, so every thread has a frame container", () => {
    const doc = cppDoc();
    // A scope whose executables are all filtered out (test-only targets): no target names the process.
    const bare: IRDocument = { ...doc, nodes: doc.nodes.filter((n) => n.kind !== "packaging.build-target"), edges: doc.edges.filter((e) => e.kind !== "packaging") };
    const s = systemModel(buildProjectModel(bare), "");
    expect(s.runtime).toBe("grounded");
    const progs = (s.runtimes ?? []).filter((r) => r.kind === "program");
    expect(progs.length).toBe(1);
    expect(progs[0]?.programKind).toBe("native");
    const threads = (s.runtimes ?? []).filter((r) => r.kind === "thread");
    expect(threads.length).toBe(3);
    expect(threads.every((t) => t.parent === progs[0]?.id)).toBe(true);
    const lock = (s.resources ?? []).find((r) => r.kind === "lock" && r.label === "m");
    expect(lock?.program).toBe(progs[0]?.id);
  });
});

describe("runtime model: stability and scope", () => {
  it("gives the same JSON for the same code, whatever the input order", () => {
    const a = JSON.stringify(tsSystem("", tsDoc("forward")));
    const b = JSON.stringify(tsSystem("", tsDoc("reverse")));
    expect(b).toBe(a);
  });

  it("gives the same JSON across two builds", () => {
    expect(JSON.stringify(tsSystem())).toBe(JSON.stringify(tsSystem()));
  });

  it("narrows to a scope without changing the runtime mode, and keeps only that scope's slices", () => {
    const s = tsSystem("scripts");
    expect(s.runtime).toBe("grounded");
    expect((s.slices ?? []).length).toBeGreaterThan(0);
    expect((s.slices ?? []).every((x) => x.component.startsWith("scripts/"))).toBe(true);
  });

  it("caps the sites of one edge at SITE_CAP and keeps the full count", () => {
    const base = tsDoc();
    const many: IRNode[] = [];
    for (let i = 0; i < 25; i++) {
      many.push(effect(TS.io, "readConfig", 100 + i, "effects.fs.read", { api: "fs.readFileSync", path: `f${i}.json` }));
    }
    const doc: IRDocument = { ...base, nodes: [...base.nodes, ...many], findings: [] };
    const s = tsSystem("", doc);
    const fsRead = (s.edges ?? []).find((e) => e.verb === "reads" && e.to === "fs" && e.sites.some((x) => x.file === "src/io.ts"));
    expect(fsRead).toBeDefined();
    expect(fsRead?.count).toBe(26);
    expect(fsRead?.sites.length).toBeLessThanOrEqual(20);
  });
});

describe("runtime model: no concurrency", () => {
  it("keeps the flat resources, listens and kernel ops from component ids, with no program", () => {
    const doc: IRDocument = {
      nodes: [
        file("lib/a.ts"),
        fn("lib/a.ts", "helper"),
        effect("lib/a.ts", "helper", 3, "effects.net.listen", { port: 8080 }),
        effect("lib/a.ts", "helper", 4, "effects.os.call", { api: "process.kill", op: "signal", syscall: "kill", target: "SIGTERM" }),
        effect("lib/a.ts", "helper", 5, "effects.env.read", { api: "process.env", name: "HOME" }),
      ],
      edges: [dispatch("lib/a.ts#helper", "lib/a.ts#helper", "lib/a.ts", 6, "timer")],
      findings: [],
    };
    const s = systemModel(buildProjectModel(doc), "");
    expect(s.runtime).toBe("none");
    expect(s.runtimes).toBeUndefined();
    const listen = (s.edges ?? []).find((e) => e.verb === "listens");
    expect(listen?.from).toBe("lib/a.ts");
    expect(listen?.to).toBe("listen:8080");
    const os = (s.resources ?? []).find((r) => r.id === "os:signal");
    expect(os?.program).toBeUndefined();
    expect((s.edges ?? []).some((e) => e.verb === "signals" && e.from === "lib/a.ts")).toBe(true);
    const timers = (s.resources ?? []).find((r) => r.id === "queue:Timers");
    expect(timers?.program).toBeUndefined();
    expect((s.edges ?? []).some((e) => e.verb === "enqueues" && e.from === "lib/a.ts" && e.to === "queue:Timers")).toBe(true);
    expect((s.resources ?? []).some((r) => r.kind === "env" && r.program === undefined)).toBe(true);
  });

  it("falls back to runtime none, with no runtime-only fields", () => {
    const doc: IRDocument = {
      nodes: [file("lib/a.ts"), fn("lib/a.ts", "helper"), effect("lib/a.ts", "helper", 3, "effects.fs.read", { api: "fs.readFileSync" })],
      edges: [],
      findings: [],
    };
    const s = systemModel(buildProjectModel(doc), "");
    expect(s.runtime).toBe("none");
    expect(s.runtimes).toBeUndefined();
    expect(s.slices).toBeUndefined();
    expect(s.resources).toBeUndefined();
  });
});

describe("system model: review fixes", () => {
  const libDoc = (...extra: IRNode[]): IRDocument => ({
    nodes: [file("lib/a.ts"), fn("lib/a.ts", "helper"), ...extra],
    edges: [],
    findings: [],
  });

  it("labels a process-control op with the controls verb, and keeps signals for a signal op", () => {
    const s = systemModel(
      buildProjectModel(
        libDoc(
          effect("lib/a.ts", "helper", 3, "effects.os.call", { api: "fork", op: "process-control", syscall: "fork" }),
          effect("lib/a.ts", "helper", 4, "effects.os.call", { api: "process.kill", op: "signal", syscall: "kill", target: "SIGTERM" }),
        ),
      ),
      "",
    );
    const controls = (s.edges ?? []).filter((e) => e.verb === "controls");
    expect(controls.map((e) => e.to)).toEqual(["os:process-control"]);
    expect((s.edges ?? []).filter((e) => e.verb === "signals").map((e) => e.to)).toEqual(["os:signal"]);
  });

  it("draws an fd open of a literal path to the Filesystem as well as File descriptors, but not a dynamic path", () => {
    const s = systemModel(
      buildProjectModel(
        libDoc(
          effect("lib/a.ts", "helper", 3, "effects.os.call", { api: "fs.openSync", op: "fd", syscall: "open", target: "data.txt" }),
          effect("lib/a.ts", "helper", 4, "effects.os.call", { api: "fs.openSync", op: "fd", syscall: "open", target: "<dynamic>" }),
        ),
      ),
      "",
    );
    const opens = (s.edges ?? []).filter((e) => e.verb === "opens");
    expect(opens.map((e) => [e.from, e.to])).toEqual([["lib/a.ts", "fs"]]);
    // Edges merge per pair and verb, so the two fd calls are one edge to File descriptors.
    expect((s.edges ?? []).filter((e) => e.verb === "calls" && e.to === "os:fd")).toHaveLength(1);
    expect((s.resources ?? []).some((r) => r.id === "os:fd")).toBe(true);
  });

  it("names a nameless Atomics condvar Atomics, and never leaves a resource unnamed", () => {
    const s = systemModel(
      buildProjectModel(
        libDoc(
          inFn("lib/a.ts", "helper", 3, "sync", "sync.condvar", { api: "Atomics.wait", op: "wait" }),
          inFn("lib/a.ts", "helper", 4, "sync", "sync.condvar", { api: "Atomics.notify", op: "notify" }),
        ),
      ),
      "",
    );
    const cv = (s.resources ?? []).filter((r) => r.kind === "condvar");
    expect(cv.map((r) => [r.id, r.label])).toEqual([["condvar:Atomics", "Atomics"]]);
    expect((s.resources ?? []).every((r) => r.label.trim() !== "" && !r.id.endsWith(":"))).toBe(true);
    expect((s.edges ?? []).filter((e) => e.to === "condvar:Atomics").map((e) => e.verb).sort()).toEqual(["notifies", "waits"]);
  });

  it("keys a nameless condvar with no API by its site, so unrelated waits do not merge into one 'condvar'", () => {
    const s = systemModel(
      buildProjectModel(
        libDoc(
          inFn("lib/a.ts", "helper", 3, "sync", "sync.condvar", { op: "wait" }),
          inFn("lib/a.ts", "helper", 4, "sync", "sync.condvar", { op: "notify" }),
        ),
      ),
      "",
    );
    const cv = (s.resources ?? []).filter((r) => r.kind === "condvar");
    expect(cv).toHaveLength(2);
    expect(cv.every((r) => r.label === "<dynamic>")).toBe(true);
    expect(new Set(cv.map((r) => r.id)).size).toBe(2);
  });

  it("keys each <dynamic> semaphore by its site, so unrelated sites do not share one resource", () => {
    const s = systemModel(
      buildProjectModel(
        libDoc(
          inFn("lib/a.ts", "helper", 3, "sync", "sync.semaphore", { name: "<dynamic>", op: "acquire", api: "Semaphore.acquire" }),
          inFn("lib/a.ts", "helper", 4, "sync", "sync.semaphore", { name: "<dynamic>", op: "release", api: "Semaphore.release" }),
        ),
      ),
      "",
    );
    const sems = (s.resources ?? []).filter((r) => r.kind === "semaphore");
    expect(sems).toHaveLength(2);
    expect(sems.every((r) => r.label === "<dynamic> (Semaphore.acquire)" || r.label === "<dynamic> (Semaphore.release)")).toBe(true);
    expect(new Set(sems.map((r) => r.id)).size).toBe(2);
  });
});

describe("system model: spawns and posts of the same component", () => {
  it("draws a grounded spawn to the worker's slice, even when the spawner is in the same component", () => {
    const s = tsSystem();
    const spawns = (s.edges ?? []).filter((e) => e.verb === "spawns" && e.to === "thread:src/main.ts@spawn:10|src");
    expect(spawns.map((e) => e.from)).toEqual(["thread:main:entry:node:src/main.ts|src"]);
  });

  it("draws a flat spawn within one component as an edge to a worker box of the file", () => {
    // A spawn the exec model does not know (its node kind is not a spawn), so the scope has no runtime context.
    const spawnNode = fx.node("packages/a/a.ts@spawn:5", "concurrency", "concurrency.spawn-unknown", { attrs: { api: "Worker" }, parent: "packages/a/a.ts#run", span: fx.span("packages/a/a.ts", 5, 2, 5, 20) });
    const doc: IRDocument = {
      nodes: [file("packages/a/package.json"), file("packages/a/a.ts"), file("packages/a/b.ts"), fn("packages/a/a.ts", "run"), fn("packages/a/b.ts", "work"), spawnNode],
      edges: [fx.edge("packages/a/a.ts@spawn:5", "packages/a/b.ts#work", "concurrency", "concurrency.spawns", { attrs: { how: "thread" }, span: fx.span("packages/a/a.ts", 5, 2, 5, 20) })],
      findings: [],
    };
    const s = systemModel(buildProjectModel(doc), "");
    expect(s.runtime).toBe("none");
    expect(s.edges.map((e) => `${e.from}>${e.verb}>${e.to}`)).toEqual(["packages/a>spawns>worker:packages/a/b.ts"]);
    expect(s.externals.find((x) => x.id === "worker:packages/a/b.ts")).toEqual(expect.objectContaining({ label: "b.ts", category: "worker" }));
  });

  it("sends a worker's post with no dispatch to its spawner's inbox, not to the unknown peer", () => {
    const doc: IRDocument = {
      nodes: [
        file("package.json"), file("src/main.ts"), file("src/worker.ts"),
        moduleFn("src/main.ts", { nodeEntry: true }), fn("src/main.ts", "main"),
        moduleFn("src/worker.ts"), fn("src/worker.ts", "handle"),
        effect("src/worker.ts", "handle", 6, "effects.message.post", { api: "postMessage" }),
        spawn("src/main.ts", "main", 10, "Worker", "src/worker.ts#(module)").node,
      ],
      edges: [
        call("src/main.ts#(module)", "src/main.ts#main", "src/main.ts", 30),
        call("src/worker.ts#(module)", "src/worker.ts#handle", "src/worker.ts", 1),
        spawn("src/main.ts", "main", 10, "Worker", "src/worker.ts#(module)").edge,
      ],
      findings: [],
    };
    const s = systemModel(buildProjectModel(doc), "");
    expect(s.runtime).toBe("grounded");
    const from = "thread:src/main.ts@spawn:10|src/worker.ts";
    expect((s.edges ?? []).filter((e) => e.verb === "enqueues" && e.from === from).map((e) => e.to)).toEqual(["queue:thread:main:entry:node:src/main.ts:inbox"]);
    expect((s.resources ?? []).some((r) => r.label === "inbox (unknown peer)")).toBe(false);
  });

  it("sends a post from the spawning function to the one worker it spawns, and the worker reads its inbox", () => {
    const doc: IRDocument = {
      nodes: [
        file("package.json"), file("src/main.ts"), file("src/worker.ts"),
        moduleFn("src/main.ts", { nodeEntry: true }), fn("src/main.ts", "main"),
        moduleFn("src/worker.ts"), fn("src/worker.ts", "work"),
        effect("src/main.ts", "main", 12, "effects.message.post", { api: "postMessage" }),
        spawn("src/main.ts", "main", 10, "Worker", "src/worker.ts#(module)").node,
      ],
      edges: [
        call("src/main.ts#(module)", "src/main.ts#main", "src/main.ts", 30),
        call("src/worker.ts#(module)", "src/worker.ts#work", "src/worker.ts", 1),
        spawn("src/main.ts", "main", 10, "Worker", "src/worker.ts#(module)").edge,
      ],
      findings: [],
    };
    const s = systemModel(buildProjectModel(doc), "");
    expect(s.runtime).toBe("grounded");
    const inbox = "queue:thread:src/main.ts@spawn:10:inbox";
    expect((s.edges ?? []).some((e) => e.verb === "enqueues" && e.from === "thread:main:entry:node:src/main.ts|src/main.ts" && e.to === inbox)).toBe(true);
    expect((s.edges ?? []).some((e) => e.verb === "dequeues" && e.from === inbox && e.to === "thread:src/main.ts@spawn:10|src/worker.ts")).toBe(true);
  });

  it("does not guess the receiver of a post from a worker that also spawns a worker", () => {
    // main spawns a.ts; a.ts#run spawns b.ts and posts. The post could be to main (its spawner) or to b (its child).
    const a = spawn("src/main.ts", "main", 10, "Worker", "src/a.ts#(module)");
    const b = spawn("src/a.ts", "run", 4, "Worker", "src/b.ts#(module)");
    const doc: IRDocument = {
      nodes: [
        file("package.json"), file("src/main.ts"), file("src/a.ts"), file("src/b.ts"),
        moduleFn("src/main.ts", { nodeEntry: true }), fn("src/main.ts", "main"),
        moduleFn("src/a.ts"), fn("src/a.ts", "run"),
        moduleFn("src/b.ts"), fn("src/b.ts", "work"),
        effect("src/a.ts", "run", 6, "effects.message.post", { api: "postMessage" }),
        a.node, b.node,
      ],
      edges: [
        call("src/main.ts#(module)", "src/main.ts#main", "src/main.ts", 30),
        call("src/a.ts#(module)", "src/a.ts#run", "src/a.ts", 1),
        call("src/b.ts#(module)", "src/b.ts#work", "src/b.ts", 1),
        a.edge, b.edge,
      ],
      findings: [],
    };
    const s = systemModel(buildProjectModel(doc), "");
    expect(s.runtime).toBe("grounded");
    const posts = (s.edges ?? []).filter((e) => e.verb === "enqueues" && e.label === "postMessage");
    expect(posts.length).toBeGreaterThan(0);
    for (const e of posts) expect(e.to).not.toMatch(/:inbox$/);
    expect((s.resources ?? []).some((r) => r.label === "inbox (unknown peer)")).toBe(true);
  });
});
