import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { buildExecScene, type ExecFunctionRef, type ExecModel, type ExecModelStats, type ExecResource, type ExecThread } from "@insight/flow";
import { ExecFunctionPanel } from "../src/components/zoom/ExecFunctionPanel";
import { ExpansionShape } from "../src/components/zoom/Expansion";
import { ZoomStore } from "../src/zoom/scene";
import type { Expansion } from "../src/zoom/expand";
import { execIndex, execRunsOn, execSelected, syncSites } from "../src/zoom/execMap";
import { edgeClass, edgeTitle, syncResourceText } from "../src/zoom/source";

// Sync edges on the execution canvas: their classes and tooltips, the function panel's Shared resources section, and the
// runs-on line of an open box. The panels render to static markup, as the other panel tests do.

const fn = (id: string, file: string, line: number): ExecFunctionRef => ({ id, name: id, file, line, inScope: true, runtime: "thread" });

const stats: ExecModelStats = {
  threads: 2,
  programs: 0,
  locks: 1,
  channels: 1,
  spawns: 1,
  resolved: 1,
  outside: 0,
  unresolved: 0,
  candidates: 0,
  coroutines: 0,
  dispatches: 0,
  functionsInScope: 3,
  functionsThreaded: 3,
  functionsCoroutineOnly: 0,
  functionsUnthreaded: 0,
  functionsListed: 3,
};

const thread = (id: string, kind: ExecThread["kind"], roots: string[]): ExecThread => ({
  id,
  kind,
  grounded: true,
  roots,
  reach: roots.length,
  reached: roots,
  coroutines: [],
  coroutineOnly: [],
});

// main locks queue_mu and sends on jobs; the worker (spawned) locks queue_mu and receives from jobs.
const model = (resources: ExecResource[]): ExecModel => ({
  scope: "src",
  truncated: false,
  functions: [fn("main", "src/app.ts", 1), fn("worker", "src/app.ts", 9), fn("helper", "src/lib.ts", 4)],
  threads: [{ ...thread("main", "main", ["main"]), reached: ["helper", "main"] }, thread("spawn:1", "thread", ["worker"])],
  dispatches: [],
  programs: [],
  unthreaded: [],
  resources,
  calls: [],
  stats,
} as unknown as ExecModel);

const resources: ExecResource[] = [
  {
    id: "lock:queue_mu",
    kind: "lock",
    name: "queue_mu",
    threads: ["main", "spawn:1"],
    sites: [
      { fn: "main", op: "acquire", file: "src/app.ts", line: 3 },
      { fn: "worker", op: "acquire", file: "src/app.ts", line: 10 },
    ],
  },
  {
    id: "condvar:cv",
    kind: "condvar",
    name: "cv",
    threads: ["spawn:1"],
    sites: [{ fn: "worker", op: "wait", file: "src/app.ts", line: 11 }],
  },
  {
    id: "channel:jobs",
    kind: "channel",
    name: "jobs",
    threads: ["main", "spawn:1"],
    sites: [
      { fn: "main", op: "send", file: "src/app.ts", line: 5 },
      { fn: "worker", op: "recv", file: "src/app.ts", line: 12 },
    ],
  },
];

