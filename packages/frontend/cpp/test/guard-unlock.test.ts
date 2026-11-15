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
