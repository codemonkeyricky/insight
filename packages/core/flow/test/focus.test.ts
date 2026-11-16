import { describe, expect, it, beforeAll } from "vitest";
import type { IREdge, IRNode } from "@insight/ir";
import { buildFileFlow, calleeMapFromNodes, calleeMapOf, couplingIndex, execModel, filterChartItems, HIDDEN_EFFECT_PREFIXES, layoutFunction, type FocusCallee, type Item } from "../src/index.js";
import { factsForFile } from "../src/build.js";
import { indexFixture } from "./coupling-fixture.js";

const callees = new Map<string, FocusCallee>([
  ["src/b.ts#helper", { file: "src/b.ts", exported: true }],
  ["src/b.ts#hidden", { file: "src/b.ts", exported: false }],
  ["src/a.ts#local", { file: "src/a.ts", exported: true }],
]);
const opts = { file: "src/a.ts", callees };

const call = (target?: string, extra: Partial<Extract<Item, { t: "step" }>> = {}): Item => ({
  t: "step",
  role: "call",
  label: "f()",
  ...(target !== undefined ? { target } : {}),
  ...extra,
});
const effect = (kind: string): Item => ({ t: "step", role: "effect", label: kind, kind });
const state = (label: string): Item => ({ t: "step", role: "state", label });
const term = (role: "return" | "throw"): Item => ({ t: "term", role, label: role });

/** A labelled list of what a chart draws, flattened in order: `role:label`, forks as `fork:role` with each arm's rows. */
function labels(items: readonly Item[]): string[] {
  return items.flatMap((item): string[] => {
    if (item.t === "step") return [`${item.role}:${item.label}`];
    if (item.t === "term") return [item.role];
    if (item.t === "loop") return ["loop", ...labels(item.body)];
    return [`fork:${item.role}`, ...item.arms.flatMap((a) => [`arm:${a.label}`, ...labels(a.body)])];
  });
}

describe("filterChartItems: effect kinds", () => {
  it("drops fs, os, proc and env effects", () => {
    const kept = filterChartItems(
      [effect("effects.fs.read"), effect("effects.fs.write"), effect("effects.os.call"), effect("effects.proc.exec"), effect("effects.env.read")],
      opts,
    );
    expect(kept).toEqual([]);
    expect(HIDDEN_EFFECT_PREFIXES).toEqual(["effects.fs.", "effects.os.", "effects.proc.", "effects.env."]);
  });

  it("keeps net and clock effects", () => {
    const items = [effect("effects.net.connect"), effect("effects.clock.read")];
    expect(filterChartItems(items, opts)).toEqual(items);
  });
});

describe("filterChartItems: calls", () => {
  it("drops a call to a function of the same file, even when exported", () => {
    expect(filterChartItems([call("src/a.ts#local")], opts)).toEqual([]);
  });

  it("drops a call to a non-exported function of another file", () => {
    expect(filterChartItems([call("src/b.ts#hidden")], opts)).toEqual([]);
  });

  it("drops an unresolved call, a candidate-only call and a call to an external function", () => {
    const candidates = call(undefined, { targets: ["src/b.ts#helper", "src/c.ts#helper"] });
    expect(filterChartItems([call(), candidates, call("node:fs#readFile")], opts)).toEqual([]);
  });

  it("keeps a call to an exported function of another file", () => {
    const item = call("src/b.ts#helper");
    expect(filterChartItems([item], opts)).toEqual([item]);
  });

  it("keeps control flow, awaits, spawns, returns, throws and state rows", () => {
    const items: Item[] = [
      { t: "step", role: "await", label: "await helper", target: "src/b.ts#helper" },
      { t: "step", role: "spawn", label: "spawn thread" },
      state("▽ counter"),
      term("return"),
      term("throw"),
    ];
    expect(filterChartItems(items, opts)).toEqual(items);
  });
});

