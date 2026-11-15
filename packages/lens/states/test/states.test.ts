import { describe, expect, it } from "vitest";
import * as fx from "@insight/sdk/testing";
import { type IRNode, type IREdge } from "@insight/ir";
import { createCoreRegistry } from "@insight/ir/node";
import { type StateMachineView, type TableView, type IRView } from "@insight/sdk";
import { runAnalysis, type LoadedLens } from "@insight/indexer";
import { displayValue, lensStates, stateMachines, type Machine } from "../src/index.js";

const ctx = (scope?: string) => ({ root: { path: "/unused", name: "fixture", allowBuildTools: false }, resultOf: () => undefined, ...(scope !== undefined ? { scope } : {}) });

const FILE = "src/m.ts";
const at = (line: number) => fx.span(FILE, line, 2, line, 30);

const fn = (name: string, line: number, file = FILE) =>
  fx.node(`${file}#${name}`, "structure", "structure.function", { parent: file, attrs: { name }, span: fx.span(file, line, 0, line + 3, 1) });
const fileNode = (file = FILE) => fx.node(file, "structure", "structure.file");
const holder = (id: string, name: string, values: string[], kind: "enum" | "union" | "open" = "union", file = FILE) =>
  fx.node(id, "state", "state.holder", { parent: file, attrs: { name, domainKind: kind, values }, span: fx.span(file, 1, 0, 1, 20) });

let seq = 0;
interface W {
  holder: string;
  fn: string;
  value?: string;
  op?: "init" | "set";
  from?: string[];
  fromEntry?: boolean;
  stale?: boolean;
  dynamic?: boolean;
  guardMatch?: string;
  event?: string;
  guardText?: string;
  ownerLabel?: string;
  line?: number;
  file?: string;
  confidence?: "exact" | "inferred" | "heuristic";
}
const write = (w: W): IRNode => {
  const file = w.file ?? FILE;
  return fx.node(`${file}#${w.fn}@w${++seq}`, "state", "state.write", {
    parent: `${file}#${w.fn}`,
    span: fx.span(file, w.line ?? 10 + seq, 2, w.line ?? 10 + seq, 30),
    ...(w.confidence ? { confidence: w.confidence } : {}),
    attrs: {
      holder: w.holder,
      op: w.op ?? "set",
      ...(w.value !== undefined ? { value: w.value } : {}),
      ...(w.dynamic ? { dynamic: true } : {}),
      ...(w.from ? { from: w.from } : {}),
      ...(w.fromEntry ? { fromEntry: true } : {}),
      ...(w.stale ? { stale: true } : {}),
      ...(w.guardMatch ? { guardMatch: w.guardMatch } : {}),
      ...(w.event ? { event: w.event } : {}),
      ...(w.guardText ? { guardText: w.guardText } : {}),
      ...(w.ownerLabel ? { ownerLabel: w.ownerLabel } : {}),
    },
  });
};
const test = (id: string, holderId: string, fnName: string, values: string[], extra: Record<string, unknown> = {}): IRNode =>
  fx.node(id, "state", "state.test", { parent: `${FILE}#${fnName}`, span: at(40), attrs: { holder: holderId, values, arm: "arm1", ...extra } });
const call = (from: string, to: string | string[], known?: Record<string, string[]>, confidence?: "exact" | "inferred", entry?: string[]): IREdge =>
  fx.edge(`${FILE}#${from}`, Array.isArray(to) ? to.map((t) => `${FILE}#${t}`) : `${FILE}#${to}`, "calls", "calls.call", {
    span: at(60),
    ...(confidence ? { confidence } : {}),
    ...(known || entry ? { attrs: { ...(known ? { knownState: known } : {}), ...(entry ? { knownEntry: Object.fromEntries(entry.map((h) => [h, true])) } : {}) } } : {}),
  });

const q = (v: string) => JSON.stringify(v);
const H = `${FILE}#Job.status`;
const dom = ["idle", "run", "done", "fail"].map(q);

