import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateIR, type IRNode, type IRRecord } from "@insight/ir";
import { createCoreRegistry } from "@insight/ir/node";
import type { IRBatch, ProjectRoot } from "@insight/sdk";
import frontend from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(here, "fixtures", "sample-cpp");
const kindsFile = join(here, "..", "data", "kinds.json");
const files = [
  "src/broken.cc",
  "src/main.cc",
  "src/os.cc",
  "src/queues.cc",
  "src/queues.h",
  "src/signals.cc",
  "src/store.cc",
  "src/store.h",
  "src/sync.cc",
  "src/util/log.h",
];

const root: ProjectRoot = { path: fixtureRoot, name: "sample-cpp", allowBuildTools: false };
const readFile = async (rel: string) => readFileSync(join(fixtureRoot, rel), "utf8");

async function extractAll(): Promise<IRBatch[]> {
  const batches: IRBatch[] = [];
  const ctx = { root, files, listFiles: () => [...files], readFile, log: () => undefined };
  for await (const batch of frontend.extract(ctx)) batches.push(batch);
  return batches;
}

const allRecords = (batches: IRBatch[]): IRRecord[] => batches.flatMap((b) => b.records);
const nodesOf = (batches: IRBatch[]): IRNode[] => allRecords(batches).flatMap((r) => ("node" in r ? [r.node] : []));

/** The nodes of one kind that sit in one file, as the test reads them. */
const find = (nodes: IRNode[], kind: string, file: string) => nodes.filter((n) => n.kind === kind && n.id.startsWith(`${file}@`));