describe("filterChartItems: awaits and handlers", () => {
  const awaitRow = (label: string, awaited: { call: boolean; effects: string[] }, target?: string): Item => ({
    t: "step",
    role: "await",
    label,
    kind: "concurrency.await",
    awaited,
    ...(target !== undefined ? { target } : {}),
  });

  it("keeps an await of an exported call of another file, and drops an await of a same-file, non-exported or unresolved call", () => {
    const kept = awaitRow("await helper()", { call: true, effects: [] }, "src/b.ts#helper");
    expect(filterChartItems([kept], opts)).toEqual([kept]);
    expect(filterChartItems([awaitRow("await local()", { call: true, effects: [] }, "src/a.ts#local")], opts)).toEqual([]);
    expect(filterChartItems([awaitRow("await hidden()", { call: true, effects: [] }, "src/b.ts#hidden")], opts)).toEqual([]);
    expect(filterChartItems([awaitRow("await", { call: true, effects: [] })], opts)).toEqual([]);
  });

  it("drops an await whose only content was a hidden kernel effect, and keeps one that awaits a net effect or a plain value", () => {
    expect(filterChartItems([awaitRow("await", { call: false, effects: ["effects.fs.read"] })], opts)).toEqual([]);
    expect(filterChartItems([awaitRow("await", { call: false, effects: ["effects.fs.read", "effects.env.read"] })], opts)).toEqual([]);
    const net = awaitRow("await", { call: false, effects: ["effects.net.connect"] });
    expect(filterChartItems([net], opts)).toEqual([net]);
    const value = awaitRow("await", { call: false, effects: [] });
    expect(filterChartItems([value], opts)).toEqual([value]);
  });

  it("keeps a handler row whatever its target: a message handler is coupling", () => {
    const sameFile: Item = call("src/a.ts#local", { label: "on message", handler: true });
    const hiddenFn: Item = call("src/b.ts#hidden", { label: "on message", handler: true });
    const unresolved: Item = call(undefined, { label: "on ▸", handler: true });
    expect(filterChartItems([sameFile, hiddenFn, unresolved], opts)).toEqual([sameFile, hiddenFn, unresolved]);
    // A call that is not a handler is still dropped.
    expect(filterChartItems([call("src/a.ts#local", { label: "local()" })], opts)).toEqual([]);
  });
});

describe("filterChartItems: try and empty forks", () => {
  const tryFork: Item = {
    t: "fork",
    role: "try",
    label: "try",
    arms: [
      { label: "try", kind: "next", body: [call("src/b.ts#helper", { label: "helper()" })] },
      { label: "catch", kind: "exception", body: [call("src/b.ts#helper", { label: "recover()" })] },
    ],
    complete: true,
  };

  it("unwraps a try frame, splicing the try and catch bodies in order and dropping the finally marker", () => {
    const finallyMarker: Item = { t: "step", role: "marker", label: "finally" };
    const out = filterChartItems([tryFork, finallyMarker, effect("effects.net.connect")], opts);
    expect(labels(out)).toEqual(["call:helper()", "call:recover()", "effect:effects.net.connect"]);
  });

  it("drops a try whose try and catch bodies are all empty after filtering", () => {
    const out = filterChartItems([{ ...tryFork, arms: [{ label: "try", kind: "next", body: [effect("effects.fs.read")] }, { label: "catch", kind: "exception", body: [call()] }] }], opts);
    expect(out).toEqual([]);
  });

  it("prunes a branch whose arms are all empty after filtering", () => {
    const branch: Item = {
      t: "fork",
      role: "branch",
      label: "x > 0",
      arms: [
        { label: "then", kind: "true", body: [effect("effects.fs.write")] },
        { label: "else", kind: "false", body: [] },
      ],
      complete: false,
    };
    expect(filterChartItems([branch], opts)).toEqual([]);
  });

  it("prunes a loop whose body is empty after filtering", () => {
    const loop: Item = { t: "loop", label: "for", body: [call()] };
    expect(filterChartItems([loop], opts)).toEqual([]);
  });

  it("keeps a branch with a kept row in one arm, and keeps a lock frame even when empty", () => {
    const branch: Item = {
      t: "fork",
      role: "branch",
      label: "ok",
      arms: [
        { label: "then", kind: "true", body: [call("src/b.ts#helper")] },
        { label: "else", kind: "false", body: [] },
      ],
      complete: false,
    };
    const lock: Item = { t: "fork", role: "lock", label: "🔒 mu", lock: "mu", arms: [{ label: "", kind: "next", body: [] }], complete: true };
    expect(labels(filterChartItems([branch, lock], opts))).toEqual([
      "fork:branch",
      "arm:then",
      "call:f()",
      "arm:else",
      "fork:lock",
      "arm:",
    ]);
  });
});