/** Simple reducer-like machine: idle -> run -> done|fail, a self loop on run, terminal done and fail. */
function jobNodes(): IRNode[] {
  return [
    fileNode(),
    fn("ctor", 2), fn("start", 10), fn("tick", 20), fn("finish", 30), fn("reset", 40),
    holder(H, "Job.status", dom),
    write({ holder: H, fn: "ctor", value: q("idle"), op: "init" }),
    write({ holder: H, fn: "start", value: q("run"), from: [q("idle")], guardText: "ready" }),
    write({ holder: H, fn: "tick", value: q("run"), from: [q("run")] }),
    write({ holder: H, fn: "finish", value: q("done"), from: [q("run")] }),
    write({ holder: H, fn: "finish", value: q("fail"), from: [q("run")], event: "error" }),
    write({ holder: H, fn: "reset", value: q("idle") }),
    test("t1", H, "tick", [q("run")]),
  ];
}

const arcs = (m: Machine) => m.transitions.map((t) => `${displayValue(t.from)}>${displayValue(t.to)}:${t.confidence}`);

describe("stateMachines: basic shapes", () => {
  it("builds a reducer with a guarded transition, a self transition, a terminal state and an any-state reset", () => {
    const { machines } = stateMachines(fx.view({ nodes: jobNodes() }));
    expect(machines).toHaveLength(1);
    const m = machines[0] as Machine;
    expect(arcs(m).sort()).toEqual(
      ["any state>idle:exact", "start>idle:exact", "idle>run:exact", "run>run:exact", "run>done:exact", "run>fail:exact"].sort(),
    );
    const guarded = m.transitions.find((t) => t.from === q("idle") && t.to === q("run"));
    expect(guarded?.sites[0]?.guard).toBe("ready");
    expect(m.transitions.find((t) => t.to === q("fail"))?.label).toBe("error");
    // terminal: done and fail have no outgoing arcs
    for (const v of [q("done"), q("fail")]) expect(m.transitions.some((t) => t.from === v)).toBe(false);
    expect(m.states.map((s) => s.kind)).not.toContain("unentered");
    expect(m.states.find((s) => s.value === "●")?.kind).toBe("initial");
    expect(m.states.find((s) => s.value === "*")?.kind).toBe("any");
  });

  it("draws two machines in one view", () => {
    const H2 = `${FILE}#Door.open`;
    const nodes = [
      ...jobNodes(),
      fn("openIt", 50), fn("closeIt", 60),
      holder(H2, "Door.open", [q("open"), q("shut")]),
      write({ holder: H2, fn: "openIt", value: q("open"), from: [q("shut")] }),
      write({ holder: H2, fn: "closeIt", value: q("shut"), from: [q("open")] }),
    ];
    const { machines } = stateMachines(fx.view({ nodes }));
    expect(machines.map((m) => m.holderId)).toEqual([H, H2]);
  });

  it("skips a holder with one written value or no set write", () => {
    const H3 = `${FILE}#X.kind`;
    const H4 = `${FILE}#Y.kind`;
    const nodes = [
      fileNode(), fn("a", 2), fn("b", 10),
      holder(H3, "X.kind", [q("a"), q("b")]), holder(H4, "Y.kind", [q("a"), q("b")]),
      write({ holder: H3, fn: "a", value: q("a") }),
      write({ holder: H4, fn: "a", value: q("a"), op: "init" }),
      write({ holder: H4, fn: "b", value: q("b"), op: "init" }),
    ];
    const r = stateMachines(fx.view({ nodes }));
    expect(r.machines).toHaveLength(0);
    expect(r.counts.holdersSkipped).toBe(2);
  });

  it("draws a machine without any test (A7)", () => {
    const nodes = jobNodes().filter((n) => n.kind !== "state.test");
    expect(stateMachines(fx.view({ nodes })).machines).toHaveLength(1);
  });

  it("draws an open-domain holder with a note and no domain states", async () => {
    const O = `${FILE}#Open.x`;
    const nodes = [
      fileNode(), fn("a", 2), fn("b", 10),
      holder(O, "Open.x", [], "open"),
      write({ holder: O, fn: "a", value: q("p"), from: [q("q")] }),
      write({ holder: O, fn: "b", value: q("q"), from: [q("p")] }),
      test("ot", O, "a", [q("zzz")]),
    ];
    const v = fx.view({ nodes });
    const m = stateMachines(v).machines[0] as Machine;
    expect(m.notes.join()).toMatch(/Domain unknown/);
    const result = await lensStates.run(v, ctx());
    expect(result.findings).toEqual([]);
  });
});

