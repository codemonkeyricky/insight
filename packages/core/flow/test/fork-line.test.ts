import { describe, expect, it } from "vitest";
import type { Item } from "../src/build.js";
import { layoutFunction, relayout, ROW_H, stationOf, type InlineTree } from "../src/index.js";
import type { FlowNode, FunctionFlow } from "../src/index.js";
import { branch, call, ret } from "./line-map-fixture.js";

const make = (id: string, items: Item[]): FunctionFlow => layoutFunction({ id, name: id, async: false, items });
const spawnStep = (label: string, target: string): Item => ({ t: "step", role: "spawn", label, target });
const by = (f: FunctionFlow, label: string): FlowNode => {
  const n = f.nodes.find((x) => x.label === label);
  if (!n) throw new Error(`no node ${label}`);
  return n;
};

const worker = make("w#worker", [call("slice()"), call("post()")]);
const proc = make("p#child", [call("run()"), ret]);
const root = make("r#main", [
  call("before()"),
  spawnStep("spawn thread worker", "w#worker"),
  call("middle()"),
  spawnStep("spawn process child", "p#child"),
  { t: "loop", label: "for x of xs", body: [spawnStep("spawn thread worker", "w#worker"), call("use()")] },
  call("after()"),
]);
const ids = root.nodes.filter((n) => n.role === "spawn").map((n) => n.id);
const open = (...which: number[]): FunctionFlow => {
  const tree: InlineTree = new Map(
    which.map((i) => [ids[i]!, i === 1 ? { flow: proc, runtime: { kind: "process" as const, label: "Process · child" } } : { flow: worker, runtime: { kind: "thread" as const, label: "Worker · worker" } }] as const),
  );
  return relayout(root, tree);
};

describe("a spawn opened as a parallel line", () => {
  const out = open(0, 1);
  const f = out.nodes.find((n) => n.id === ids[0])!;
  const fc = out.nodes.find((n) => n.id === ids[1])!;

  it("makes the spawn row a fork row with a header row on a lane to the right", () => {
    expect(f.shape).toBe("fork");
    expect(f.fork).toEqual({ kind: "thread", to: 1 });
    const head = out.nodes.find((n) => n.id === `${f.id}/n1`)!;
    expect(head.shape).toBe("line");
    expect(head.label).toBe("Worker · worker");
    expect(head.lane).toBe(1);
    expect(head.y).toBe(f.y + ROW_H);
    expect(fc.fork).toEqual({ kind: "process", to: 1 });
  });

  it("puts the child rows on a higher lane than the parent rows beside them", () => {
    const kids = out.nodes.filter((n) => n.id.startsWith(`${f.id}/`));
    expect(kids.map((n) => n.label)).toEqual(["Worker · worker", "slice()", "post()", "end"]);
    for (const k of kids) expect(k.lane).toBe(1);
    const bottom = kids[kids.length - 1]!.y;
    // No parent row shares the rows the line spans: the parent's next row comes after it.
    expect(out.nodes.filter((n) => !n.id.includes("/") && n.y > f.y && n.y <= bottom)).toEqual([]);
    expect(by(out, "middle()").y).toBeGreaterThan(bottom);
  });

  it("lets the parent line run straight down past the fork", () => {
    const e = out.edges.find((x) => x.from === f.id && x.to === by(out, "middle()").id)!;
    expect(e.style).toBe("solid");
    expect(e.points.at(0)).toEqual(stationOf(f));
    expect(e.points.at(-1)).toEqual(stationOf(by(out, "middle()")));
    expect(e.points.every((p) => p[0] === stationOf(f)[0])).toBe(true);
    expect(by(out, "middle()").lane).toBe(0);
  });

  it("reaches the new lane with the fork bar", () => {
    expect(stationOf(f)[0]).toBeLessThan(stationOf(out.nodes.find((n) => n.id === `${f.id}/n1`)!)[0]);
    const link = out.edges.find((x) => x.from === f.id && x.to === `${f.id}/n1`)!;
    expect(link.lane).toBe(f.fork!.to);
    expect(f.labelX!).toBeGreaterThan(stationOf(out.nodes.find((n) => n.id === `${f.id}/n1`)!)[0]);
  });

  it("gives a process a band behind its rows and a thread none", () => {
    const head = (n: FlowNode) => out.nodes.find((x) => x.id === `${n.id}/n1`)!;
    expect(head(f).line).toEqual({ kind: "thread" });
    const band = head(fc).line!.band!;
    const kids = out.nodes.filter((n) => n.id.startsWith(`${fc.id}/`));
    expect(head(fc).line!.kind).toBe("process");
    for (const k of kids) {
      expect(k.x).toBeGreaterThanOrEqual(band.x);
      expect(k.y).toBeGreaterThanOrEqual(band.y);
      expect(k.y + k.h).toBeLessThanOrEqual(band.y + band.h);
    }
    expect(band.x + band.w).toBeLessThanOrEqual(out.width);
  });

  it("keeps the other node ids and restores the chart when closed", () => {
    for (const n of root.nodes) expect(out.nodes.some((m) => m.id === n.id)).toBe(true);
    const closed = relayout(root, new Map());
    expect(closed.nodes.length).toBe(root.nodes.length);
    expect(open(0).nodes.length).toBeLessThan(out.nodes.length);
    expect(closed.height).toBe(root.height);
  });

  it("keeps a loop's return track right of the child lane", () => {
    const inLoop = open(2);
    const fk = inLoop.nodes.find((n) => n.id === ids[2])!;
    const back = inLoop.edges.find((e) => e.kind === "back")!;
    expect(fk.shape).toBe("fork");
    expect(back.track!).toBeGreaterThan(stationOf(inLoop.nodes.find((n) => n.id === `${fk.id}/n1`)!)[0]);
    for (const n of inLoop.nodes.filter((x) => x.id.includes("/"))) expect(n.labelX!).toBeGreaterThan(back.track!);
  });

  it("keeps a spawn inside a branch arm to the right of that arm", () => {
    const b = make("r#b", [branch("c", [spawnStep("spawn thread worker", "w#worker")], [call("e()")])]);
    const id = b.nodes.find((n) => n.role === "spawn")!.id;
    const o = relayout(b, new Map([[id, { flow: worker, runtime: { kind: "thread" as const, label: "Worker · worker" } }]]));
    expect(o.nodes.find((n) => n.id === `${id}/n1`)!.lane).toBe(2);
  });

  it("leaves a spawn that cannot be drawn as a plain step", () => {
    const o = relayout(root, new Map([[ids[0]!, { flow: { ...worker, tooLarge: true }, runtime: { kind: "thread" as const, label: "x" } }]]));
    expect(o.nodes.find((n) => n.id === ids[0])!.shape).toBe("step");
  });
});
