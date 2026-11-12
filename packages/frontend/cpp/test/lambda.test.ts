import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateIR, type IREdge, type IRNode } from "@insight/ir";
import { createCoreRegistry } from "@insight/ir/node";
import type { IRBatch, ProjectRoot } from "@insight/sdk";
import frontend from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(here, "fixtures", "lambda");
const kindsFile = join(here, "..", "data", "kinds.json");
const files = ["src/lambda.cc", "src/task.h"];

const root: ProjectRoot = { path: fixtureRoot, name: "lambda", allowBuildTools: false };
const readFile = async (rel: string) => readFileSync(join(fixtureRoot, rel), "utf8");

type IRRecord = IRBatch["records"][number];

async function extractAll(): Promise<IRRecord[]> {
  const batches: IRBatch[] = [];
  const ctx = { root, files, listFiles: () => [...files], readFile, log: () => undefined };
  for await (const batch of frontend.extract(ctx)) batches.push(batch);
  return batches.flatMap((b) => b.records);
}

const nodesOf = (records: IRRecord[]): IRNode[] => records.flatMap((r) => ("node" in r ? [r.node] : []));
const edgesOf = (records: IRRecord[]): IREdge[] => records.flatMap((r) => ("edge" in r ? [r.edge] : []));
const byText = (a: unknown, b: unknown) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1);
/** The node ids an edge points at, one or several. */
const targetIds = (e: IREdge): string[] => (typeof e.to === "string" ? [e.to] : "candidates" in e.to ? [...e.to.candidates] : []);

/** An edge as the test compares it: where it starts, where it goes, what kind it is and how sure the frontend is. */
interface Flow {
  kind: string;
  from: string;
  to: string;
  how: unknown;
  confidence: string;
}

const flowOf = (e: IREdge): Flow => ({
  kind: e.kind,
  from: e.from,
  to: typeof e.to === "string" ? e.to : JSON.stringify(e.to),
  how: e.attrs?.how,
  confidence: e.provenance.confidence,
});

const F = "src/lambda.cc";