describe("cross-call entry sets", () => {
  const G = `${FILE}#Conn.state`;
  // `close` has no early exit: it writes Closed with no `from`.
  const base = (): IRNode[] => [
    fileNode(), fn("ctor", 2), fn("open", 10), fn("close", 20), fn("viaArm", 30), fn("viaCallback", 40), fn("register", 50),
    holder(G, "Conn.state", [q("Closed"), q("Open"), q("Busy")]),
    write({ holder: G, fn: "ctor", value: q("Closed"), op: "init" }),
    write({ holder: G, fn: "open", value: q("Open"), from: [q("Closed")] }),
    write({ holder: G, fn: "close", value: q("Closed"), fromEntry: true }),
  ];

  it("takes the entry set from its only exact caller: inferred, no star", () => {
    const edges = [call("viaArm", "close", { [G]: [q("Open")] })];
    const m = stateMachines(fx.view({ nodes: base(), edges })).machines[0] as Machine;
    const closeArcs = m.transitions.filter((t) => t.label === "close");
    expect(closeArcs.map((t) => `${displayValue(t.from)}>${displayValue(t.to)}:${t.confidence}`)).toEqual(["Open>Closed:inferred"]);
    expect(m.transitions.some((t) => t.from === "*")).toBe(false);
  });

  it("brings the star back when one more caller is a callback without a known state", () => {
    const edges = [
      call("viaArm", "close", { [G]: [q("Open")] }),
      fx.edge(`${FILE}#register`, `${FILE}#close`, "calls", "calls.reference", { attrs: { how: "handler" } }),
    ];
    const m = stateMachines(fx.view({ nodes: base(), edges })).machines[0] as Machine;
    const closeArcs = m.transitions.filter((t) => t.label === "close").map((t) => `${displayValue(t.from)}>${displayValue(t.to)}:${t.confidence}`);
    expect(closeArcs.sort()).toEqual(["Open>Closed:inferred", "any state>Closed:inferred"].sort());
  });

  it("keeps the star for a plain call edge with no known state", () => {
    const edges = [call("viaArm", "close", { [G]: [q("Open")] }), call("viaCallback", "close")];
    const m = stateMachines(fx.view({ nodes: base(), edges })).machines[0] as Machine;
    expect(m.transitions.filter((t) => t.label === "close" && t.from === "*")).toHaveLength(1);
  });

  it("lets an unguarded caller inherit its own entry set from its callers (depth 2)", () => {
    const edges = [call("viaCallback", "close", undefined, undefined, [G]), call("viaArm", "viaCallback", { [G]: [q("Busy")] })];
    const m = stateMachines(fx.view({ nodes: base(), edges })).machines[0] as Machine;
    const closeArcs = m.transitions.filter((t) => t.label === "close").map((t) => `${displayValue(t.from)}>${displayValue(t.to)}:${t.confidence}`);
    expect(closeArcs).toEqual(["Busy>Closed:inferred"]);
  });

  it("keeps the star for a write without fromEntry, even under a known caller (a)", () => {
    const nodes = [
      fileNode(), fn("step", 10), fn("caller", 20),
      holder(G, "Conn.state", [q("A"), q("B"), q("C")]),
      write({ holder: G, fn: "step", value: q("B"), fromEntry: true }),
      write({ holder: G, fn: "step", value: q("C") }),
      write({ holder: G, fn: "caller", value: q("A"), op: "init" }),
    ];
    const m = stateMachines(fx.view({ nodes, edges: [call("caller", "step", { [G]: [q("A")] })] })).machines[0] as Machine;
    const toC = m.transitions.filter((t) => t.to === q("C")).map((t) => displayValue(t.from));
    expect(toC).toEqual(["any state"]);
    expect(m.transitions.some((t) => t.from === q("A") && t.to === q("C"))).toBe(false);
  });

  it("follows knownEntry up to _reconnect (b: SignalR shape), no star", () => {
    const D = (v: string) => q(v);
    const nodes = [
      fileNode(), fn("ctor", 2), fn("_completeClose", 10), fn("_reconnect", 20), fn("_closing", 30), fn("_conn", 40),
      holder(G, "Hub.state", [D("Connected"), D("Disconnecting"), D("Disconnected")]),
      write({ holder: G, fn: "ctor", value: D("Connected"), op: "init" }),
      write({ holder: G, fn: "_completeClose", value: D("Disconnected"), fromEntry: true }),
      write({ holder: G, fn: "_closing", value: D("Disconnecting"), from: [D("Connected")] }),
    ];
    const edges = [
      call("_closing", "_completeClose", { [G]: [D("Disconnecting")] }),
      call("_reconnect", "_completeClose", undefined, undefined, [G]),
      call("_conn", "_reconnect", { [G]: [D("Connected")] }),
    ];
    const m = stateMachines(fx.view({ nodes, edges })).machines[0] as Machine;
    const arcs2 = m.transitions.filter((t) => t.to === D("Disconnected")).map((t) => `${displayValue(t.from)}>${displayValue(t.to)}:${t.confidence}`);
    expect(arcs2.sort()).toEqual(["Connected>Disconnected:inferred", "Disconnecting>Disconnected:inferred"]);
  });

  it("terminates on a knownEntry cycle a -> b -> a and keeps the star (c)", () => {
    const edges = [call("viaArm", "close", undefined, undefined, [G]), call("close", "viaArm", undefined, undefined, [G])];
    const m = stateMachines(fx.view({ nodes: base(), edges })).machines[0] as Machine;
    expect(m.transitions.some((t) => t.label === "close" && t.from === "*")).toBe(true);
  });

  it("keeps the star when the knownState is three callers up (d)", () => {
    const edges = [
      call("viaArm", "close", undefined, undefined, [G]),
      call("viaCallback", "viaArm", undefined, undefined, [G]),
      call("register", "viaCallback", { [G]: [q("Busy")] }),
    ];
    const m = stateMachines(fx.view({ nodes: base(), edges })).machines[0] as Machine;
    expect(m.transitions.some((t) => t.label === "close" && t.from === "*")).toBe(true);
    expect(m.transitions.some((t) => t.label === "close" && t.from === q("Busy"))).toBe(false);
  });

  it("terminates on recursion and callback cycles", () => {
    const edges = [call("close", "close"), call("viaCallback", "close"), call("close", "viaCallback")];
    const r = stateMachines(fx.view({ nodes: base(), edges }));
    expect(r.machines).toHaveLength(1);
    const m = r.machines[0] as Machine;
    expect(m.transitions.some((t) => t.label === "close" && t.from === "*")).toBe(true);
  });

  it("ignores a non-exact call edge as a source of known state", () => {
    const edges = [call("viaArm", ["close", "open"], { [G]: [q("Open")] })];
    const m = stateMachines(fx.view({ nodes: base(), edges })).machines[0] as Machine;
    expect(m.transitions.some((t) => t.label === "close" && t.from === "*")).toBe(true);
  });
});

