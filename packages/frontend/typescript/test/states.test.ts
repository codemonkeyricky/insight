import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { IRBatch, ProjectRoot } from "@insight/sdk";
import type { IRNode, IREdge } from "@insight/ir";
import frontend from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(here, "fixtures", "sample-ts");
const goldenFile = join(here, "golden", "states.ndjson");
const files = ["states/machines.ts", "states/component.ts", "states/localhook.ts", "states/connection.ts", "states/activation.ts"];
const root: ProjectRoot = { path: fixtureRoot, name: "sample-ts", allowBuildTools: false };
const readFile = async (rel: string) => readFileSync(join(fixtureRoot, rel), "utf8");

async function extractAll(): Promise<IRBatch[]> {
  const batches: IRBatch[] = [];
  const ctx = { root, files, listFiles: () => [...files], readFile, log: () => undefined };
  for await (const batch of frontend.extract(ctx)) batches.push(batch);
  return batches;
}

const stateRecords = (batches: IRBatch[]) =>
  batches.flatMap((b) => b.records).filter((r) => ("node" in r && r.node.facet === "state") || ("edge" in r && r.edge.kind === "calls.call" && r.edge.attrs && "knownState" in r.edge.attrs));

const nodes = (batches: IRBatch[], kind: string): IRNode[] =>
  batches.flatMap((b) => b.records).flatMap((r) => ("node" in r && r.node.kind === kind ? [r.node] : []));
const writesOf = (ns: IRNode[], holder: string) => ns.filter((n) => n.attrs?.holder === holder);

describe("lambda owner labels", () => {
  it("names a write in a lambda by its enclosing function and the property it is assigned to, else λ", async () => {
    const batches: IRBatch[] = [];
    const lf = ["states/lambdas.ts"];
    const ctx = { root, files: lf, listFiles: () => [...lf], readFile, log: () => undefined };
    for await (const batch of frontend.extract(ctx)) batches.push(batch);
    const ws = nodes(batches, "state.write");
    const labelAt = (line: number) => ws.find((n) => n.span?.start[0] === line - 1)?.attrs.ownerLabel;
    expect(labelAt(8)).toBeUndefined(); // a plain method write keeps no label
    expect(labelAt(11)).toBe("connect › onWebSocketClose");
    expect(labelAt(15)).toBe("connect › onclose");
    expect(labelAt(18)).toBe("connect › λ");
  });
});

describe("frontend-typescript state facts", () => {
  it("matches the golden state records", async () => {
    const lines = stateRecords(await extractAll()).map((r) => JSON.stringify(r)).sort();
    const actual = lines.join("\n") + "\n";
    if (process.env.UPDATE_GOLDEN === "1") writeFileSync(goldenFile, actual);
    expect(actual).toBe(readFileSync(goldenFile, "utf8"));
  });

  it("emits the expected holders and none for booleans or a local useState", async () => {
    const b = await extractAll();
    const ids = nodes(b, "state.holder").map((n) => n.id).sort();
    expect(ids).toEqual([
      "states/activation.ts#Activator.state",
      "states/component.ts#Panel/mode",
      "states/connection.ts#Connection._state",
      "states/machines.ts#Job.status",
      "states/machines.ts#Worker.level",
      "states/machines.ts#Worker.phase",
    ]);
  });

  it("connection: second write follows the first, catch and stale rules", async () => {
    const b = await extractAll();
    const ws = writesOf(nodes(b, "state.write"), "states/connection.ts#Connection._state");
    const at = (line: number) => ws.find((n) => n.span?.start[0] === line - 1)!;
    // start(): Connecting from the early exit, then Connected after the await (stale), catch from entry + try writes
    expect(at(22).attrs).toMatchObject({ value: "ConnState.Connecting", op: "set", from: ["ConnState.Disconnected"], guardMatch: "receiver" });
    expect(at(25).attrs).toMatchObject({ value: "ConnState.Connected", from: ["ConnState.Connecting"], stale: true });
    expect(at(28).attrs.from).toEqual(["ConnState.Connecting", "ConnState.Connected"]);
    // constructor write is an init
    expect(at(15).attrs).toMatchObject({ op: "init" });
    // after the cast re-test the write is fresh
    expect(at(65).attrs).toMatchObject({ from: ["ConnState.Connected"] });
    expect(at(65).attrs.stale).toBeUndefined();
    // the dynamic write
    const dyn = writesOf(nodes(b, "state.write"), "states/machines.ts#Worker.phase").find((n) => n.attrs.dynamic);
    expect(dyn?.attrs.value).toBeUndefined();
  });

  it("connection: call edges carry knownState only inside the guard arm", async () => {
    const b = await extractAll();
    const edges = b.flatMap((x) => x.records).flatMap((r) => ("edge" in r && r.edge.kind === "calls.call" && String(r.edge.attrs?.callee) === "this._complete" ? [r.edge as IREdge] : []));
    const byLine = new Map(edges.map((e) => [e.span!.start[0] + 1, e.attrs]));
    expect(byLine.get(48)).toMatchObject({ knownState: { "states/connection.ts#Connection._state": ["ConnState.Disconnecting"] } });
    expect(byLine.get(52)).not.toHaveProperty("knownState");
  });

  it("activation: setter body emits nothing, each call emits a write with via, predicate narrows", async () => {
    const b = await extractAll();
    const ws = writesOf(nodes(b, "state.write"), "states/activation.ts#Activator.state");
    expect(ws.map((w) => w.span!.start[0] + 1).sort((x, y) => x - y)).toEqual([9, 24, 29, 31, 36]);
    for (const w of ws.filter((x) => x.attrs.op === "set")) expect(w.attrs.via).toBe("states/activation.ts#Activator._changeState");
    const at = (line: number) => ws.find((n) => n.span!.start[0] === line - 1)!;
    expect(at(36).attrs.from).toEqual(["ActivationState.DEACTIVATING"]);
    expect(at(24).attrs.from).toEqual(["ActivationState.DEACTIVATING", "ActivationState.INACTIVE"]);
  });

  it("tests: || has no arm, switch group merges", async () => {
    const b = await extractAll();
    const ts = nodes(b, "state.test").filter((n) => n.attrs.holder === "states/machines.ts#Worker.phase");
    const or = ts.find((n) => n.span!.start[0] === 33)!;
    expect(or.attrs.arm).toBeUndefined();
    expect(or.attrs.elseArm).toBeUndefined();
    const grp = ts.find((n) => n.span!.start[0] === 83)!;
    expect(grp.attrs.values).toEqual(['"idle"', '"busy"']);
  });
});

