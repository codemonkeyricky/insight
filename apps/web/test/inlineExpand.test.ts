import { describe, expect, it } from "vitest";
import { layoutFunction, type FunctionFlow, type Rect } from "@insight/flow";
import { isNested, openExpansion, setInline } from "../src/zoom/expand.js";
import { runtimeLabel, stepRuntime } from "../src/flowTargets.js";

// Same-thread calls no longer nest in their step: they open a box to the right (see callBox.test.ts). What is left of the
// nesting machinery is the parallel line a thread or process call draws (setInline with a runtime), and its own box.

const call = (label: string, target?: string, role: "call" | "spawn" = "call") => ({ t: "step" as const, role, label, ...(target ? { target } : {}) });
const make = (id: string, items: ReturnType<typeof call>[]): FunctionFlow => layoutFunction({ id, name: id, async: false, items });
const view: Rect = { x: 0, y: 0, w: 2000, h: 2000 };
const box: Rect = { x: 100, y: 50, w: 230, h: 44 };
const idOf = (f: FunctionFlow, label: string) => f.nodes.find((n) => n.label === label)?.id as string;

describe("stepRuntime", () => {
  it("plain calls, awaits and handlers run on the caller's thread", () => {
    expect(stepRuntime({ role: "call", label: "verify()" })).toBe("same");
    expect(stepRuntime({ role: "await", label: "await load()" })).toBe("same");
    expect(stepRuntime({ role: "call", label: "on message ▸" })).toBe("same");
  });
  it("a thread spawn and a message to a receiver cross threads", () => {
    expect(stepRuntime({ role: "spawn", label: "spawn thread · print.worker" })).toBe("thread");
    expect(stepRuntime({ role: "call", label: "post ▸ print.worker", title: "message.post to print.worker" })).toBe("thread");
    expect(stepRuntime({ role: "call", label: "message.post(x)" })).toBe("thread");
  });
  it("a process spawn is a process", () => {
    expect(stepRuntime({ role: "spawn", label: "spawn process · ffmpeg" })).toBe("process");
  });
});

describe("runtimeLabel", () => {
  it("names a worker by its file, a thread by its function and a process by its name", () => {
    expect(runtimeLabel("thread", "src/verify/print.worker.ts#(module)", "print.worker")).toBe("Worker · print.worker");
    expect(runtimeLabel("thread", "src/a.ts#run", "run")).toBe("Thread · run");
    expect(runtimeLabel("process", "src/a.ts#child", "child")).toBe("Process · child");
  });
});

describe("a thread step's box", () => {
  const root = make("f#root", [call("mid()", "f#mid"), call("spawn thread · w", undefined, "spawn"), call("tail()")]);
  const open = () => openExpansion([], "f#root", { kind: "box", nodeId: "b", rect: box }, root, view);

  it("a thread step still opens its own box, labelled by its runtime", () => {
    const list = open();
    const worker = make("f#w", [call("run()")]);
    const next = openExpansion(list, "f#w", { kind: "step", fnId: "f#root", stepId: "n3", rect: { x: 0, y: 0, w: 236, h: 34 } }, worker, view, { kind: "thread", label: "Worker · print.worker" });
    expect(next).toHaveLength(2);
    expect(next[1]!.runtime).toEqual({ kind: "thread", label: "Worker · print.worker" });
    expect(next[0]!.chart).toBe(list[0]!.chart);
  });
});

describe("a spawn opened as a parallel line", () => {
  const job = make("f#job", [call("work()")]);
  const root = make("f#r", [call("a()"), call("spawn thread · job", "f#job", "spawn")]);
  const id = idOf(root, "spawn thread · job");
  const list = () => openExpansion([], "f#r", { kind: "box", nodeId: "b", rect: box }, root, view);

  it("opens as a fork row with the line's rows, and folds back", () => {
    const next = setInline(list(), "f#r", id, job, view, { kind: "thread", label: "Thread · job" });
    const e = next.find((x) => x.fnId === "f#r")!;
    expect(isNested(e, id)).toBe(true);
    expect(e.chart.nodes.find((n) => n.id === id)?.shape).toBe("fork");
    expect(e.chart.nodes.length).toBe(root.nodes.length + 3);
    const closed = setInline(next, "f#r", id, undefined, view);
    expect(closed.find((x) => x.fnId === "f#r")!.chart.nodes.length).toBe(root.nodes.length);
  });
});

describe("a box opened from a later row of a parallel line", () => {
  const leaf = make("f#leaf", [call("a()", "f#other")]);
  const a = make("f#a", [call("spawn thread · leaf", "f#leaf", "spawn"), call("x()")]);
  const root = make("f#root", [call("spawn thread · a", "f#a", "spawn")]);
  const outer = idOf(root, "spawn thread · a");
  const open = () => openExpansion([], "f#root", { kind: "box", nodeId: "b", rect: box }, root, view);

  it("moves down with the growing line, and closes when its line folds away", () => {
    const nested = setInline(open(), "f#root", outer, a, view, { kind: "thread", label: "Thread · a" });
    const stepId = `${outer}/${idOf(a, "x()")}`;
    const node = nested[0]!.chart.nodes.find((n) => n.id === stepId)!;
    const side = openExpansion(nested, "f#side", { kind: "step", fnId: "f#root", stepId, rect: { x: node.x, y: node.y, w: node.w, h: node.h } }, make("f#side", [call("s()")]), view);
    expect(side).toHaveLength(2);
    const before = side.find((e) => e.fnId === "f#side")!;
    // The line's first row grows a line of its own, which pushes the row x() (and the box from it) down.
    const grown = setInline(side, "f#root", `${outer}/${idOf(a, "spawn thread · leaf")}`, leaf, view, { kind: "thread", label: "Thread · leaf" });
    const moved = grown.find((e) => e.fnId === "f#side")!;
    expect(moved.y).toBeGreaterThan(before.y);
    const folded = setInline(grown, "f#root", outer, undefined, view);
    expect(folded.map((e) => e.fnId)).toEqual(["f#root"]);
  });
});