describe("frontend-cpp lambdas", () => {
  it("makes each lambda a function node, named by its binding or its position, under its creator", async () => {
    const lambdas = nodesOf(await extractAll())
      .filter((n) => n.kind === "structure.function" && n.attrs?.anonymous === true)
      .map((n) => [n.id, n.parent, n.attrs?.name, n.attrs?.qualifiedName]);
    expect(lambdas.sort(byText)).toEqual(
      [
        [`${F}#boot`, F, "boot", "boot"],
        [`${F}#app::start.λ24:26`, `${F}#app::start`, "λ24:26", "app::start.λ24:26"],
        [`${F}#app::start.task`, `${F}#app::start`, "task", "app::start.task"],
        [`${F}#app::start.λ27:45`, `${F}#app::start`, "λ27:45", "app::start.λ27:45"],
        [`${F}#app::start.λ29:29`, `${F}#app::start`, "λ29:29", "app::start.λ29:29"],
        [`${F}#app::start.λ32:34`, `${F}#app::start`, "λ32:34", "app::start.λ32:34"],
        [`${F}#app::start.outer`, `${F}#app::start`, "outer", "app::start.outer"],
        [`${F}#app::start.outer.inner`, `${F}#app::start.outer`, "inner", "app::start.outer.inner"],
        [`${F}#app::start.wait`, `${F}#app::start`, "wait", "app::start.wait"],
        [`${F}#app::other.task`, `${F}#app::other`, "task", "app::other.task"],
        [`${F}#app::scoped.gone`, `${F}#app::scoped`, "gone", "app::scoped.gone"],
        [`${F}#app::assigns.later`, `${F}#app::assigns`, "later", "app::assigns.later"],
        [`${F}#Gate::open.locked`, `${F}#Gate::open`, "locked", "Gate::open.locked"],
      ].sort(byText),
    );
  });

  it("gives every lambda attrs of exactly name, qualifiedName and anonymous", async () => {
    const lambdas = nodesOf(await extractAll()).filter((n) => n.kind === "structure.function" && n.attrs?.anonymous === true);
    expect(lambdas).toHaveLength(13);
    for (const n of lambdas) expect(Object.keys(n.attrs ?? {}).sort()).toEqual(["anonymous", "name", "qualifiedName"]);
  });

  it("links the enclosing function, or the file at module scope, to each lambda with one closure reference", async () => {
    const refs = edgesOf(await extractAll())
      .filter((e) => e.kind === "calls.reference")
      .map((e) => [e.from, e.to, e.attrs?.how, e.span?.start])
      .sort(byText);
    expect(refs).toEqual(
      [
        [F, `${F}#boot`, "closure", [12, 12]],
        [`${F}#app::start`, `${F}#app::start.λ24:26`, "closure", [23, 25]],
        [`${F}#app::start`, `${F}#app::start.task`, "closure", [24, 14]],
        [`${F}#app::start`, `${F}#app::start.λ27:45`, "closure", [26, 44]],
        [`${F}#app::start`, `${F}#app::start.λ29:29`, "closure", [28, 28]],
        [`${F}#app::start`, `${F}#app::start.λ32:34`, "closure", [31, 33]],
        [`${F}#app::start`, `${F}#app::start.outer`, "closure", [32, 15]],
        [`${F}#app::start.outer`, `${F}#app::start.outer.inner`, "closure", [33, 17]],
        [`${F}#app::start`, `${F}#app::start.wait`, "closure", [37, 14]],
        [`${F}#app::other`, `${F}#app::other.task`, "closure", [46, 14]],
        [`${F}#app::scoped`, `${F}#app::scoped.gone`, "closure", [51, 16]],
        [`${F}#app::assigns`, `${F}#app::assigns.later`, "closure", [57, 10]],
        [`${F}#Gate::open`, `${F}#Gate::open.locked`, "closure", [72, 16]],
      ].sort(byText),
    );
  });

  it("resolves inline, bound, async, brace-init and +[] lambda spawn targets, and leaves the rest without an edge", async () => {
    const records = await extractAll();
    const spawns = nodesOf(records)
      .filter((n) => n.kind === "concurrency.spawn-thread" && n.id.startsWith(`${F}@`))
      .map((n) => [n.id, n.parent, n.attrs?.target])
      .sort(byText);
    expect(spawns).toEqual(
      [
        [`${F}@spawn:19:2`, `${F}#app::run`, "fn"],
        [`${F}@spawn:23:2`, `${F}#app::start`, "[] { work(); }"],
        [`${F}@spawn:25:2`, `${F}#app::start`, "task"],
        [`${F}@spawn:26:13`, `${F}#app::start`, "[] { work(); }"],
        [`${F}@spawn:27:2`, `${F}#app::start`, "worker"],
        [`${F}@spawn:28:2`, `${F}#app::start`, "[] { work(); }"],
        [`${F}@spawn:30:2`, `${F}#app::start`, "pthread_body"],
        [`${F}@spawn:31:2`, `${F}#app::start`, "+[](void*) -> void* { return nullptr; }"],
        [`${F}@spawn:34:4`, `${F}#app::start.outer`, "inner"],
        [`${F}@spawn:36:2`, `${F}#app::start`, "outer"],
        [`${F}@spawn:47:2`, `${F}#app::other`, "task"],
        [`${F}@spawn:52:2`, `${F}#app::scoped`, "gone"],
        [`${F}@spawn:58:2`, `${F}#app::assigns`, "later"],
      ].sort(byText),
    );

    const flows = edgesOf(records)
      .filter((e) => e.kind === "concurrency.spawns")
      .map(flowOf)
      .sort(byText);
    expect(flows).toEqual(
      [
        // Inline lambda, bound local, async with inline lambda, brace-init with inline lambda, +[] lambda.
        { kind: "concurrency.spawns", from: `${F}@spawn:23:2`, to: `${F}#app::start.λ24:26`, how: "thread", confidence: "exact" },
        { kind: "concurrency.spawns", from: `${F}@spawn:25:2`, to: `${F}#app::start.task`, how: "thread", confidence: "exact" },
        { kind: "concurrency.spawns", from: `${F}@spawn:26:13`, to: `${F}#app::start.λ27:45`, how: "async", confidence: "exact" },
        { kind: "concurrency.spawns", from: `${F}@spawn:28:2`, to: `${F}#app::start.λ29:29`, how: "thread", confidence: "exact" },
        { kind: "concurrency.spawns", from: `${F}@spawn:31:2`, to: `${F}#app::start.λ32:34`, how: "thread", confidence: "exact" },
        // Nested lambda: the inner one is started from inside the outer one.
        { kind: "concurrency.spawns", from: `${F}@spawn:34:4`, to: `${F}#app::start.outer.inner`, how: "thread", confidence: "exact" },
        { kind: "concurrency.spawns", from: `${F}@spawn:36:2`, to: `${F}#app::start.outer`, how: "thread", confidence: "exact" },
        // Named functions keep their earlier resolution: brace-init free function, pthread_create named function.
        { kind: "concurrency.spawns", from: `${F}@spawn:27:2`, to: `${F}#worker`, how: "thread", confidence: "inferred" },
        { kind: "concurrency.spawns", from: `${F}@spawn:30:2`, to: `${F}#app::pthread_body`, how: "thread", confidence: "inferred" },
        // Bound in another function: the other function's `task`, not start's.
        { kind: "concurrency.spawns", from: `${F}@spawn:47:2`, to: `${F}#app::other.task`, how: "thread", confidence: "exact" },
        // Assigned after its declaration: resolved, but only heuristically.
        { kind: "concurrency.spawns", from: `${F}@spawn:58:2`, to: `${F}#app::assigns.later`, how: "thread", confidence: "heuristic" },
        // No edge: a parameter (fn), and a lambda out of scope (gone).
      ].sort(byText),
    );
  });

  it("attributes calls, spawns and locks inside a lambda to the lambda, not to its creator", async () => {
    const records = await extractAll();
    const calls = edgesOf(records)
      .filter((e) => e.kind === "calls.call")
      .map((e) => [e.from, e.to])
      .sort(byText);
    // `locked()` is a call through a lambda variable: a known gap, so it has no edge here.
    expect(calls).toEqual(
      [
        [`${F}#boot`, `${F}#work`],
        [`${F}#app::start.λ24:26`, `${F}#work`],
        [`${F}#app::start.task`, `${F}#work`],
        [`${F}#app::start.λ27:45`, `${F}#work`],
        [`${F}#app::start.λ29:29`, `${F}#work`],
        [`${F}#app::start.outer.inner`, `${F}#work`],
        [`${F}#app::start.wait`, `${F}#fetch`],
        [`${F}#app::other.task`, `${F}#worker`],
        [`${F}#app::assigns.later`, `${F}#work`],
      ].sort(byText),
    );

    const sync = nodesOf(records)
      .filter((n) => n.facet === "sync")
      .map((n) => [n.id, n.kind, n.parent, n.attrs?.lock])
      .sort(byText);
    expect(sync).toEqual(
      [
        [`${F}@guard:72:25:0`, "x-cpp.scoped-lock", `${F}#Gate::open.locked`, "Gate::mu_"],
        [`${F}@release:72:66:0`, "sync.lock-release", `${F}#Gate::open.locked`, "Gate::mu_"],
      ].sort(byText),
    );
  });

  it("marks the lambda that co_awaits as the coroutine, and leaves the function that creates it unmarked", async () => {
    const records = await extractAll();
    const nodes = nodesOf(records);
    const coroutines = nodes.filter((n) => n.kind === "concurrency.coroutine").map((n) => n.parent);
    expect(coroutines.sort()).toEqual([`${F}#app::start.wait`, `${F}#fetch`]);
    const awaits = nodes.filter((n) => n.kind === "concurrency.await").map((n) => [n.id, n.parent]);
    expect(awaits).toEqual([[`${F}@await:38:12`, `${F}#app::start.wait`]]);
    const dispatches = edgesOf(records)
      .filter((e) => e.kind === "concurrency.dispatches")
      .map(flowOf);
    expect(dispatches).toEqual([
      // `fetch` is an unqualified name, looked up in the project's table: inferred, as elsewhere.
      { kind: "concurrency.dispatches", from: `${F}#app::start.wait`, to: `${F}#fetch`, how: "await", confidence: "inferred" },
    ]);
  });

  it("emits IR that validates, and every execution edge and closure target ends at a node that exists", async () => {
    const registry = createCoreRegistry();
    registry.add(JSON.parse(readFileSync(kindsFile, "utf8")) as unknown[], "frontend-cpp");
    const records = await extractAll();
    const text = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
    // Open validation, as the conformance kit runs it: the frontend emits no file nodes, so the
    // closure edges from module scope start at a file this document does not define.
    const report = validateIR(text, registry, { closed: false });
    expect(report.errors).toEqual([]);

    // Execution edges start and end at nodes that exist. A closure edge from module scope starts at the
    // file, which is not a node, so only its target is checked.
    const nodeIds = new Set(nodesOf(records).map((n) => n.id));
    const edges = edgesOf(records);
    const execDangling = edges.filter((e) => e.kind.startsWith("concurrency.")).flatMap((e) => [e.from, ...targetIds(e)]);
    const closureDangling = edges.filter((e) => e.kind === "calls.reference").flatMap(targetIds);
    expect([...execDangling, ...closureDangling].filter((id) => !nodeIds.has(id))).toEqual([]);
  });
});
