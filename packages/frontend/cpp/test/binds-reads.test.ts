import { describe, expect, it } from "vitest";
import type { IREdge, IRNode } from "@insight/ir";
import frontend from "../src/index.js";

// Phase 4a: `calls.call.attrs.binds` (auto and assignment) and `flow.branch` / `flow.loop` `attrs.reads` for C++.

const SOURCE = `struct Config { bool debug; };

Config loadConfig() {
  Config c{true};
  return c;
}

void localLog() {}

void run(Config cfg, int n, int count) {
  auto loaded = loadConfig();
  loaded = loadConfig();
  auto& ref = loadConfig();
  const auto& cref = loadConfig();
  auto&& rref = loadConfig();
  if (cfg.debug && n > 0) {
    localLog();
  }
  while (count > n) {
    count--;
  }
}
`;

const FILES: Record<string, string> = { "src/bind.cc": SOURCE };

async function extractAll(): Promise<{ nodes: IRNode[]; edges: IREdge[] }> {
  const nodes: IRNode[] = [];
  const edges: IREdge[] = [];
  const ctx = {
    root: { path: "/virtual/cpp-binds", name: "cpp-binds", allowBuildTools: false },
    files: Object.keys(FILES),
    listFiles: () => Object.keys(FILES),
    readFile: async (rel: string) => FILES[rel] ?? "",
    log: () => undefined,
  };
  for await (const batch of frontend.extract(ctx)) {
    for (const r of batch.records) {
      if ("node" in r) nodes.push(r.node);
      else edges.push(r.edge);
    }
  }
  return { nodes, edges };
}

describe("frontend-cpp binds and reads", () => {
  it("binds an auto call result and a later assignment", async () => {
    const { edges } = await extractAll();
    const calls = edges.filter((e) => e.kind === "calls.call" && e.attrs?.callee === "loadConfig");
    expect(calls).toHaveLength(5);
    expect(calls.map((e) => e.attrs?.binds)).toEqual(["loaded", "loaded", "ref", "cref", "rref"]);
  });

  it("binds through reference, const-reference and rvalue-reference declarators", async () => {
    const { edges } = await extractAll();
    const calls = edges.filter((e) => e.kind === "calls.call" && e.attrs?.callee === "loadConfig");
    const byBinds = new Map(calls.map((e) => [e.attrs?.binds, e]));
    // `auto&`, `const auto&` and `auto&&` all wrap the identifier in a reference_declarator.
    expect(byBinds.get("ref")).toBeDefined();
    expect(byBinds.get("cref")).toBeDefined();
    expect(byBinds.get("rref")).toBeDefined();
  });

  it("reads the locals of an if condition, excluding the member name", async () => {
    const { nodes } = await extractAll();
    const branch = nodes.find((n) => n.kind === "flow.branch" && String(n.attrs.condition).includes("cfg.debug"));
    expect(branch?.attrs.reads).toEqual(["cfg", "n"]);
  });

  it("reads the locals of a while condition", async () => {
    const { nodes } = await extractAll();
    const loop = nodes.find((n) => n.kind === "flow.loop" && n.attrs.variant === "while");
    expect(loop?.attrs.reads).toEqual(["count", "n"]);
  });
});
