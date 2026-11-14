import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateIR, type IRNode } from "@insight/ir";
import { createCoreRegistry } from "@insight/ir/node";
import type { IRBatch, ProjectRoot } from "@insight/sdk";
import frontend from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(here, "fixtures", "states");
const goldenFile = join(here, "golden", "states.ndjson");
const kindsFile = join(here, "..", "data", "kinds.json");
const files = ["src/conn.cc", "src/conn.h"];

const root: ProjectRoot = { path: fixtureRoot, name: "states", allowBuildTools: false };
const readFile = async (rel: string) => readFileSync(join(fixtureRoot, rel), "utf8");

async function extractAll(): Promise<IRBatch["records"]> {
  const batches: IRBatch[] = [];
  const ctx = { root, files, listFiles: () => [...files], readFile, log: () => undefined };
  for await (const batch of frontend.extract(ctx)) batches.push(batch);
  return batches.flatMap((b) => b.records);
}

describe("frontend-cpp state facts", () => {
  it("emits enum holders, writes, tests and branch arms, all heuristic", async () => {
    const records = await extractAll();
    const nodes = records.flatMap((r) => ("node" in r ? [r.node] : []));
    const kind = (k: string): IRNode[] => nodes.filter((n) => n.kind === k);
    const holders = kind("state.holder");
    expect(holders.map((h) => h.id).sort()).toEqual(["src/conn.cc#net::g_last", "src/conn.h#net::Conn.prev_", "src/conn.h#net::Conn.state_"]);
    const state = holders.find((h) => h.id === "src/conn.h#net::Conn.state_");
    expect(state?.attrs.values).toEqual(["ConnState.Idle", "ConnState.Connecting", "ConnState.Connected", "ConnState.Closed"]);
    expect(state?.attrs.domainKind).toBe("enum");
    const writes = kind("state.write");
    expect(writes.some((w) => w.attrs.op === "init" && w.attrs.value === "ConnState.Idle" && w.attrs.holder === state?.id)).toBe(true);
    expect(writes.some((w) => w.attrs.op === "set" && w.attrs.value === "ConnState.Connected" && JSON.stringify(w.attrs.from) === '["ConnState.Connecting"]')).toBe(true);
    expect(writes.some((w) => w.attrs.dynamic === true && w.attrs.holder === "src/conn.cc#net::g_last")).toBe(true);
    const arms = new Set(kind("flow.branch-arm").map((n) => n.id));
    const tests = kind("state.test");
    expect(tests.some((t) => t.attrs.exitGuard === true && t.attrs.negated === true)).toBe(true);
    expect(tests.filter((t) => t.attrs.arm !== undefined).every((t) => arms.has(t.attrs.arm as string))).toBe(true);
    expect(tests.some((t) => (t.attrs.values as string[]).length === 2)).toBe(true);
    expect([...writes, ...tests, ...holders].every((n) => n.provenance.confidence === "heuristic")).toBe(true);
    expect(kind("flow.branch-arm").map((a) => a.attrs.label)).toEqual(expect.arrayContaining(["then", "else", "default", "case ConnState::Idle"]));
  });

  it("validates against the schema", async () => {
    const reg = createCoreRegistry();
    reg.add(JSON.parse(readFileSync(kindsFile, "utf8")) as unknown[], "frontend-cpp");
    const records = await extractAll();
    const text = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
    const report = validateIR(text, reg, { closed: false });
    expect(report.errors).toEqual([]);
  });

  it("matches the golden IR", async () => {
    const records = await extractAll();
    const actual = records.map((r) => JSON.stringify(r)).sort().join("\n") + "\n";
    if (process.env.UPDATE_GOLDEN === "1") writeFileSync(goldenFile, actual);
    expect(actual).toBe(readFileSync(goldenFile, "utf8"));
  });
});