describe("review fixes", () => {
  async function run(file: string, src?: string): Promise<IRBatch[]> {
    const batches: IRBatch[] = [];
    const lf = [file];
    const rf = src === undefined ? readFile : async (rel: string) => (rel === file ? src : readFile(rel));
    const ctx = { root, files: lf, listFiles: () => [...lf], readFile: rf, log: () => undefined };
    for await (const batch of frontend.extract(ctx)) batches.push(batch);
    return batches;
  }
  let cache: IRBatch[] | undefined;
  const review = async () => (cache ??= await run("states/review.ts"));
  const wr = async (fn: string) => nodes(await review(), "state.write").filter((n) => n.parent === `states/review.ts#${fn}`);
  const calls = async (fn: string) =>
    (await review()).flatMap((b) => b.records).flatMap((r) => ("edge" in r && r.edge.kind === "calls.call" && r.edge.from === `states/review.ts#${fn}` ? [r.edge] : []));

  it("entry: a join with a non-entry set drops fromEntry", async () => {
    const [b, c] = await wr("Entry.step");
    expect(b!.attrs).toMatchObject({ value: "S.B", fromEntry: true });
    expect(c!.attrs.from).toBeUndefined();
    expect(c!.attrs.fromEntry).toBeUndefined();
  });
  it("entry: a first write is fromEntry, one after an await is fromEntry + stale (E1)", async () => {
    expect((await wr("Entry.go"))[0]!.attrs).toMatchObject({ fromEntry: true });
    expect((await wr("Entry.go"))[0]!.attrs.stale).toBeUndefined();
    expect((await wr("Entry.goAwait"))[0]!.attrs).toMatchObject({ fromEntry: true, stale: true });
  });
  it("entry: a catch write keeps the stale entry when no try write can be seen (E1)", async () => {
    const ws = await wr("Entry.tryCatch");
    expect(ws.find((w) => w.attrs.value === "S.X")!.attrs).toMatchObject({ fromEntry: true, stale: true });
  });
  it("entry: a call after an await has knownEntry and knownStale (E1)", async () => {
    const inner = (await calls("Entry.outerAwait")).find((e) => e.attrs?.knownEntry);
    expect(inner?.attrs).toMatchObject({ knownEntry: ["states/review.ts#Entry.s"], knownStale: ["states/review.ts#Entry.s"] });
  });
  it("entry: a call before any write has knownEntry; a tested call has knownState", async () => {
    const inner = (await calls("Entry.outer")).find((e) => e.attrs?.knownEntry);
    expect(inner?.attrs?.knownEntry).toEqual(["states/review.ts#Entry.s"]);
    expect(inner?.attrs?.knownState).toBeUndefined();
    const tested = (await calls("Entry.outerTested"))[0]!;
    expect(tested.attrs).toMatchObject({ knownState: { "states/review.ts#Entry.s": ["S.A"] } });
    expect(tested.attrs?.knownEntry).toBeUndefined();
  });
  it("bug 1: the state after finally comes from the normal paths", async () => {
    const ws = await wr("Fin.run");
    expect(ws[ws.length - 1]!.attrs.from).toEqual(["S.B", "S.C"]);
  });
  it("bug 2: a setter with an early exit before the assignment is not a setter", async () => {
    expect((await wr("Guarded.caller")).filter((n) => n.attrs.via)).toEqual([]);
    expect((await wr("Guarded.set"))[0]!.attrs.dynamic).toBe(true);
  });
  it("bug 4: an assignment through a set accessor is a write with via", async () => {
    const ws = await wr("Acc.go");
    expect(ws).toHaveLength(1);
    expect(ws[0]!.attrs).toMatchObject({ holder: "states/review.ts#Acc._s", value: "S.B", op: "set" });
    expect(ws[0]!.attrs.via).toBeTruthy();
    // the accessor body itself adds nothing
    const all = nodes(await review(), "state.write").filter((n) => n.attrs.holder === "states/review.ts#Acc._s");
    expect(all).toHaveLength(2);
  });
  it("bug 5: case A + default keeps A", async () => {
    const [w] = await wr("Sw.run");
    expect(w!.attrs.from).toContain("S.A");
    expect(w!.attrs.from).not.toContain("S.B");
  });
  it("bug 6: break out of a labelled block or switch reaches the join", async () => {
    const blk = await wr("Lbl.blk");
    expect(blk[blk.length - 1]!.attrs.from).toEqual(["S.A", "S.B"]);
    const sw = await wr("Lbl.sw");
    expect(sw[sw.length - 1]!.attrs.from).toContain("S.A");
  });
  it("bug 7: for await goes stale and can throw", async () => {
    const run1 = await wr("FA.run");
    expect(run1[1]!.attrs).toMatchObject({ from: ["S.A"], stale: true });
    const g = await wr("FA.guarded");
    const c = g.find((n) => n.attrs.value === "S.C")!;
    expect(c.attrs.from).toEqual(["S.Idle", "S.A"]);
    expect(c.attrs.stale).toBe(true);
  });
  it("bug 8: a parameter-property initializer is an init write", async () => {
    const ws = nodes(await review(), "state.write").filter((n) => n.attrs.holder === "states/review.ts#PP.s");
    expect(ws).toHaveLength(1);
    expect(ws[0]!.attrs).toMatchObject({ op: "init", value: "S.A" });
  });
  it("gaps: while loop writes, nested try", async () => {
    const w = await wr("Loops.w");
    expect(w[1]!.attrs.from).toEqual(["S.A"]);
    expect(w[3]!.attrs.from).toEqual(["S.A", "S.B"]);
    const nt = await wr("Loops.nt");
    expect(nt.find((n) => n.attrs.value === "S.B")!.attrs.from).toEqual(["S.Idle", "S.A"]);
    expect(nt.find((n) => n.attrs.value === "S.D")!.attrs.from).toEqual(["S.Idle", "S.A", "S.B", "S.C"]);
  });
  it("risk 9: deeply nested loops stay cheap", async () => {
    const depth = 10;
    let body = "this.s = S.B;";
    for (let i = 0; i < depth; i++) body = `this.s = S.A; while (f) { ${body} this.s = S.C; if (f) continue; this.s = S.D; }`;
    const src = `import { S } from "./review";\ndeclare const f: boolean;\nexport class Deep { s: S = S.Idle; go() { ${body} } }\n`;
    const t0 = Date.now();
    const b = await run("states/deep.ts", src);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(nodes(b, "state.write").length).toBeGreaterThan(depth);
  });
});

