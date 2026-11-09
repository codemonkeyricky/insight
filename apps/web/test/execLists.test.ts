import { describe, expect, it } from "vitest";
import { buildExecScene, EXEC_PROJECT_ROOT, type ExecCoroutine, type ExecFunctionRef, type ExecModel, type ExecModelStats, type ExecThread, type Scene } from "@insight/flow";
import {
  CALL_LIST_MAX,
  CHIP_MAX,
  execCallLists,
  execChildFunctions,
  execChips,
  execDegrees,
  execIndex,
  execPlacementFor,
  execRows,
  execThreadKeyOf,
  execTrail,
  sortExecRows,
  type ExecIndex,
} from "../src/zoom/execMap.js";

const fn = (id: string, file: string, line: number, runtime: ExecFunctionRef["runtime"] = "thread"): ExecFunctionRef => ({
  id,
  name: id,
  file,
  line,
  inScope: true,
  runtime,
});

const stats: ExecModelStats = {
  threads: 0,
  programs: 0,
  locks: 0,
  channels: 0,
  spawns: 0,
  resolved: 0,
  outside: 0,
  unresolved: 0,
  candidates: 0,
  coroutines: 0,
  dispatches: 0,
  functionsInScope: 0,
  functionsThreaded: 0,
  functionsCoroutineOnly: 0,
  functionsUnthreaded: 0,
  functionsListed: 0,
};

/** A thread whose `reached` list is sorted by id, as the model gives it. */
const thread = (id: string, roots: string[], reached: string[], extra: Partial<ExecThread> = {}): ExecThread => ({
  id,
  kind: id === "main" ? "main" : "thread",
  grounded: true,
  roots,
  reach: reached.length,
  reached: [...reached].sort(),
  coroutines: [],
  coroutineOnly: [],
  ...extra,
});

const modelOf = (functions: ExecFunctionRef[], threads: ExecThread[], calls: [number, number][] = [], unthreaded: string[] = []): ExecModel => ({
  scope: "",
  truncated: false,
  functions,
  threads,
  dispatches: [],
  programs: [],
  resources: [],
  calls,
  unthreaded,
  stats: { ...stats, threads: threads.length, functionsListed: functions.length },
});

const spawnOf = (node: string, line: number) => ({
  node,
  owner: "main",
  file: "app.py",
  line,
  how: "thread" as const,
  status: "resolved" as const,
  candidates: false,
});

/*
 * The main fixture. Functions by index:
 *   0 main, 1 load, 2 parse, 3 target, 4 helper, 5 step, 6 stepHelper, 7 orphan, 8 worker, 9 lonely, 10 ghost
 * main calls load and helper; load calls parse; parse calls target; helper calls target and ghost, and ghost is in
 * no thread (the scene does not draw it). step is an awaited coroutine dispatched by main; it calls parse and stepHelper.
 * orphan is reached by main but nothing calls it. worker is a spawned thread that calls load. lonely is no-runtime.
 */
const mainModel = (): ExecModel => {
  const step: ExecCoroutine = { target: "step", how: "await", dispatchedBy: ["main"], callees: ["parse", "stepHelper"] };
  const main = thread("main", ["main"], ["main", "load", "parse", "target", "helper", "step", "stepHelper", "orphan"], {
    coroutines: [step],
    coroutineOnly: ["step", "stepHelper"],
  });
  const w = thread("w", ["worker"], ["worker", "load"], { kind: "thread", spawn: spawnOf("spawn:w", 30) });
  return modelOf(
    [
      fn("main", "app.py", 1),
      fn("load", "app.py", 5),
      fn("parse", "app.py", 9),
      fn("target", "app.py", 13),
      fn("helper", "app.py", 17),
      fn("step", "app.py", 21),
      fn("stepHelper", "app.py", 25),
      fn("orphan", "app.py", 50),
      fn("worker", "work.py", 1),
      fn("lonely", "util.py", 3, "none"),
      fn("ghost", "ghost.py", 2),
    ],
    [main, w],
    [
      [0, 1],
      [0, 4],
      [1, 2],
      [2, 3],
      [4, 3],
      [4, 10],
      [5, 2],
      [5, 6],
      [8, 1],
    ],
    ["lonely"],
  );
};

const mainScene = (): { scene: Scene; index: ExecIndex } => {
  const model = mainModel();
  const scene = buildExecScene(model);
  return { scene, index: execIndex(scene, model) };
};

const names = (ids: readonly { name: string }[]) => ids.map((x) => x.name);

