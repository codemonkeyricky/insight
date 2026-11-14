import { describe, expect, it } from "vitest";
import { layoutFunction, type FunctionFlow, type Rect } from "@insight/flow";
import { isNested, openExpansion, ownerOf, setInline } from "../src/zoom/expand.js";
import { runtimeLabel, stepRuntime } from "../src/flowTargets.js";

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

describe("inline expansion state", () => {
  const leaf = make("f#leaf", [call("a()")]);
  const mid = make("f#mid", [call("leaf()", "f#leaf"), call("x()")]);
  const root = make("f#root", [call("mid()", "f#mid"), call("spawn thread · w", undefined, "spawn"), call("tail()")]);
  const open = () => openExpansion([], "f#root", { kind: "box", nodeId: "b", rect: box }, root, view);

  it("nesting a callee grows the same box and adds no other", () => {
    const list = open();
    const next = setInline(list, "f#root", idOf(root, "mid()"), mid, view);
    expect(next).toHaveLength(1);
    expect(next[0]!.h).toBeGreaterThan(list[0]!.h);
    expect(next[0]!.chart.height).toBeGreaterThan(root.height);
    expect(isNested(next[0]!, idOf(root, "mid()"))).toBe(true);
    expect(next[0]!.x).toBe(list[0]!.x);
  });

  it("nests again inside the frame, and folding the outer frame folds both", () => {
    const outer = idOf(root, "mid()");
    const one = setInline(open(), "f#root", outer, mid, view);
    const innerId = `${outer}/${idOf(mid, "leaf()")}`;
    const two = setInline(one, "f#root", innerId, leaf, view);
    expect(two[0]!.chart.nodes.find((n) => n.id === innerId)?.shape).toBe("nest");
    expect(two[0]!.h).toBeGreaterThan(one[0]!.h);
    expect(ownerOf(two[0], `${innerId}/x`)).toBe("f#leaf");
    expect(ownerOf(two[0], innerId)).toBe("f#mid");
    const folded = setInline(two, "f#root", outer, undefined, view);
    expect(folded[0]!.chart.nodes.some((n) => n.shape === "nest")).toBe(false);
    expect(folded[0]!.h).toBe(open()[0]!.h);
  });

  it("folding only the inner frame keeps the outer one", () => {
    const outer = idOf(root, "mid()");
    const innerId = `${outer}/${idOf(mid, "leaf()")}`;
    const two = setInline(setInline(open(), "f#root", outer, mid, view), "f#root", innerId, leaf, view);
    const back = setInline(two, "f#root", innerId, undefined, view);
    expect(isNested(back[0]!, outer)).toBe(true);
    expect(isNested(back[0]!, innerId)).toBe(false);
  });

  it("folding a step that is not nested changes nothing", () => {
    const list = open();
    expect(setInline(list, "f#root", idOf(root, "mid()"), undefined, view)).toBe(list);
  });

  it("a callee already in the chain does not nest, so the list is unchanged", () => {
    const list = open();
    expect(setInline(list, "f#root", idOf(root, "mid()"), root, view)).toBe(list);
  });

  it("a box opened from a later step moves down with the growing chart, and closes when its step folds away", () => {
    const outer = idOf(root, "mid()");
    const nested = setInline(open(), "f#root", outer, mid, view);
    const stepId = `${outer}/${idOf(mid, "x()")}`;
    const node = nested[0]!.chart.nodes.find((n) => n.id === stepId)!;
    const side = openExpansion(nested, "f#side", { kind: "step", fnId: "f#root", stepId, rect: { x: node.x, y: node.y, w: node.w, h: node.h } }, make("f#side", [call("s()")]), view);
    expect(side).toHaveLength(2);
    const grown = setInline(side, "f#root", `${outer}/${idOf(mid, "leaf()")}`, leaf, view);
    const moved = grown.find((e) => e.fnId === "f#side")!;
    expect(moved.anchor.kind === "step" && moved.anchor.rect.y).toBeGreaterThan(node.y);
    const folded = setInline(grown, "f#root", outer, undefined, view);
    expect(folded.map((e) => e.fnId)).toEqual(["f#root"]);
  });

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
