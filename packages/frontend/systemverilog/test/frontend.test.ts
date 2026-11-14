import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type IRRecord } from "@insight/ir";
import { createCoreRegistry } from "@insight/ir/node";
import { runFrontendConformance, type IRBatch, type ProjectRoot } from "@insight/sdk";
import frontend from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(here, "fixtures", "basic");
const goldenFile = join(here, "golden", "basic.ndjson");
const kindsFile = join(here, "..", "data", "kinds.json");
const files = ["alu.sv", "defs.svh", "pkg.sv", "top.sv"];

const root: ProjectRoot = { path: fixtureRoot, name: "basic", allowBuildTools: false };
const readFile = async (rel: string) => readFileSync(join(fixtureRoot, rel), "utf8");

function registry() {
  const reg = createCoreRegistry();
  reg.add(JSON.parse(readFileSync(kindsFile, "utf8")) as unknown[], "frontend-systemverilog");
  return reg;
}

async function extractAll(): Promise<IRBatch[]> {
  const batches: IRBatch[] = [];
  const ctx = { root, files, listFiles: () => [...files], readFile, log: () => undefined };
  for await (const batch of frontend.extract(ctx)) batches.push(batch);
  return batches;
}

const allRecords = (batches: IRBatch[]): IRRecord[] => batches.flatMap((b) => b.records);

/** One sorted line per record, so the golden file diffs cleanly. */
function toGolden(batches: IRBatch[]): string {
  return allRecords(batches).map((r) => JSON.stringify(r)).sort().join("\n") + "\n";
}

describe("frontend-systemverilog", () => {
  it("passes the SDK conformance kit", async () => {
    const report = await runFrontendConformance({ frontend, root, files, readFile, registry: registry() });
    const failed = report.checks.filter((c) => !c.ok);
    expect(failed).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("detects a project with Verilog or SystemVerilog sources", async () => {
    expect(await frontend.detect(root)).not.toBeNull();
    expect(await frontend.detect({ path: join(here, "..", "data"), name: "x", allowBuildTools: false })).toBeNull();
  });

  it("emits the structure, instances, imports, flow, calls and effects the fixture holds", async () => {
    const records = allRecords(await extractAll());
    const nodes = records.flatMap((r) => ("node" in r ? [r.node] : []));
    const edges = records.flatMap((r) => ("edge" in r ? [r.edge] : []));
    const kinds = (k: string) => nodes.filter((n) => n.kind === k);

    expect(kinds("structure.type").map((n) => n.attrs.name)).toEqual(expect.arrayContaining(["alu", "top"]));
    expect(kinds("structure.module").map((n) => n.attrs.name)).toEqual(["pkg"]);
    expect(kinds("structure.function").map((n) => n.id)).toEqual(
      expect.arrayContaining(["pkg.sv#pkg.saturate_add", "top.sv#top.report", "alu.sv#alu.always_comb#1", "top.sv#top.always_ff#1", "top.sv#top.g_lanes.always_ff#2"]),
    );
    expect(kinds("structure.function").find((n) => n.id === "top.sv#top.always_ff#1")?.attrs.clock).toBe("clk");

    const instances = kinds("x-sv.instance").map((n) => [n.attrs.name, n.attrs.module, n.attrs.generate ?? ""]);
    expect(instances).toEqual(
      expect.arrayContaining([
        ["u_alu", "alu", ""],
        ["u_lane_alu", "alu", "g_lanes"],
      ]),
    );
    const inst = edges.filter((e) => e.kind === "x-sv.instantiates");
    expect(inst.some((e) => e.from === "top.sv#top" && e.to === "alu.sv#alu" && e.attrs?.instance === "u_alu")).toBe(true);

    expect(edges.some((e) => e.kind === "packaging.import" && e.from === "top.sv#top" && e.to === "pkg.sv#pkg")).toBe(true);
    expect(
      edges.some((e) => e.kind === "packaging.include" && e.from === "top.sv" && typeof e.to === "object" && "unresolved" in e.to && e.to.unresolved.text === "defs.svh"),
    ).toBe(true);

    expect(kinds("flow.switch").map((n) => n.attrs.hasDefault)).toEqual([true]);
    expect(kinds("flow.branch").map((n) => n.attrs.condition)).toEqual(expect.arrayContaining(["!rst_n", "alu_zero"]));
    expect(kinds("effects.fs.read").map((n) => [n.attrs.api, n.attrs.path])).toEqual([["$readmemh", "init.hex"]]);
    expect(kinds("effects.fs.write")).toHaveLength(0);

    const calls = edges.filter((e) => e.kind === "calls.call");
    expect(calls.some((e) => e.from === "alu.sv#alu.always_comb#1" && e.to === "pkg.sv#pkg.saturate_add" && e.attrs?.callee === "pkg::saturate_add")).toBe(true);
  });

  it("matches the golden IR for the fixture project", async () => {
    const actual = toGolden(await extractAll());
    if (process.env.UPDATE_GOLDEN === "1") writeFileSync(goldenFile, actual);
    expect(actual).toBe(readFileSync(goldenFile, "utf8"));
  });
});