describe("confidence", () => {
  const nodes = (w: Partial<W>): IRNode[] => [
    fileNode(), fn("a", 2), fn("b", 10),
    holder(H, "Job.status", dom),
    write({ holder: H, fn: "a", value: q("idle"), op: "init" }),
    write({ holder: H, fn: "b", value: q("run"), from: [q("idle")], ...w }),
  ];
  it("makes a stale write inferred", () => {
    const m = stateMachines(fx.view({ nodes: nodes({ stale: true }) })).machines[0] as Machine;
    expect(m.transitions.find((t) => t.to === q("run"))?.confidence).toBe("inferred");
  });
  it("makes a holder-matched guard inferred", () => {
    const m = stateMachines(fx.view({ nodes: nodes({ guardMatch: "holder" }) })).machines[0] as Machine;
    expect(m.transitions.find((t) => t.to === q("run"))?.confidence).toBe("inferred");
  });
  it("keeps a receiver-matched exact guard exact, and heuristic provenance heuristic", () => {
    const e = stateMachines(fx.view({ nodes: nodes({ guardMatch: "receiver" }) })).machines[0] as Machine;
    expect(e.transitions.find((t) => t.to === q("run"))?.confidence).toBe("exact");
    const h = stateMachines(fx.view({ nodes: nodes({ confidence: "heuristic" }) })).machines[0] as Machine;
    expect(h.transitions.find((t) => t.to === q("run"))?.confidence).toBe("heuristic");
  });
});