describe("factsForFile and buildFileFlow with the inter-module focus", () => {
  const FILES: Record<string, string> = {
    "package.json": JSON.stringify({ name: "focus-sample", type: "module" }),
    "src/b.ts": `export function helper(n: number): number {
  return n + 1;
}
`,
    "src/a.ts": `import { readFileSync, writeFileSync } from "node:fs";
import { helper } from "./b";

function local(n: number): number {
  return n;
}

export function run(path: string): number {
  const text = readFileSync(path, "utf8");
  writeFileSync("out.txt", text);
  if (process.env.DEBUG) {
    helper(1);
  }
  try {
    helper(2);
  } catch (err) {
    helper(3);
  } finally {
    local(4);
  }
  return helper(5);
}
`,
  };
  let nodes: IRNode[];
  let edges: IREdge[];
  let index: ReturnType<typeof couplingIndex>;

  beforeAll(async () => {
    ({ nodes, edges } = await indexFixture(FILES));
    index = couplingIndex(nodes, edges);
  });

  it("calleeMapOf lists every function with its file and export flag", () => {
    const map = calleeMapOf(index);
    expect(map.get("src/b.ts#helper")).toEqual({ file: "src/b.ts", exported: true });
    expect(map.get("src/a.ts#local")).toEqual({ file: "src/a.ts", exported: false });
    expect(map.has("node:fs#readFileSync")).toBe(false);
  });

  it("calleeMapOf is built once per index and shared", () => {
    expect(calleeMapOf(index)).toBe(calleeMapOf(index));
    expect(calleeMapOf(couplingIndex(nodes, edges))).not.toBe(calleeMapOf(index));
  });

  it("draws only the inter-module calls of run, with the try frame unwrapped and no kernel or env effect", () => {
    const map = calleeMapOf(index);
    const flow = buildFileFlow("src/a.ts", nodes, edges, { focus: "intermodule", callees: map });
    const run = flow.functions.find((f) => f.name.endsWith("run") || f.id === "src/a.ts#run");
    expect(run).toBeDefined();
    const drawn = labels(factsForFile("src/a.ts", nodes, edges, { focus: "intermodule", callees: map }).find((f) => f.id === "src/a.ts#run")?.items ?? []);
    expect(drawn.some((l) => l.includes("readFile") || l.includes("writeFile") || l.includes("env"))).toBe(false);
    expect(drawn.some((l) => l.startsWith("fork:try"))).toBe(false);
    expect(drawn).not.toContain("marker:finally");
    expect(drawn.filter((l) => l.startsWith("call:") && l.includes("helper"))).toHaveLength(4);
    expect(drawn.some((l) => l.includes("local"))).toBe(false);
  });

  it("with no focus, buildFileFlow gives the same output as an explicit undefined focus, and keeps the kernel effects", () => {
    const plain = buildFileFlow("src/a.ts", nodes, edges);
    expect(buildFileFlow("src/a.ts", nodes, edges, { focus: undefined })).toEqual(plain);
    const plainRun = factsForFile("src/a.ts", nodes, edges).find((f) => f.id === "src/a.ts#run");
    expect(labels(plainRun?.items ?? []).some((l) => l.includes("fork:try"))).toBe(true);
    expect(labels(plainRun?.items ?? []).some((l) => l.includes("local"))).toBe(true);
    expect(plainRun?.items.some((i) => i.t === "step" && i.kind !== undefined)).toBe(false);
  });

  it("calleeMapFromNodes equals calleeMapOf on the same records, and is read once per node list", () => {
    const fromNodes = calleeMapFromNodes(nodes);
    expect(fromNodes).toEqual(calleeMapOf(index));
    expect(fromNodes.has("node:fs#readFileSync")).toBe(false);
    expect(calleeMapFromNodes(nodes)).toBe(fromNodes);
  });

  it("with the focus, each function keeps its coupling info from the unfiltered index, and its chart is the focused one", () => {
    const plain = buildFileFlow("src/a.ts", nodes, edges, { coupling: index });
    const focused = buildFileFlow("src/a.ts", nodes, edges, { coupling: index, focus: "intermodule" });
    expect(focused.functions.map((f) => f.id)).toEqual(plain.functions.map((f) => f.id));
    for (const f of focused.functions) {
      const p = plain.functions.find((x) => x.id === f.id);
      expect(f.coupling).toBeDefined();
      expect(p?.coupling).toBeDefined();
      const { chart, rows, ...info } = f.coupling!;
      const { chart: plainChart, rows: plainRows, ...plainInfo } = p!.coupling!;
      expect(info).toEqual(plainInfo);
      expect(chart.nodes).toEqual(f.nodes);
      expect(rows.coupling).toBe(f.nodes.length);
      expect(plainChart).toBeDefined();
      expect(plainRows).toBeDefined();
    }
    const run = focused.functions.find((f) => f.id === "src/a.ts#run");
    expect(run?.coupling?.summary).toBe(plain.functions.find((f) => f.id === "src/a.ts#run")?.coupling?.summary);
  });
});