describe("review round 2", () => {
  let cache: IRBatch[] | undefined;
  const rv = async (): Promise<IRBatch[]> => {
    if (cache) return cache;
    const batches: IRBatch[] = [];
    const lf = ["states/review2.ts"];
    const ctx = { root, files: lf, listFiles: () => [...lf], readFile, log: () => undefined };
    for await (const batch of frontend.extract(ctx)) batches.push(batch);
    return (cache = batches);
  };
  const wr = async (fn: string) =>
    nodes(await rv(), "state.write")
      .filter((n) => n.parent === `states/review2.ts#${fn}`)
      .sort((x, y) => x.span!.start[0] - y.span!.start[0]);
  const last = async (fn: string) => {
    const w = await wr(fn);
    return w[w.length - 1]!.attrs;
  };

  it("item 1: a throw from the catch and a return from the try reach the finally entry", async () => {
    expect((await last("Fin.thrown")).from).toEqual(expect.arrayContaining(["S.A", "S.B"]));
    expect((await last("Fin.returned")).from).toEqual(expect.arrayContaining(["S.C"]));
  });
  it("item 1: a break through a finally continues with the state after the finally", async () => {
    const from = (await last("Fin.broken")).from as string[];
    expect(from).toContain("S.B");
    expect(from).not.toContain("S.A");
  });
  it("item 2: iterating continues after widening", async () => {
    expect((await last("Wide.drive")).from).toEqual(["S.Idle", "S.C"]);
  });
  it("item 3: a write followed by a throw through the loop back edge (while, for, for-of, for-await)", async () => {
    for (const fn of ["w", "wAwait", "fr", "fo", "fa"]) {
      const y = (await wr(`Poll.${fn}`)).find((n) => n.attrs.value === "S.Y")!;
      expect(y.attrs.from, fn).toEqual(expect.arrayContaining(["S.A"]));
    }
  });
  it("item 4: after a parameter-property default the set is plain unknown", async () => {
    const [, b] = await wr("PP.constructor");
    expect(b!.attrs.from).toBeUndefined();
    expect(b!.attrs.fromEntry).toBeUndefined();
  });
  it("item 8: a test through a plain getter narrows the backing field", async () => {
    const [w] = await wr("Get.go");
    expect(w!.attrs).toMatchObject({ holder: "states/review2.ts#Get._s", from: ["S.A"] });
  });
  it("item 9: a negated test on an entry set never keeps the entry marker", async () => {
    const [w] = await wr("Neg.go");
    expect(w!.attrs.fromEntry).toBeUndefined();
    expect(w!.attrs.from).toEqual(["S.Idle", "S.B", "S.C", "S.D", "S.X", "S.Y"]);
  });
  it("item 10: a call to a same-class method that writes the holder resets the set", async () => {
    for (const fn of ["Reset.go", "Reset.go2"]) {
      const [w] = await wr(fn);
      expect(w!.attrs.fromEntry, fn).toBeUndefined();
      expect(w!.attrs.from, fn).toBeUndefined();
    }
    const [p] = await wr("Reset.plain");
    expect(p!.attrs.fromEntry).toBe(true);
  });
});