describe("HttpConnection._connectionState", () => {
  const HC = "src/HttpConnection.ts#HttpConnection._connectionState";
  const F = "src/HttpConnection.ts";
  const CS = (m: string) => `ConnectionState.${m}`;
  const nodes = (): IRNode[] => [
    fileNode(F),
    ...["ctor", "start", "_startInternal", "stop", "_stopConnection", "onclose"].map((n, i) => fn(n, 10 * (i + 1), F)),
    holder(HC, "HttpConnection._connectionState", ["Connecting", "Connected", "Disconnected", "Disconnecting"].map(CS), "enum", F),
    write({ file: F, holder: HC, fn: "ctor", value: CS("Disconnected"), op: "init", line: 128 }),
    write({ file: F, holder: HC, fn: "start", value: CS("Connecting"), from: [CS("Disconnected")], line: 149 }),
    write({ file: F, holder: HC, fn: "_startInternal", value: CS("Connected"), from: [CS("Connecting")], line: 314 }),
    // catch: entry from the one caller, plus the spurious try-written twin (S2).
    write({ file: F, holder: HC, fn: "_startInternal", value: CS("Disconnected"), fromEntry: true, line: 322 }),
    write({ file: F, holder: HC, fn: "_startInternal", value: CS("Disconnected"), from: [CS("Connected")], stale: true, line: 322 }),
    write({ file: F, holder: HC, fn: "stop", value: CS("Disconnecting"), from: [CS("Connecting"), CS("Connected")], line: 198 }),
    write({ file: F, holder: HC, fn: "_stopConnection", value: CS("Disconnected"), from: [CS("Connected"), CS("Disconnecting")], line: 662 }),
  ];
  const edges = (): IREdge[] => [
    fx.edge(`${F}#start`, `${F}#_startInternal`, "calls", "calls.call", { attrs: { knownState: { [HC]: [CS("Connecting")] } } }),
    fx.edge(`${F}#stop`, `${F}#_stopConnection`, "calls", "calls.call", { attrs: { knownState: { [HC]: [CS("Disconnecting")] } } }),
    fx.edge(`${F}#onclose`, `${F}#_stopConnection`, "calls", "calls.reference"),
  ];

  it("yields exactly the expected edge list", () => {
    const m = stateMachines(fx.view({ nodes: nodes(), edges: edges() })).machines[0] as Machine;
    expect(arcs(m).sort()).toEqual(
      [
        "start>Disconnected:exact",
        "Disconnected>Connecting:exact",
        "Connecting>Connected:exact",
        "Connecting>Disconnected:inferred",
        "Connected>Disconnected:inferred",
        "Connecting>Disconnecting:exact",
        "Connected>Disconnecting:exact",
        "Connected>Disconnected:exact",
        "Disconnecting>Disconnected:exact",
      ].sort(),
    );
    // _stopConnection's own early exits bound `from`, so no star arc despite its callback caller.
    expect(m.transitions.some((t) => t.from === "*")).toBe(false);
  });
});