describe("sync edges: classes and tooltips", () => {
  const merged = {
    stub: false,
    candidate: false,
    kind: "sync" as const,
    how: "lock",
    count: 2,
    stubCount: 0,
    resources: [
      { name: "queue_mu", kind: "lock" as const },
      { name: "cv", kind: "condvar" as const },
    ],
    directed: false,
  };

  it("classes a merged lock and condvar edge by each kind it carries", () => {
    expect(edgeClass(merged)).toBe("zm-edge sync lock condvar");
    expect(edgeTitle(merged)).toBe("Shares lock queue_mu, condvar cv");
  });

  it("classes and titles a directed channel edge, from sender to receiver", () => {
    const channel = { stub: false, candidate: false, kind: "sync" as const, how: "channel", count: 1, stubCount: 0, resources: [{ name: "jobs", kind: "channel" as const }], directed: true };
    expect(edgeClass(channel)).toBe("zm-edge sync channel");
    expect(edgeTitle(channel)).toBe("Channel jobs: sends → receives");
  });

  it("falls back to the how of an edge with no named resources, as before", () => {
    expect(edgeClass({ stub: false, candidate: false, kind: "sync", how: "lock" })).toBe("zm-edge sync lock");
    expect(edgeTitle({ stub: false, count: 2, stubCount: 0, kind: "sync", how: "lock" })).toBe("2 locks both take");
    expect(edgeTitle({ stub: false, count: 1, stubCount: 0, kind: "sync", how: "channel" })).toBe("Sends on a channel the other receives");
  });

  it("lists the sites of the shared resources under the title", () => {
    const m = model(resources);
    const lines = syncSites(m, merged.resources);
    expect(lines).toEqual(["queue_mu: main src/app.ts:3 acquire", "queue_mu: worker src/app.ts:10 acquire", "cv: worker src/app.ts:11 wait"]);
    expect(edgeTitle({ ...merged, sites: lines })).toBe(["Shares lock queue_mu, condvar cv", ...lines].join("\n"));
  });

  it("names the resources by kind in a fixed order", () => {
    expect(syncResourceText([{ name: "cv", kind: "condvar" }, { name: "m", kind: "lock" }, { name: "m", kind: "lock" }])).toBe("lock m, condvar cv");
  });
});

describe("the function panel and the runs-on line", () => {
  it("renders a Shared resources section with each resource's other functions, ops and threads", () => {
    const m = model(resources);
    const scene = buildExecScene(m);
    const index = execIndex(scene, m);
    const nodeId = [...scene.nodes.values()].find((n) => n.kind === "function" && n.ref === "worker")?.id ?? "";
    const selected = execSelected(scene, new Map(m.functions.map((f) => [f.id, f])), nodeId);
    if (selected === undefined) throw new Error("no selection");
    const html = renderToStaticMarkup(
      <ExecFunctionPanel id="p1" scope="src" roots={false} store={new ZoomStore("p1")} index={index} model={m} nodeId={nodeId} selected={selected} onOpen={() => {}} />,
    );
    expect(html).toContain('aria-label="Shared resources"');
    expect(html).toContain("Lock");
    expect(html).toContain("queue_mu");
    expect(html).toContain("Condvar");
    expect(html).toContain("cv");
    // The other function of the lock is main, which acquires it, on the main thread; it links to its placement.
    expect(html).toContain("main</a> (acquire on Main thread)");
    expect(html).toContain("used only here");
    expect(html.indexOf('aria-label="Shared resources"')).toBeLessThan(html.indexOf('aria-label="Calls"'));
  });

  it("leaves the section out for a function that uses no resource", () => {
    const m = model(resources);
    const scene = buildExecScene(m);
    const index = execIndex(scene, m);
    const nodeId = [...scene.nodes.values()].find((n) => n.kind === "function" && n.ref === "helper")?.id ?? "";
    const selected = execSelected(scene, new Map(m.functions.map((f) => [f.id, f])), nodeId);
    if (selected === undefined) throw new Error("no selection");
    const html = renderToStaticMarkup(
      <ExecFunctionPanel id="p1" scope="src" roots={false} store={new ZoomStore("p1")} index={index} model={m} nodeId={nodeId} selected={selected} onOpen={() => {}} />,
    );
    expect(html).not.toContain("Shared resources");
  });

  it("gives the threads a function runs on, for the open box's tooltip", () => {
    const m = model(resources);
    const scene = buildExecScene(m);
    const index = execIndex(scene, m);
    expect(execRunsOn(index, scene, "worker")).toBe("Thread · worker");
    expect(execRunsOn(index, scene, "helper")).toBe("Main thread");
  });

  it("puts the runs-on line in an open box's tooltip, after the summary", () => {
    const chart = { id: "src/app.ts#worker", name: "worker", async: false, nodes: [], edges: [], width: 0, height: 0 };
    const expansion = { fnId: "src/app.ts#worker", chart, x: 0, y: 0, w: 300, h: 200, index: 0, kind: "box" } as unknown as Expansion;
    const html = renderToStaticMarkup(
      <svg>
        <ExpansionShape id="p1" scope="src" expansion={expansion} k={1} onNodeClick={() => false} onSelect={() => {}} onClose={() => {}} runsOn="Main thread, Worker" />
      </svg>,
    );
    expect(html).toContain("<title>worker\nruns on Main thread, Worker</title>");
  });
});
