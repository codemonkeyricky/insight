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
    moduleFn(child),
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
    expect(labels).toContain("thread:Process · fork");
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