describe("lambda labels", () => {
  it("labels an arc from a lambda by its ownerLabel and keeps the lambda's location in the site", () => {
    const nodes = [
      fileNode(), fn("λ12:3", 12), fn("a", 2),
      holder(H, "Job.status", dom),
      write({ holder: H, fn: "a", value: q("idle"), op: "init" }),
      write({ holder: H, fn: "λ12:3", value: q("run"), from: [q("idle")], ownerLabel: "_connect › onWebSocketClose" }),
    ];
    const m = stateMachines(fx.view({ nodes })).machines[0]!;
    const t = m.transitions.find((x) => x.to === q("run"))!;
    expect(t.label).toBe("_connect › onWebSocketClose");
    expect(t.sites[0]!.fn).toBe("λ12:3");
  });
});

describe("dynamic writes", () => {
  it("gives no edge, and is counted", async () => {
    const nodes = [...jobNodes(), write({ holder: H, fn: "tick", dynamic: true })];
    const v = fx.view({ nodes });
    const before = stateMachines(fx.view({ nodes: jobNodes() })).machines[0] as Machine;
    const m = stateMachines(v).machines[0] as Machine;
    expect(m.transitions).toHaveLength(before.transitions.length);
    expect(m.dynamic).toBe(1);
    const r = await lensStates.run(v, ctx());
    expect(r.metrics.dynamicWrites).toBe(1);
  });
});

describe("findings", () => {
  // Three written values, `fail` never written, and a test for `fail`.
  const nodes = (): IRNode[] => [
    fileNode(), fn("a", 2), fn("b", 10), fn("c", 20),
    holder(H, "Job.status", dom),
    write({ holder: H, fn: "a", value: q("idle"), op: "init" }),
    write({ holder: H, fn: "b", value: q("run"), from: [q("idle")] }),
    write({ holder: H, fn: "c", value: q("done"), from: [q("run")] }),
    test("tdead", H, "c", [q("fail")]),
    test("tlive", H, "c", [q("run")]),
  ];

  it("raises unentered and dead-test on the project pass", async () => {
    const r = await lensStates.run(fx.view({ nodes: nodes() }), ctx());
    expect(r.findings.map((f) => [f.id, f.severity])).toEqual([
      ["dead-test:tdead", "info"],
      [`unentered:${H}|${q("fail")}`, "warning"],
    ]);
    const m = (r.views.find((v) => v.type === "state-machine") as StateMachineView).states;
    expect(m.find((s) => s.id === `${H}|${q("fail")}`)?.kind).toBe("unentered");
  });

  it("raises no never-set or dead-test finding for a holder with a dynamic write (risk 13)", async () => {
    const r = await lensStates.run(fx.view({ nodes: [...nodes(), write({ holder: H, fn: "b", dynamic: true })] }), ctx());
    expect(r.findings).toEqual([]);
  });

  it("raises no value-coverage finding for a holder that is not a machine (A7)", async () => {
    const H2 = `${FILE}#Iface.transport`;
    const n = [
      fileNode(), fn("a", 2),
      holder(H2, "Iface.transport", [q("none"), q("ws"), q("sse")]),
      test("tx", H2, "a", [q("none")]),
    ];
    const r = await lensStates.run(fx.view({ nodes: n }), ctx());
    expect(r.findings).toEqual([]);
    // one init write only: still not a machine
    const n2 = [...n, write({ holder: H2, fn: "a", value: q("ws"), op: "init" })];
    expect((await lensStates.run(fx.view({ nodes: n2 }), ctx())).findings).toEqual([]);
  });

  it("raises the same on scope \"\" and none with a scope", async () => {
    const v = fx.view({ nodes: nodes() });
    expect((await lensStates.run(v, ctx(""))).findings).toHaveLength(2);
    expect((await lensStates.run(v, ctx("src"))).findings).toEqual([]);
  });

  it("raises no unentered for a holder with fewer than three written values (A4), but still draws it grey", async () => {
    const n = nodes().filter((x) => !x.id.endsWith("@w" + (seq)) && x.id !== "tdead");
    const two = [...n.filter((x) => x.kind !== "state.write"), ...n.filter((x) => x.kind === "state.write").slice(0, 2)];
    const r = await lensStates.run(fx.view({ nodes: two }), ctx());
    expect(r.findings.filter((f) => f.id.startsWith("unentered"))).toEqual([]);
    const states = (r.views.find((v) => v.type === "state-machine") as StateMachineView).states;
    expect(states.filter((s) => s.kind === "unentered").length).toBeGreaterThan(0);
  });
});