describe("frontend-cpp system and sync facts", () => {
  it("maps kill to a signal with its syscall and macro target", async () => {
    const nodes = nodesOf(await extractAll());
    const kills = nodes.filter((n) => n.kind === "effects.os.call" && n.attrs.api === "kill");
    expect(kills.map((n) => [n.id, n.attrs])).toEqual([
      ["src/signals.cc@effect:7:29", { api: "kill", op: "signal", syscall: "kill", target: "SIGTERM" }],
      ["src/signals.cc@effect:10:2", { api: "kill", op: "signal", syscall: "kill", target: "<dynamic>" }],
    ]);
  });

  it("emits nothing for a call to a function the project defines (a static kill in os.cc)", async () => {
    const nodes = nodesOf(await extractAll());
    const inOs = nodes.filter((n) => n.id.startsWith("src/os.cc@") && n.attrs.api === "kill");
    expect(inOs).toEqual([]);
  });

  it("emits nothing for a member call named like a system call (f.read())", async () => {
    const nodes = nodesOf(await extractAll());
    // Only the free read(fd, ...) in open_literal is a system call. The member f.read() in member_read is not.
    expect(nodes.filter((n) => n.attrs.api === "read").map((n) => n.id)).toEqual(["src/os.cc@effect:34:2"]);
    expect(nodes.some((n) => n.attrs.api === "f.read")).toBe(false);
  });

  it("emits a spawn-process and an OS call for fork", async () => {
    const nodes = nodesOf(await extractAll());
    expect(nodes.find((n) => n.id === "src/os.cc@procspawn:19:16")).toMatchObject({
      kind: "concurrency.spawn-process",
      attrs: { api: "fork" },
    });
    expect(nodes.find((n) => n.id === "src/os.cc@effect:19:16")).toMatchObject({
      kind: "effects.os.call",
      attrs: { api: "fork", op: "process-control", syscall: "fork" },
    });
  });

  it("gives open a literal target or <dynamic>, and read and write a dynamic path", async () => {
    const nodes = nodesOf(await extractAll());
    const opens = nodes.filter((n) => n.kind === "effects.os.call" && n.attrs.api === "open").map((n) => n.attrs.target);
    expect(opens).toEqual(["/etc/hostname", "<dynamic>"]);
    const reads = nodes.filter((n) => n.kind === "effects.fs.read" && n.attrs.api === "read");
    expect(reads.map((n) => [n.attrs.syscall, n.attrs.path])).toEqual([["read", "<dynamic>"]]);
    expect(nodes.filter((n) => n.kind === "effects.fs.write" && n.attrs.api === "write").map((n) => n.attrs.syscall)).toEqual(["write"]);
  });

  it("gives streams their mode and path, and a stream with no path nothing", async () => {
    const nodes = nodesOf(await extractAll());
    const streams = nodes.filter((n) => String(n.attrs.api ?? "").startsWith("std::") && n.id.startsWith("src/os.cc@stream"));
    expect(streams.map((n) => [n.kind, n.attrs.api, n.attrs.path])).toEqual([
      ["effects.fs.read", "std::ifstream", "/etc/hosts"],
      ["effects.fs.write", "std::ofstream", "/tmp/insight-out.txt"],
      ["effects.fs.read", "std::fstream", "/tmp/insight-rw.txt"],
      ["effects.fs.write", "std::fstream", "/tmp/insight-rw.txt"],
      ["effects.fs.read", "std::ifstream", "<dynamic>"],
    ]);
  });

  it("sets the syscall on the existing POSIX rows", async () => {
    const nodes = nodesOf(await extractAll());
    const sys = (api: string) => nodes.find((n) => n.attrs.api === api && n.id.startsWith("src/os.cc@"))?.attrs.syscall;
    expect(["unlink", "rename", "connect", "bind", "listen", "execve"].map(sys)).toEqual(["unlink", "rename", "connect", "bind", "listen", "execve"]);
  });

  it("emits a guarded std::queue as inferred send and receive with guardedBy", async () => {
    const nodes = nodesOf(await extractAll());
    const guarded = nodes.filter((n) => n.attrs.channel === "app::Pipeline::guarded_");
    expect(guarded.map((n) => [n.kind, n.attrs.api, n.attrs.guardedBy, n.provenance.confidence]).sort()).toEqual([
      ["concurrency.channel-recv", "std::queue::front", "app::Pipeline::mu_", "inferred"],
      ["concurrency.channel-recv", "std::queue::pop", "app::Pipeline::mu_", "inferred"],
      ["concurrency.channel-send", "std::queue::push", "app::Pipeline::mu_", "inferred"],
    ]);
  });

  it("emits nothing for an unguarded std::queue or one whose two sides hold different locks", async () => {
    const nodes = nodesOf(await extractAll());
    const queueFacts = nodes.filter((n) => String(n.attrs.channel ?? "").match(/unguarded_|split_/));
    expect(queueFacts).toEqual([]);
  });

  it("gives a condition variable wait its name and the lock behind its unique_lock", async () => {
    const nodes = nodesOf(await extractAll());
    const waits = find(nodes, "sync.condvar", "src/sync.cc").filter((n) => n.attrs.op === "wait" && n.attrs.api === "std::condition_variable::wait");
    expect(waits.map((n) => [n.attrs.name, n.attrs.lock])).toEqual([["app::Pipeline::cv_", "app::Pipeline::mu_"]]);
  });

  it("gives shared_lock on a shared_mutex a shared rwlock, and unique_lock an exclusive one", async () => {
    const nodes = nodesOf(await extractAll());
    const rw = find(nodes, "sync.rwlock-acquire", "src/queues.cc").map((n) => [n.attrs.lock, n.attrs.mode, n.attrs.api]);
    expect(rw).toEqual([
      ["app::Pipeline::rw_", "shared", "std::shared_lock"],
      ["app::Pipeline::rw_", "exclusive", "std::unique_lock"],
    ]);
  });

  it("gives a lock-free queue its channel, and <dynamic> for a local one", async () => {
    const nodes = nodesOf(await extractAll());
    const channels = nodes.filter((n) => n.kind.startsWith("concurrency.channel-")).map((n) => [n.kind, n.attrs.channel, n.attrs.api]);
    expect(channels).toEqual(expect.arrayContaining([
      ["concurrency.channel-send", "app::g_jobs", "boost::lockfree::queue::push"],
      ["concurrency.channel-send", "<dynamic>", "boost::lockfree::queue::push"],
      ["concurrency.channel-recv", "app::Pipeline::tbb_", "tbb::concurrent_queue::try_pop"],
    ]));
  });

  it("gives semaphores, POSIX condition variables and atomics their ops, with <dynamic> for indexed names", async () => {
    const nodes = nodesOf(await extractAll());
    const sems = find(nodes, "sync.semaphore", "src/sync.cc").map((n) => [n.attrs.op, n.attrs.name]);
    expect(sems).toEqual(expect.arrayContaining([["acquire", "app::Pipeline::slots_"], ["release", "gate"], ["release", "<dynamic>"]]));
    const cond = find(nodes, "sync.condvar", "src/sync.cc").filter((n) => n.attrs.api === "pthread_cond_wait");
    expect(cond.map((n) => [n.attrs.name, n.attrs.lock])).toEqual([["pc_", "pm_"]]);
    const atomics = find(nodes, "sync.atomic-op", "src/sync.cc").map((n) => n.attrs.api);
    expect(atomics).toEqual(expect.arrayContaining(["std::atomic::fetch_add", "std::atomic::operator++", "std::atomic::load"]));
    expect(atomics.some((a) => String(a).includes("unknown"))).toBe(false);
  });

  it("names an atomic by its object as its lock, a plain name or a member path, and leaves an unnamed one without a lock", async () => {
    const nodes = nodesOf(await extractAll());
    const named = find(nodes, "sync.atomic-op", "src/sync.cc").map((n) => n.attrs.lock);
    // hits_.fetch_add, hits_++ and hits_.load name hits_. The method on u is not an atomic here (u has no known type).
    expect(named).toContain("hits_");
    expect(named).not.toContain("u");
  });

  it("emits IR that validates against the registry", async () => {
    const registry = createCoreRegistry();
    registry.add(JSON.parse(readFileSync(kindsFile, "utf8")) as unknown[], "frontend-cpp");
    const records = allRecords(await extractAll());
    const text = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
    const report = validateIR(text, registry, { closed: false });
    expect(report.errors).toEqual([]);
  });
});