describe("execIndex and the placement a link opens", () => {
  it("lists callees and callers by name, distinct", () => {
    const { index } = mainScene();
    expect(index.callees.get("helper")).toEqual(["ghost", "target"]);
    expect(index.callers.get("load")).toEqual(["main", "worker"]);
    expect(index.callers.get("target")).toEqual(["helper", "parse"]);
  });

  it("prefers the placement in the focused thread over the first one by id", () => {
    const { index } = mainScene();
    // load is placed in thread:main and thread:w; "thread:main>load" sorts first, so only the thread tells them apart.
    expect(index.placements.get("load")?.map((p) => p.nodeId)).toEqual(["thread:main>load", "thread:w>load"]);
    expect(execPlacementFor(index, "load", "thread:w")).toBe("thread:w>load");
    expect(execPlacementFor(index, "load", "thread:main")).toBe("thread:main>load");
    expect(execPlacementFor(index, "load")).toBe("thread:main>load");
  });

  it("prefers the shallowest placement in the thread, not the coroutine's copy", () => {
    const { index } = mainScene();
    // parse is placed directly in thread:main and inside the coroutine step. "co:..." sorts first by id.
    expect(index.placements.get("parse")?.map((p) => p.nodeId)).toEqual(["co:main:step>parse", "thread:main>parse"]);
    expect(execPlacementFor(index, "parse", "thread:main")).toBe("thread:main>parse");
  });

  it("returns no placement for a function the scene does not draw", () => {
    const { index } = mainScene();
    expect(execPlacementFor(index, "ghost", "thread:main")).toBeUndefined();
  });

  it("names the thread (or group) a node runs on, and nothing for a node above every thread", () => {
    const { scene } = mainScene();
    expect(execThreadKeyOf(scene, "co:main:step>stepHelper")).toBe("thread:main");
    expect(execThreadKeyOf(scene, "thread:w")).toBe("thread:w");
    expect(execThreadKeyOf(scene, `${EXEC_PROJECT_ROOT}>lonely`)).toBe(EXEC_PROJECT_ROOT);
    expect(execThreadKeyOf(scene, "missing")).toBeUndefined();
  });
});

describe("calls and called by", () => {
  it("links each caller and callee to the placement in the focused thread, else its first placement", () => {
    const { scene, index } = mainScene();
    expect(scene.nodes.has("thread:main>load")).toBe(true);
    const lists = execCallLists(index, "thread:main>load");
    // parse is drawn in the main thread directly, and in the coroutine step.
    expect(lists.calls.items).toEqual([{ id: "parse", name: "parse", file: "app.py", line: 9, nodeId: "thread:main>parse" }]);
    expect(lists.calls.more).toBe(0);
    // worker has no placement in thread:main, so its first placement opens.
    expect(lists.calledBy.items.map((l) => [l.id, l.nodeId])).toEqual([
      ["main", "thread:main>main"],
      ["worker", "thread:w>worker"],
    ]);
  });

  it("opens the callee in the caller's own thread when the focus is in another thread", () => {
    const { index } = mainScene();
    const lists = execCallLists(index, "thread:w>worker");
    expect(lists.calls.items.map((l) => l.nodeId)).toEqual(["thread:w>load"]);
  });

  it("shows a function with no placement as a link-less item with its file", () => {
    const { index } = mainScene();
    const lists = execCallLists(index, "thread:main>helper");
    expect(lists.calls.items).toEqual([
      { id: "ghost", name: "ghost", file: "ghost.py", line: 2 },
      { id: "target", name: "target", file: "app.py", line: 13, nodeId: "thread:main>target" },
    ]);
  });

  it("is empty for a function nothing calls and one that calls nothing", () => {
    const { index } = mainScene();
    expect(execCallLists(index, "thread:main>target").calls.items).toEqual([]);
    expect(execCallLists(index, "thread:main>orphan").calledBy.items).toEqual([]);
    expect(execCallLists(index, `${EXEC_PROJECT_ROOT}>lonely`)).toEqual({ calls: { items: [], more: 0 }, calledBy: { items: [], more: 0 } });
  });

  it("is empty for a node that is not a function", () => {
    const { index } = mainScene();
    expect(execCallLists(index, "thread:main").calls.items).toEqual([]);
  });

  it("caps each list and counts the rest", () => {
    const hubFns = [fn("hub", "hub.py", 1), ...Array.from({ length: 65 }, (_, i) => fn(`c${String(i).padStart(2, "0")}`, "hub.py", 10 + i))];
    const hubCalls = Array.from({ length: 65 }, (_, i): [number, number] => [0, i + 1]);
    const ids = hubFns.slice(1).map((f) => f.id);
    const model = modelOf(hubFns, [thread("main", ["hub"], ["hub", ...ids])], hubCalls);
    const index = execIndex(buildExecScene(model), model);
    const lists = execCallLists(index, "thread:main>hub");
    expect(CALL_LIST_MAX).toBe(50);
    expect(lists.calls.items).toHaveLength(50);
    expect(lists.calls.more).toBe(15);
    expect(lists.calls.items[0]?.id).toBe("c00");
    expect(execCallLists(index, "thread:main>hub", 10).calls.items).toHaveLength(10);
    expect(execDegrees(index, "hub")).toEqual({ calls: 65, calledBy: 0 });
  });
});