describe("output", () => {
  it("is stable under shuffled input", async () => {
    const nodes = [...jobNodes(), holder(`${FILE}#Door.open`, "Door.open", [q("open"), q("shut")]), fn("o", 70), fn("c", 80),
      write({ holder: `${FILE}#Door.open`, fn: "o", value: q("open"), from: [q("shut")] }),
      write({ holder: `${FILE}#Door.open`, fn: "c", value: q("shut"), from: [q("open")] })];
    const reversed = [...nodes].reverse();
    const rotated = [...nodes.slice(5), ...nodes.slice(0, 5)];
    const a = await lensStates.run(fx.view({ nodes }), ctx());
    expect(await lensStates.run(fx.view({ nodes: reversed }), ctx())).toEqual(a);
    expect(await lensStates.run(fx.view({ nodes: rotated }), ctx())).toEqual(a);
  });

  it("emits one view per machine ordered by transition count then id, merging same from/to/label with all sites", async () => {
    const D = `${FILE}#Door.open`;
    const nodes = [
      ...jobNodes(), fn("o", 70), fn("o2", 75), holder(D, "Door.open", [q("open"), q("shut")]),
      write({ holder: D, fn: "o", value: q("open"), from: [q("shut")] }),
      write({ holder: D, fn: "o", value: q("open"), from: [q("shut")] }),
      write({ holder: D, fn: "o2", value: q("shut"), from: [q("open")] }),
    ];
    const r = await lensStates.run(fx.view({ nodes }), ctx());
    const machines = r.views.filter((v): v is StateMachineView => v.type === "state-machine");
    expect(machines.map((v) => v.id)).toEqual([`machine:${H}`, `machine:${D}`]);
    const merged = machines[1]?.transitions.find((t) => t.from === `${D}|${q("shut")}`);
    expect(merged?.sites).toHaveLength(2);
    expect(machines[1]?.transitions).toHaveLength(2);
    const tables = r.views.filter((v): v is TableView => v.type === "table");
    expect(tables.map((t) => t.id)).toEqual(["machines", "transitions"]);
    const tr = tables[1] as TableView;
    expect(tr.columns).toEqual(["Holder", "From", "To", "Event", "Guard", "Confidence", "Function", "Line"]);
    expect(tr.spans).toHaveLength(tr.rows.length);
    expect(r.metrics).toMatchObject({ holders: 2, machines: 2 });
    expect(r.metrics.transitions).toBe(6 + 2);
  });

  it("gives zero metrics and no views for zero holders", async () => {
    const r = await lensStates.run(fx.view({ nodes: [fileNode(), fn("a", 2)] }), ctx());
    expect(r.views).toEqual([]);
    expect(Object.values(r.metrics).every((n) => n === 0)).toBe(true);
    expect(Object.keys(r.metrics).sort()).toEqual(
      ["dynamicWrites", "exact", "heuristic", "holders", "holdersSkipped", "inferred", "machines", "staleWrites", "states", "testsWithoutArm", "transitions", "unguardedWrites"],
    );
  });

  it("skips external stubs", () => {
    const stub = fx.node(`${FILE}#ext@w`, "state", "state.write", { attrs: { holder: H, op: "set", value: q("fail"), external: true } });
    const r = stateMachines(fx.view({ nodes: [...jobNodes(), stub] }));
    expect(r.machines[0]?.transitions.some((t) => t.to === q("fail") && t.sites.length > 1)).toBe(false);
    expect(r.counts.holders).toBe(1);
  });
});

