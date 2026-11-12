import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type IRRecord } from "@insight/ir";
import { createCoreRegistry } from "@insight/ir/node";
import { runFrontendConformance, type IRBatch, type ProjectRoot } from "@insight/sdk";
import frontend from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(here, "fixtures", "sample-cpp");
const goldenFile = join(here, "golden", "sample-cpp.ndjson");
const kindsFile = join(here, "..", "data", "kinds.json");
const files = ["src/broken.cc", "src/main.cc", "src/store.cc", "src/store.h", "src/util/log.h"];

const root: ProjectRoot = { path: fixtureRoot, name: "sample-cpp", allowBuildTools: false };
const readFile = async (rel: string) => readFileSync(join(fixtureRoot, rel), "utf8");

function registry() {
  const reg = createCoreRegistry();
  reg.add(JSON.parse(readFileSync(kindsFile, "utf8")) as unknown[], "frontend-cpp");
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

describe("frontend-cpp", () => {
  it("passes the SDK conformance kit", async () => {
    const report = await runFrontendConformance({ frontend, root, files, readFile, registry: registry() });
    const failed = report.checks.filter((c) => !c.ok);
    expect(failed).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("detects a project with C or C++ sources", async () => {
    expect(await frontend.detect(root)).not.toBeNull();
    expect(await frontend.detect({ path: join(here, "..", "data"), name: "x", allowBuildTools: false })).toBeNull();
  });

  it("emits the structure, calls, flow, effects, and sync facts the sample holds", async () => {
    const records = allRecords(await extractAll());
    const nodes = records.flatMap((r) => ("node" in r ? [r.node] : []));
    const edges = records.flatMap((r) => ("edge" in r ? [r.edge] : []));
    const kinds = (k: string) => nodes.filter((n) => n.kind === k);
    expect(kinds("structure.function").map((n) => n.id)).toEqual(
      expect.arrayContaining(["src/store.cc#app::Store::put", "src/store.cc#app::Store::get", "src/store.cc#app::Store::flush", "src/main.cc#main"]),
    );
    expect(kinds("structure.type").map((n) => n.attrs.name)).toEqual(expect.arrayContaining(["Store"]));
    expect(kinds("flow.throw")).toHaveLength(1);
    expect(kinds("flow.loop").map((n) => n.attrs.variant)).toEqual(["for"]);
    expect(kinds("effects.env.read").map((n) => n.attrs.api)).toEqual(["std::getenv"]);
    expect(kinds("effects.clock.read")).toHaveLength(1);
    expect(kinds("concurrency.spawn-thread").map((n) => n.attrs.target)).toEqual(["log_line"]);
    expect(kinds("x-cpp.scoped-lock").map((n) => n.attrs.lock)).toEqual(["app::Store::mu_", "app::Store::mu_"]);
    expect(kinds("sync.lock-release")).toHaveLength(3);
    expect(kinds("sync.lock-acquire").map((n) => n.attrs.lock)).toEqual(["app::Store::mu_"]);
    const includes = edges.filter((e) => e.kind === "packaging.include");
    expect(includes.some((e) => typeof e.to === "object" && "unresolved" in e.to && e.to.unresolved.text === "util/log.h")).toBe(true);
    const calls = edges.filter((e) => e.kind === "calls.call");
    expect(calls.some((e) => e.from === "src/main.cc#main" && e.to === "src/store.cc#app::Store::put")).toBe(true);
  });

  it("gives a file with parse errors inferred facts and a warning", async () => {
    const records = allRecords(await extractAll());
    const warning = records.find((r) => "finding" in r && r.finding.span?.file === "src/broken.cc");
    expect(warning && "finding" in warning ? warning.finding.severity : undefined).toBe("warning");
    // Error recovery can drop declarations after the error, so only the earlier function is checked.
    const first = records.find((r) => "node" in r && r.node.id === "src/broken.cc#first");
    expect(first && "node" in first ? first.node.provenance.confidence : undefined).toBe("inferred");
  });

  it("matches the golden IR for the sample project", async () => {
    const actual = toGolden(await extractAll());
    if (process.env.UPDATE_GOLDEN === "1") writeFileSync(goldenFile, actual);
    expect(actual).toBe(readFileSync(goldenFile, "utf8"));
  });
});
