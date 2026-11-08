import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createCoreRegistry, validateIR, type IREdge, type IRNode } from "@insight/ir";
import type { IRBatch, ProjectRoot } from "@insight/sdk";
import frontend from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(here, "fixtures", "exec");
const kindsFile = join(here, "..", "data", "kinds.json");
const files = ["src/legacy.cc", "src/main.cc", "src/task.h", "src/work.cc", "src/work.h"];

const root: ProjectRoot = { path: fixtureRoot, name: "exec", allowBuildTools: false };
const readFile = async (rel: string) => readFileSync(join(fixtureRoot, rel), "utf8");

async function extractAll(): Promise<IRBatch[]> {
  const batches: IRBatch[] = [];
  const ctx = { root, files, listFiles: () => [...files], readFile, log: () => undefined };
  for await (const batch of frontend.extract(ctx)) batches.push(batch);
  return batches;
}

/** One concurrency edge as the test compares it: where it starts, where it goes, its kind and how. */
interface Flow {
  from: string;
  to: string | { candidates: string[] };
  kind: string;
  how: unknown;
}

/** The node ids an edge points at, one or several. */
function targetIds(e: IREdge): string[] {
  if (typeof e.to === "string") return [e.to];
  return "candidates" in e.to ? [...e.to.candidates] : [];
}

/** Candidates are sorted, so the comparison does not depend on the order files were read in. */
function toFlow(e: IREdge): Flow {
  const to = typeof e.to === "string" ? e.to : "candidates" in e.to ? { candidates: [...e.to.candidates].sort() } : e.to.unresolved.text;
  return { from: e.from, to, kind: e.kind, how: e.attrs?.how };
}

const byJson = (a: unknown, b: unknown) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1);

describe("frontend-cpp execution edges", () => {
  it("links each thread, task and coroutine start to the function it runs", async () => {
    const batches = await extractAll();
    const edges = batches.flatMap((b) => b.records.flatMap((r) => ("edge" in r ? [r.edge] : [])));
    const actual = edges
      .filter((e) => e.kind === "concurrency.spawns" || e.kind === "concurrency.dispatches")
      .map(toFlow)
      .sort(byJson);
    const expected: Flow[] = [
      { from: "src/main.cc@spawn:10:2", to: "src/work.cc#exec::worker", kind: "concurrency.spawns", how: "thread" },
      { from: "src/main.cc@spawn:11:2", to: "src/work.cc#exec::worker", kind: "concurrency.spawns", how: "thread" },
      { from: "src/main.cc@spawn:12:14", to: "src/work.cc#exec::worker", kind: "concurrency.spawns", how: "thread" },
      { from: "src/main.cc@spawn:13:2", to: "src/work.cc#exec::Foo::run", kind: "concurrency.spawns", how: "thread" },
      { from: "src/main.cc@spawn:14:13", to: "src/work.cc#exec::square", kind: "concurrency.spawns", how: "async" },
      { from: "src/main.cc@spawn:16:2", to: "src/main.cc#exec::pthread_body", kind: "concurrency.spawns", how: "thread" },
      {
        from: "src/main.cc@spawn:19:2",
        to: { candidates: ["src/legacy.cc#legacy::drain", "src/work.cc#exec::drain"] },
        kind: "concurrency.spawns",
        how: "thread",
      },
      { from: "src/work.cc@spawn:18:2", to: "src/work.cc#exec::Foo::run", kind: "concurrency.spawns", how: "thread" },
      { from: "src/main.cc#exec::pipeline", to: "src/work.cc#exec::fetch", kind: "concurrency.dispatches", how: "await" },
      { from: "src/main.cc#exec::kick", to: "src/work.cc#exec::fetch", kind: "concurrency.dispatches", how: "start" },
    ];
    expect(actual).toEqual(expected.sort(byJson));
  });

  it("records every thread start as a spawn node, including the ones with no edge", async () => {
    const nodes = (await extractAll()).flatMap((b) => b.records.flatMap((r) => ("node" in r ? [r.node] : [])));
    const spawns = nodes
      .filter((n: IRNode) => n.kind === "concurrency.spawn-thread" && n.id.startsWith("src/main.cc@"))
      .map((n) => [n.id, n.attrs.target] as const);
    expect(spawns).toEqual([
      ["src/main.cc@spawn:10:2", "worker"],
      ["src/main.cc@spawn:11:2", "worker"],
      ["src/main.cc@spawn:12:14", "worker"],
      ["src/main.cc@spawn:13:2", "&Foo::run"],
      ["src/main.cc@spawn:14:13", "square"],
      ["src/main.cc@spawn:16:2", "pthread_body"],
      ["src/main.cc@spawn:17:2", "[] { worker(3); }"],
      ["src/main.cc@spawn:18:2", "unknown_fn"],
      ["src/main.cc@spawn:19:2", "drain"],
    ]);
  });

  it("marks exactly the functions whose body suspends, across files", async () => {
    const nodes = (await extractAll()).flatMap((b) => b.records.flatMap((r) => ("node" in r ? [r.node] : [])));
    const coroutines = nodes.filter((n) => n.kind === "concurrency.coroutine").map((n) => n.parent);
    expect(coroutines.sort()).toEqual(["src/main.cc#exec::pipeline", "src/work.cc#exec::fetch"]);
  });

  it("emits IR that validates, and every execution edge ends at a node that exists", async () => {
    const registry = createCoreRegistry();
    registry.add(JSON.parse(readFileSync(kindsFile, "utf8")) as unknown[], "frontend-cpp");
    const records = (await extractAll()).flatMap((b) => b.records);
    const text = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
    // Open validation, as the conformance kit runs it: the frontend emits no file nodes, so the
    // packaging edges start at files this document does not define.
    const report = validateIR(text, registry, { closed: false });
    expect(report.errors).toEqual([]);

    const nodeIds = new Set(records.flatMap((r) => ("node" in r ? [r.node.id] : [])));
    const execEdges = records.flatMap((r) => ("edge" in r && r.edge.kind.startsWith("concurrency.") ? [r.edge] : []));
    const dangling = execEdges.flatMap((e) => [e.from, ...targetIds(e)]).filter((id) => !nodeIds.has(id));
    expect(dangling).toEqual([]);
  });
});