describe("scope widening", () => {
  it("exact transitions of a narrower scope are a subset of the wider scope's", () => {
    const FA = "src/a/x.ts";
    const FB = "src/b/y.ts";
    const HH = `${FA}#S.v`;
    const wide = [
      fileNode(FA), fileNode(FB), fn("p", 2, FA), fn("r", 12, FA), fn("s", 2, FB),
      holder(HH, "S.v", [q("a"), q("b"), q("c")], "union", FA),
      write({ file: FA, holder: HH, fn: "p", value: q("a"), op: "init" }),
      write({ file: FA, holder: HH, fn: "r", value: q("b"), from: [q("a")] }),
      write({ file: FB, holder: HH, fn: "s", value: q("c"), from: [q("b")] }),
      write({ file: FB, holder: HH, fn: "s", value: q("a") }),
    ];
    // Scope src/a: the holder stays, FB's nodes are gone.
    const narrow = wide.filter((n) => !n.id.startsWith(FB));
    const exact = (nodes: IRNode[]) =>
      new Set(stateMachines(fx.view({ nodes })).machines.flatMap((m) => m.transitions.filter((t) => t.confidence === "exact").map((t) => `${t.from}>${t.to}:${t.label}`)));
    const n = exact(narrow);
    const w = exact(wide);
    expect(n.size).toBeGreaterThan(0);
    for (const t of n) expect(w.has(t)).toBe(true);
    // Scope src/b: holder is declared outside, so it is drawn without a domain and gets no findings.
    const onlyB = wide.filter((x) => x.id.startsWith(FB) || x.kind === "state.write" ? x.id.startsWith(FB) : x.id === FB);
    const m = stateMachines(fx.view({ nodes: onlyB })).machines;
    expect(m[0]?.declared).toBe(false);
  });
});

describe("registration and reuse", () => {
  const loaded = (): LoadedLens => ({ manifest: { id: "lens-states", version: "0.1.0", irVersion: "^1.0", roles: {} } as never, dir: ".", lens: lensStates });
  const doc = (nodes: IRNode[]) => ({ nodes, edges: [] as IREdge[], findings: [] });
  const root = { path: "/unused", name: "fixture", allowBuildTools: false };
  const registry = createCoreRegistry();

  it("is unavailable without the state facet", async () => {
    const out = await runAnalysis({ doc: doc([fileNode(), fn("a", 2)]), registry, root, snapshot: "s1", lenses: [loaded()], configs: {} });
    expect(out.lenses[0]).toMatchObject({ id: "lens-states", status: "unavailable" });
    expect(out.lenses[0]?.reason).toMatch(/state/);
  });

  it("reuses the result for the same inputs and re-runs when a state node changes", async () => {
    const nodes = jobNodes();
    const first = await runAnalysis({ doc: doc(nodes), registry, root, snapshot: "s1", lenses: [loaded()], configs: {} });
    expect(first.lenses[0]).toMatchObject({ status: "ok", reused: false });
    const same = await runAnalysis({ doc: doc(nodes), registry, root, snapshot: "s2", lenses: [loaded()], configs: {}, previous: first });
    expect(same.lenses[0]?.reused).toBe(true);
    const changed = nodes.map((n) => (n.kind === "state.test" ? { ...n, attrs: { ...n.attrs, values: [q("done")] } } : n));
    const again = await runAnalysis({ doc: doc(changed), registry, root, snapshot: "s3", lenses: [loaded()], configs: {}, previous: same });
    expect(again.lenses[0]?.reused).toBe(false);
  });
});

// keep the IRView import used for typing helpers
export type { IRView };
