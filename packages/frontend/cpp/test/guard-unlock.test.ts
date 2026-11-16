import { describe, expect, it } from "vitest";
import type { IRBatch, ProjectRoot } from "@insight/sdk";
import type { IRNode } from "@insight/ir";
import frontend from "../src/index.js";

// An explicit unlock on a guard variable gives up the guard's mutex, so the mutex's frame ends there.
const FILE = "src/guard.cc";
const SOURCE = [
  "#include <mutex>",
  "std::mutex m;",
  "void f() {",
  "  std::unique_lock<std::mutex> lk(m);",
  "  step_a();",
  "  lk.unlock();",
  "  step_b();",
  "}",
  "",
].join("\n");

async function extractNodes(): Promise<IRNode[]> {
  const root: ProjectRoot = { path: "/nonexistent-insight-guard-unlock", name: "guard-unlock", allowBuildTools: false };
  const batches: IRBatch[] = [];
  const ctx = { root, files: [FILE], listFiles: () => [FILE], readFile: async () => SOURCE, log: () => undefined };
  for await (const batch of frontend.extract(ctx)) batches.push(batch);
  return batches.flatMap((b) => b.records.flatMap((r) => ("node" in r ? [r.node] : [])));
}

describe("C++ unique_lock guards and explicit unlock", () => {
  it("releases the guard's mutex on lk.unlock(), not the guard variable lk", async () => {
    const nodes = await extractNodes();
    const sync = nodes.filter((n) => n.facet === "sync" && n.span?.file === FILE);
    expect(sync.some((n) => n.attrs.lock === "lk")).toBe(false);
    const guard = sync.find((n) => n.kind === "x-cpp.scoped-lock");
    expect(guard).toBeDefined();
    const mutex = guard?.attrs.lock;
    const unlock = sync.find((n) => n.kind === "sync.lock-release" && n.attrs.api === "unlock");
    expect(unlock?.attrs.lock).toBe(mutex);
    // The explicit unlock is on line 5 (0-based), inside the function, before the closing brace.
    expect(unlock?.span?.start[0]).toBe(5);
  });
});

async function extractFrom(source: string): Promise<IRNode[]> {
  const root: ProjectRoot = { path: "/nonexistent-insight-guard-unlock", name: "guard-unlock", allowBuildTools: false };
  const batches: IRBatch[] = [];
  const ctx = { root, files: [FILE], listFiles: () => [FILE], readFile: async () => source, log: () => undefined };
  for await (const batch of frontend.extract(ctx)) batches.push(batch);
  return batches.flatMap((b) => b.records.flatMap((r) => ("node" in r ? [r.node] : [])));
}

const acquiresOf = (nodes: IRNode[]) =>
  nodes.filter((n) => n.facet === "sync" && n.span?.file === FILE && (n.kind === "sync.lock-acquire" || n.kind === "x-cpp.scoped-lock" || n.kind === "sync.rwlock-acquire"));
const releasesOf = (nodes: IRNode[]) => nodes.filter((n) => n.facet === "sync" && n.span?.file === FILE && n.kind === "sync.lock-release");

describe("C++ deferred and adopted guards", () => {
  it("defer_lock followed by lk.lock() gives exactly one acquire of the mutex, not a second one at construction", async () => {
    const nodes = await extractFrom(
      ["#include <mutex>", "std::mutex a;", "void d() {", "  std::unique_lock<std::mutex> lk(a, std::defer_lock);", "  step_a();", "  lk.lock();", "  step_b();", "}", ""].join("\n"),
    );
    const acquires = acquiresOf(nodes);
    expect(acquires).toHaveLength(1);
    const lock = acquires[0]?.attrs.lock;
    expect(lock).toBeDefined();
    expect(lock).not.toBe("lk");
    expect(releasesOf(nodes).map((n) => n.attrs.lock)).toEqual([lock]);
  });

  it("adopt_lock emits no acquire, but the guard still releases at scope end", async () => {
    const nodes = await extractFrom(
      ["#include <mutex>", "std::mutex a;", "void d() {", "  std::unique_lock<std::mutex> lk(a, std::adopt_lock);", "  step_a();", "}", ""].join("\n"),
    );
    expect(acquiresOf(nodes)).toHaveLength(0);
    expect(releasesOf(nodes)).toHaveLength(1);
  });

  it("an explicit unlock with nothing re-locked after it gives one release, not a second at scope end", async () => {
    const nodes = await extractFrom(SOURCE);
    const mutex = nodes.find((n) => n.kind === "x-cpp.scoped-lock")?.attrs.lock;
    expect(releasesOf(nodes).filter((n) => n.attrs.lock === mutex)).toHaveLength(1);
  });
});