describe("degrees", () => {
  it("counts distinct callees and callers within the model", () => {
    const { index } = mainScene();
    expect(execDegrees(index, "main")).toEqual({ calls: 2, calledBy: 0 });
    expect(execDegrees(index, "target")).toEqual({ calls: 0, calledBy: 2 });
    expect(execDegrees(index, "parse")).toEqual({ calls: 1, calledBy: 2 });
    expect(execDegrees(index, "unknown")).toEqual({ calls: 0, calledBy: 0 });
  });
});

describe("trail", () => {
  it("follows the shortest call path from a root of the focused thread", () => {
    const { index } = mainScene();
    const trail = execTrail(index, "thread:main>target");
    // main > helper > target is two calls; main > load > parse > target is three.
    expect(names(trail ?? [])).toEqual(["main", "helper", "target"]);
    expect(trail?.[0]?.nodeId).toBe("thread:main>main");
    expect(trail?.[2]?.nodeId).toBe("thread:main>target");
  });

  it("is the root alone for a root", () => {
    const { index } = mainScene();
    const trail = execTrail(index, "thread:main>main");
    expect(trail).toEqual([{ id: "main", name: "main", file: "app.py", line: 1, nodeId: "thread:main>main" }]);
  });

  it("goes through the coroutine's await when the focus is inside a coroutine", () => {
    const { index } = mainScene();
    // stepHelper is only reached through step, which main awaits.
    expect(names(execTrail(index, "co:main:step>stepHelper") ?? [])).toEqual(["main", "step", "stepHelper"]);
    expect(execTrail(index, "co:main:step>stepHelper")?.[1]?.nodeId).toBe("co:main:step>step");
  });

  it("uses the focused thread's own placements for the links", () => {
    const { index } = mainScene();
    // worker's trail runs in thread w: worker calls load, and load's link is the w placement.
    const trail = execTrail(index, "thread:w>load");
    expect(trail?.map((l) => l.nodeId)).toEqual(["thread:w>worker", "thread:w>load"]);
  });

  it("is undefined when no path exists, for a function on no thread, and for a non-function", () => {
    const { index } = mainScene();
    expect(execTrail(index, "thread:main>orphan")).toBeUndefined();
    expect(execTrail(index, `${EXEC_PROJECT_ROOT}>lonely`)).toBeUndefined();
    expect(execTrail(index, "thread:main")).toBeUndefined();
  });

  it("breaks ties by id, not by the order the calls came in", () => {
    const fns = [fn("r", "t.py", 1), fn("a", "t.py", 2), fn("b", "t.py", 3), fn("t", "t.py", 4)];
    // r calls b before a in the model's pairs, and both reach t in one call: the shortest paths are r>a>t and r>b>t.
    const model = modelOf(fns, [thread("main", ["r"], ["r", "a", "b", "t"])], [
      [0, 2],
      [0, 1],
      [2, 3],
      [1, 3],
    ]);
    const { index } = { index: execIndex(buildExecScene(model), model) };
    expect(names(execTrail(index, "thread:main>t") ?? [])).toEqual(["r", "a", "t"]);
  });
});