describe("factsForFile with the inter-module focus: awaits from the IR", () => {
  it("draws no bare await for an awaited kernel read, nor for an awaited same-file call", async () => {
    const { nodes, edges } = await indexFixture({
      "package.json": JSON.stringify({ name: "focus-await", type: "module" }),
      "src/b.ts": `export async function helper(n: number): Promise<number> {\n  return n + 1;\n}\n`,
      "src/a.ts": `import { readFile } from "node:fs/promises";
import { helper } from "./b";

async function local(n: number): Promise<number> {
  return n;
}

export async function run(path: string): Promise<number> {
  await readFile(path);
  await local(1);
  return await helper(2);
}
`,
    });
    const index = couplingIndex(nodes, edges);
    const plain = factsForFile("src/a.ts", nodes, edges, { sources: true, state: index.state }).find((f) => f.id === "src/a.ts#run");
    expect(labels(plain?.items ?? []).filter((l) => l.startsWith("await:")).length).toBeGreaterThanOrEqual(3);
    const focused = factsForFile("src/a.ts", nodes, edges, { focus: "intermodule", callees: calleeMapOf(index), state: index.state }).find((f) => f.id === "src/a.ts#run");
    const drawn = labels(focused?.items ?? []);
    expect(drawn.filter((l) => l.startsWith("await:"))).toEqual(["await:await helper()"]);
    expect(drawn.some((l) => l.includes("fs.read"))).toBe(false);
  });
});

describe("execModel with the inter-module focus", () => {
  it("keeps threads, reach and stats identical, and draws each box no larger than the unfocused chart", async () => {
    const { nodes, edges } = await indexFixture({
      "package.json": JSON.stringify({ name: "focus-exec", type: "module" }),
      "src/b.ts": `export function helper(n: number): number {\n  return n + 1;\n}\n`,
      "src/a.ts": `import { readFileSync, writeFileSync } from "node:fs";
import { helper } from "./b";

export function run(path: string): number {
  const text = readFileSync(path, "utf8");
  writeFileSync("out.txt", text);
  writeFileSync("out2.txt", text);
  if (process.env.DEBUG) {
    helper(1);
  }
  return helper(5);
}
`,
    });
    const plain = execModel(nodes, edges, "src");
    const focused = execModel(nodes, edges, "src", { focus: "intermodule", callees: calleeMapOf(couplingIndex(nodes, edges)) });
    expect(focused.threads).toEqual(plain.threads);
    expect(focused.stats).toEqual(plain.stats);
    expect(focused.functions.map((f) => f.id)).toEqual(plain.functions.map((f) => f.id));
    const id = "src/a.ts#run";
    const size = (m: typeof plain) => {
      const chart = m.functions.find((f) => f.id === id)?.chart;
      return chart === undefined ? Infinity : chart[0] * chart[1];
    };
    expect(plain.functions.find((f) => f.id === id)?.chart).toBeDefined();
    expect(size(focused)).toBeLessThanOrEqual(size(plain));
    expect(size(focused)).toBeLessThan(size(plain));
    const direct = layoutFunction(factsForFile("src/a.ts", nodes, edges, { focus: "intermodule", callees: calleeMapOf(couplingIndex(nodes, edges)) }).find((f) => f.id === id)!);
    expect(focused.functions.find((f) => f.id === id)?.chart).toEqual([direct.width, direct.height]);
  });
});

describe("inter-module focus keeps state rows", () => {
  const FILES: Record<string, string> = {
    "package.json": JSON.stringify({ name: "focus-state", type: "module" }),
    "src/b.ts": `export function helper(n: number): number {
  return n + 1;
}
`,
    "src/a.ts": `import { helper } from "./b";

let total = 0;

export function run(n: number): number {
  total = total + n;
  return helper(total);
}
`,
  };

  it("draws a state row of a module variable that run reads and writes, under focus and without it", async () => {
    const { nodes, edges } = await indexFixture(FILES);
    const index = couplingIndex(nodes, edges);
    const map = calleeMapOf(index);
    const focused = factsForFile("src/a.ts", nodes, edges, { focus: "intermodule", callees: map, state: index.state }).find((f) => f.id === "src/a.ts#run");
    const drawn = labels(focused?.items ?? []);
    expect(drawn.some((l) => l.startsWith("state:") && l.includes("total"))).toBe(true);
    expect(drawn.some((l) => l.startsWith("call:") && l.includes("helper"))).toBe(true);
    const plain = labels(factsForFile("src/a.ts", nodes, edges, { state: index.state }).find((f) => f.id === "src/a.ts#run")?.items ?? []);
    expect(plain.some((l) => l.startsWith("state:") && l.includes("total"))).toBe(true);
  });

  it("buildFileFlow keeps the state rows of run when given the state index", async () => {
    const { nodes, edges } = await indexFixture(FILES);
    const index = couplingIndex(nodes, edges);
    const flow = buildFileFlow("src/a.ts", nodes, edges, { focus: "intermodule", callees: calleeMapOf(index), state: index.state });
    const run = flow.functions.find((f) => f.id === "src/a.ts#run");
    expect(run).toBeDefined();
    expect(JSON.stringify(run)).toContain("total");
  });
});