describe("review round 3", () => {
  let cache: IRBatch[] | undefined;
  const rv = async (): Promise<IRBatch[]> => {
    if (cache) return cache;
    const batches: IRBatch[] = [];
    const lf = ["states/review3.ts"];
    const ctx = { root, files: lf, listFiles: () => [...lf], readFile, log: () => undefined };
    for await (const batch of frontend.extract(ctx)) batches.push(batch);
    return (cache = batches);
  };
  const wr = async (fn: string) =>
    nodes(await rv(), "state.write")
      .filter((n) => n.parent === `states/review3.ts#${fn}`)
      .sort((x, y) => x.span!.start[0] - y.span!.start[0]);
  const lastOf = async (fn: string) => {
    const w = await wr(fn);
    return w[w.length - 1]!.attrs;
  };

  it("item 1: call invalidation reaches the catch of the enclosing try", async () => {
    const [w] = await wr("I1.go");
    expect(w!.attrs.fromEntry).toBeUndefined();
  });
  it("item 2: a method cycle does not cache a partial write set", async () => {
    expect((await lastOf("I2.go")).fromEntry).toBeUndefined();
  });
  it("item 3: a throw in a try with only a finally goes to that finally, then outward", async () => {
    expect((await lastOf("I3.nestedFinally")).from).toEqual(["S.Idle", "S.C"]);
  });
  it("item 5: a throw caught by an inner catch does not reach the outer finally", async () => {
    const from = (await lastOf("I3.innerCatch")).from as string[];
    expect(from).not.toContain("S.X");
    expect(from).toContain("S.A");
  });
  it("item 8: implicit throws inside a catch reach its finally", async () => {
    expect((await lastOf("I3.implicit")).from).toEqual(expect.arrayContaining(["S.F", "S.A"]));
  });
  it("item 4: a setter helper invalidates the other holders it writes", async () => {
    const t = (await wr("I4.go")).find((n) => n.attrs.holder.endsWith(".t"))!;
    expect(t.attrs.fromEntry).toBeUndefined();
  });
  it("item 6: an abstract this.hook() call makes the holders plain unknown", async () => {
    const [w] = await wr("I6.go");
    expect(w!.attrs.fromEntry).toBeUndefined();
  });
  it("deferred: a callback created by a called method does not invalidate the holder", async () => {
    const [w] = await wr("Defer.start");
    expect(w!.attrs).toMatchObject({ fromEntry: true, stale: true });
  });
});