describe("chips and the table", () => {
  it("lists a thread's own functions, root first, and not its coroutines' copies", () => {
    const { scene, index } = mainScene();
    const ids = execChildFunctions(scene, "thread:main").map((id) => scene.nodes.get(id)?.label);
    expect(ids).toEqual(["main", "helper", "load", "orphan", "parse", "target"]);
    expect(execChips(scene, "thread:main").items.map((c) => c.id)).toEqual(["main", "helper", "load", "orphan", "parse", "target"]);
    expect(execRows(index, "thread:main").map((r) => r.name)).toEqual(["main", "helper", "load", "orphan", "parse", "target"]);
  });

  it("lists a coroutine's functions, its target first", () => {
    const { scene, index } = mainScene();
    expect(execChips(scene, "co:main:step").items.map((c) => [c.name, c.nodeId])).toEqual([
      ["step", "co:main:step>step"],
      ["parse", "co:main:step>parse"],
      ["stepHelper", "co:main:step>stepHelper"],
    ]);
    expect(execRows(index, "co:main:step").map((r) => r.runtime)).toEqual(["thread", "thread", "thread"]);
  });

  it("lists the functions of a no-runtime group, with their runtime and file", () => {
    const { scene, index } = mainScene();
    expect(execChips(scene, EXEC_PROJECT_ROOT).items).toEqual([{ nodeId: `${EXEC_PROJECT_ROOT}>lonely`, id: "lonely", name: "lonely" }]);
    expect(execRows(index, EXEC_PROJECT_ROOT)).toEqual([
      {
        nodeId: `${EXEC_PROJECT_ROOT}>lonely`,
        id: "lonely",
        name: "lonely",
        file: "util.py",
        line: 3,
        runtime: "none",
        calls: 0,
        calledBy: 0,
      },
    ]);
  });

  it("gives a row its degrees and, when the flow lists the function, its flow counts", () => {
    const { index } = mainScene();
    const flow = new Map([["main", { steps: 4, decisions: 1, loops: 0 }]]);
    const rows = execRows(index, "thread:main", flow);
    const main = rows.find((r) => r.id === "main");
    expect(main).toMatchObject({ calls: 2, calledBy: 0, steps: 4, decisions: 1, loops: 0 });
    const parse = rows.find((r) => r.id === "parse");
    expect(parse).toMatchObject({ calls: 1, calledBy: 2 });
    expect(parse && "steps" in parse).toBe(false);
    // Without the flow there are no flow counts at all.
    expect(execRows(index, "thread:main").every((r) => !("steps" in r))).toBe(true);
  });

  it("lists a big container's functions directly under the thread, and caps the pills", () => {
    const wideFns = Array.from({ length: 30 }, (_, i) => fn(`f${String(i).padStart(2, "0")}`, i % 2 === 0 ? "a.py" : "b.py", i + 1));
    const wideModel = modelOf(wideFns, [thread("wide", ["f00"], wideFns.map((f) => f.id))]);
    const scene = buildExecScene(wideModel);
    const index = execIndex(scene, wideModel);
    // Thread wide holds all 30 functions directly, with no file node between them and the thread.
    expect(execChildFunctions(scene, "thread:wide")).toHaveLength(30);
    expect(execRows(index, "thread:wide")).toHaveLength(30);
    expect(execRows(index, "thread:wide").some((r) => r.file === "a.py") && execRows(index, "thread:wide").some((r) => r.file === "b.py")).toBe(true);

    const hubFns = [fn("hub", "hub.py", 1), ...Array.from({ length: 65 }, (_, i) => fn(`c${String(i).padStart(2, "0")}`, "hub.py", 10 + i))];
    const hubModel = modelOf(hubFns, [thread("main", ["hub"], hubFns.map((f) => f.id))]);
    const hubScene = buildExecScene(hubModel);
    expect(CHIP_MAX).toBe(60);
    const chips = execChips(hubScene, "thread:main");
    expect(chips.items).toHaveLength(60);
    expect(chips.more).toBe(6);
  });
});

describe("sorting the table", () => {
  const rows = execRows(mainScene().index, "thread:main", new Map([
    ["main", { steps: 4, decisions: 1, loops: 0 }],
    ["load", { steps: 2, decisions: 0, loops: 1 }],
  ]));

  it("sorts by a number, descending, with the missing values last", () => {
    const sorted = sortExecRows(rows, "steps", -1).map((r) => r.id);
    expect(sorted.slice(0, 2)).toEqual(["main", "load"]);
    expect(sorted.slice(2)).toEqual(["helper", "orphan", "parse", "target"]);
    const asc = sortExecRows(rows, "steps", 1).map((r) => r.id);
    expect(asc.slice(0, 2)).toEqual(["load", "main"]);
    expect(asc.slice(2)).toEqual(["helper", "orphan", "parse", "target"]);
  });

  it("sorts by name and by location", () => {
    expect(sortExecRows(rows, "name", 1).map((r) => r.name)).toEqual(["helper", "load", "main", "orphan", "parse", "target"]);
    expect(sortExecRows(rows, "name", -1).map((r) => r.name)).toEqual(["target", "parse", "orphan", "main", "load", "helper"]);
    expect(sortExecRows(rows, "location", 1).map((r) => r.line)).toEqual([1, 5, 9, 13, 17, 50]);
    expect(sortExecRows(rows, "location", -1).map((r) => r.line)).toEqual([50, 17, 13, 9, 5, 1]);
  });

  it("sorts by the degrees, ties by id", () => {
    expect(sortExecRows(rows, "calls", -1).map((r) => r.id)).toEqual(["helper", "main", "load", "parse", "orphan", "target"]);
    expect(sortExecRows(rows, "calledBy", -1).map((r) => r.id)).toEqual(["load", "parse", "target", "helper", "main", "orphan"]);
  });
});
