import { describe, expect, it } from "vitest";
import type { IRNode } from "@insight/ir";
import type { IRBatch, ProjectRoot } from "@insight/sdk";
import frontend from "../src/index.js";

// Atomics are named by their resolved variable, as condvars and semaphores are: Class::member for a member, a qualified
// global, or <dynamic> for a local. Two different members, or two locals, never share a name.

const file = "src/counters.cc";
const root: ProjectRoot = { path: "/nonexistent-atomic-names", name: "atomic-names", allowBuildTools: false };

async function atomicOps(src: string): Promise<IRNode[]> {
  const batches: IRBatch[] = [];
  const ctx = { root, files: [file], listFiles: () => [file], readFile: async () => src, log: () => undefined };
  for await (const batch of frontend.extract(ctx)) batches.push(batch);
  const nodes = batches.flatMap((b) => b.records.flatMap((r) => ("node" in r ? [r.node] : [])));
  return nodes.filter((n) => n.kind === "sync.atomic-op");
}

describe("C++ atomics named by resolved identity", () => {
  it("names two classes' same-spelled members differently", async () => {
    const src = [
      "#include <atomic>",
      "class A {",
      " public:",
      "  std::atomic<int> count_{0};",
      "  void bump() { count_.fetch_add(1); }",
      "};",
      "class B {",
      " public:",
      "  std::atomic<int> count_{0};",
      "  void bump() { count_.fetch_add(1); }",
      "};",
      "",
    ].join("\n");
    const locks = (await atomicOps(src)).map((n) => n.attrs.lock);
    expect(locks).toContain("A::count_");
    expect(locks).toContain("B::count_");
    expect(new Set(locks).size).toBe(2);
  });

  it("names two functions' locals <dynamic>, so they never pair", async () => {
    const src = [
      "#include <atomic>",
      "void first() { std::atomic<int> n{0}; n.fetch_add(1); }",
      "void second() { std::atomic<int> n{0}; n.fetch_add(1); }",
      "",
    ].join("\n");
    const locks = (await atomicOps(src)).map((n) => n.attrs.lock);
    expect(locks).toHaveLength(2);
    expect(locks).toEqual(["<dynamic>", "<dynamic>"]);
  });

  it("names the same member the same way wherever it is used", async () => {
    const src = [
      "#include <atomic>",
      "class Pipeline {",
      " public:",
      "  std::atomic<int> hits_{0};",
      "  void a() { hits_.fetch_add(1); }",
      "  void b() { hits_++; }",
      "};",
      "",
    ].join("\n");
    const locks = (await atomicOps(src)).map((n) => n.attrs.lock);
    expect(locks.length).toBeGreaterThanOrEqual(2);
    expect(new Set(locks)).toEqual(new Set(["Pipeline::hits_"]));
  });
});
