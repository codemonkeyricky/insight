import { beforeAll, describe, expect, it } from "vitest";
import type { IREdge, IRNode } from "@insight/ir";
import { couplingChart, couplingFacts, footprintSummary, layoutFunction, unfold, unfoldChart, type CouplingFootprint, type FootprintEntry, type FunctionFlow, type Item, type ModuleMap } from "../src/index.js";
import type { FunctionFacts } from "../src/build.js";
import { indexFixture } from "./coupling-fixture.js";

const PKGS_FILES: Record<string, string> = {
  "package.json": JSON.stringify({ name: "root", private: true }),
  "pkgs/a/package.json": JSON.stringify({ name: "a" }),
  "pkgs/b/package.json": JSON.stringify({ name: "b" }),
  // a: local -> local -> fs write, all in one module
  "pkgs/a/src/chain.ts": `import { writeFileSync } from "node:fs";
export function sink(p: string): void {
  writeFileSync(p, "x");
}
export function mid(p: string): void {
  sink(p);
}
export function top(): void {
  mid("o.txt");
}
`,
  // b: a chain with nothing outside the module
  "pkgs/a/src/pure.ts": `export function leaf(n: number): number {
  return n + 1;
}
export function chain(n: number): number {
  return leaf(n) * 2;
}
`,
  // c: the package's own exported function, called from another file of the package
  "pkgs/a/src/other.ts": `import { leaf } from "./pure.js";
export function viaOther(n: number): number {
  return leaf(n);
}
`,
  // d, h: calls into package b, one of which throws
  "pkgs/a/src/use.ts": `import { fetchLabel, risky } from "../../b/src/lib.js";
export function useB(): string {
  return fetchLabel("k");
}
export function callsRisky(): number {
  return risky();
}
`,
  "pkgs/b/src/lib.ts": `export function fetchLabel(k: string): string {
  return k + "!";
}
export function risky(): number {
  throw new Error("risky");
}
`,
  // e: a branch whose body is local only
  "pkgs/a/src/branch.ts": `import { leaf } from "./pure.js";
export function branchy(n: number): number {
  if (n > 0) {
    return leaf(n);
  }
  return 0;
}
`,
  // f: escapes
  "pkgs/a/src/throws.ts": `import { leaf } from "./pure.js";
export function boom(): void {
  throw new Error("x");
}
export function guarded(): void {
  try {
    throw new Error("y");
  } catch (e) {
    return;
  }
}
export function rethrow(): void {
  try {
    leaf(1);
  } catch (e) {
    throw e;
  }
}
`,
  // g: a local helper that throws, called outside and inside a try
  "pkgs/a/src/helper.ts": `function fail(): void {
  throw new Error("f");
}
export function outside(): void {
  fail();
}
export function inside(): void {
  try {
    fail();
  } catch (e) {
    return;
  }
}
`,
  // i: a recursive same-module pair
  "pkgs/a/src/rec.ts": `export function ping(n: number): number {
  if (n > 0) {
    return pong(n - 1);
  }
  return 0;
}
export function pong(n: number): number {
  if (n > 0) {
    return ping(n - 1);
  }
  return 0;
}
`,
};

// j: no package.json anywhere
const GENERIC_FILES: Record<string, string> = {
  "src/a.ts": `import { helper } from "../lib/b.js";
export function go(): number {
  return helper();
}
`,
  "lib/b.ts": `export function helper(): number {
  return 1;
}
`,
};

interface Indexed {
  modules: ModuleMap;
  facts: Map<string, FunctionFacts>;
  footprints: Map<string, CouplingFootprint>;
}

async function load(files: Record<string, string>): Promise<Indexed & { nodes: IRNode[]; edges: IREdge[] }> {
  const { nodes, edges } = await indexFixture(files);
  return { nodes, edges, ...couplingFacts(nodes, edges) };
}

let pkgs: Indexed & { nodes: IRNode[]; edges: IREdge[] };
let generic: Indexed & { nodes: IRNode[]; edges: IREdge[] };

beforeAll(async () => {
  pkgs = await load(PKGS_FILES);
  generic = await load(GENERIC_FILES);
});

/** The chart of one function, coupling-pruned, with its facts. */
function chartOf(ix: Indexed, id: string) {
  const f = ix.facts.get(id);
  if (!f) throw new Error(`no function ${id}; have ${[...ix.facts.keys()].join(", ")}`);
  return couplingChart(id, f.items, ix.modules, ix.footprints);
}

const fid = (file: string, name: string) => `${file}#${name}`;
type Step = Extract<Item, { t: "step" }>;
const kept = (items: Item[]) => items.filter((i) => !(i.t === "step" && i.foldId !== undefined));
const isFoldOnly = (items: Item[]) => items.length > 0 && items.every((i) => i.t === "step" && i.foldId !== undefined);

describe("coupling pass over a package fixture", () => {
  it("(a) a local chain ending in an fs write keeps its first call, hoisting the write", () => {
    const { items, info } = chartOf(pkgs, fid("pkgs/a/src/chain.ts", "top"));
    const rows = kept(items);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row).toMatchObject({ t: "step", role: "call", coupling: "io" });
    if (row?.t !== "step") throw new Error("expected a step");
    expect(row.hoisted).toContain("fs.write");
    expect(row.title).toContain("⇢");
    expect(row.title).toContain("fs.write");
    expect(row.label).toContain(" ⇢ ");
    expect(row.label).toContain("fs.write");
    expect(info.summary).toContain("fs 1");
    expect(info.footprint.modules).toEqual([]);
  });

  it("(b) a local chain with nothing outside the module folds into a single row", () => {
    const { items, info } = chartOf(pkgs, fid("pkgs/a/src/pure.ts", "chain"));
    expect(items).toHaveLength(1);
    expect(isFoldOnly(items)).toBe(true);
    expect(info.summary).toBe("no coupling");
  });

  it("(c) a call to the package's own exported function in another file is dropped", () => {
    const modules = pkgs.modules;
    expect(modules.moduleOf(fid("pkgs/a/src/other.ts", "viaOther"))).toBe(modules.moduleOf(fid("pkgs/a/src/pure.ts", "leaf")));
    const { items } = chartOf(pkgs, fid("pkgs/a/src/other.ts", "viaOther"));
    expect(isFoldOnly(items)).toBe(true);
  });

  it("(d) a call from package a into package b is kept as cross and names b in its footprint", () => {
    const { items, info } = chartOf(pkgs, fid("pkgs/a/src/use.ts", "useB"));
    const rows = kept(items);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ t: "step", role: "call", coupling: "cross" });
    expect(info.footprint.modules).toEqual(["pkgs/b"]);
    expect(info.summary).toContain("⇄ 1 module");
  });

  it("(e) a branch whose body is local only is folded away", () => {
    const { items } = chartOf(pkgs, fid("pkgs/a/src/branch.ts", "branchy"));
    expect(items.some((i) => i.t === "fork")).toBe(false);
    expect(isFoldOnly(items)).toBe(true);
  });

  it("(f) an uncaught throw is escape, a throw inside try/catch is dropped, a rethrow from catch is escape", () => {
    const boom = chartOf(pkgs, fid("pkgs/a/src/throws.ts", "boom"));
    const throwRow = boom.items.find((i) => i.t === "term");
    expect(throwRow).toMatchObject({ t: "term", role: "throw", coupling: "escape" });
    expect(boom.info.footprint.escape).toBe(true);
    expect(boom.info.summary).toContain("throws ↑");

    const guarded = chartOf(pkgs, fid("pkgs/a/src/throws.ts", "guarded"));
    expect(isFoldOnly(guarded.items)).toBe(true);
    expect(guarded.info.footprint.escape).toBe(false);

    const rethrow = chartOf(pkgs, fid("pkgs/a/src/throws.ts", "rethrow"));
    const fork = rethrow.items.find((i) => i.t === "fork");
    if (fork?.t !== "fork") throw new Error("expected the try to stay, for its rethrow");
    const catchArm = fork.arms.find((a) => a.kind === "exception");
    expect(catchArm?.body[0]).toMatchObject({ t: "term", role: "throw", coupling: "escape" });
    expect(rethrow.info.footprint.escape).toBe(true);
  });

  it("(g) a local helper that throws is hoisted as throws outside a try, and dropped inside one", () => {
    const outside = chartOf(pkgs, fid("pkgs/a/src/helper.ts", "outside"));
    const rows = kept(outside.items);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ t: "step", role: "call", coupling: "escape", hoisted: "throws" });
    if (rows[0]?.t === "step") expect(rows[0].title).toContain("⇢ throws");
    expect(outside.info.footprint.escape).toBe(true);

    const inside = chartOf(pkgs, fid("pkgs/a/src/helper.ts", "inside"));
    expect(isFoldOnly(inside.items)).toBe(true);
    expect(inside.info.footprint.escape).toBe(false);
  });

  it("(h) a cross callee that may throw is hoisted as may throw", () => {
    const { items, info } = chartOf(pkgs, fid("pkgs/a/src/use.ts", "callsRisky"));
    const rows = kept(items);
    expect(rows[0]).toMatchObject({ t: "step", role: "call", coupling: "cross", hoisted: "may throw" });
    expect(info.footprint.escape).toBe(true);
  });

  it("(i) a recursive same-module pair terminates and is dropped", () => {
    const ping = chartOf(pkgs, fid("pkgs/a/src/rec.ts", "ping"));
    expect(isFoldOnly(ping.items)).toBe(true);
    const pong = chartOf(pkgs, fid("pkgs/a/src/rec.ts", "pong"));
    expect(isFoldOnly(pong.items)).toBe(true);
  });

  it("(k) every cross, io, conc and escape row is kept, and unfolding restores the original rows", () => {
    for (const ix of [pkgs, generic]) {
      for (const [id, f] of ix.facts) {
        const moduleOf = ix.modules.moduleOf(id);
        const coupled = couplingChart(id, f.items, ix.modules, ix.footprints).items;
        const keptSpans = new Set<string>();
        const collectKept = (list: Item[]) => {
          for (const i of list) {
            if (i.t === "step" && i.foldId !== undefined) continue;
            if (i.span) keptSpans.add(JSON.stringify(i.span));
            if (i.t === "fork") for (const a of i.arms) collectKept(a.body);
            if (i.t === "loop") collectKept(i.body);
          }
        };
        collectKept(coupled);
        const mustKeep = (list: Item[]): string[] =>
          list.flatMap((i): string[] => {
            if (i.t === "step") {
              const targets = i.targets ?? (i.target ? [i.target] : []);
              const cross = targets.some((t) => {
                const m = ix.modules.moduleOf(t);
                return m !== undefined && m !== moduleOf;
              });
              const must = i.role === "effect" || i.role === "spawn" || i.role === "await" || (i.role === "call" && cross);
              return must && i.span ? [JSON.stringify(i.span)] : [];
            }
            if (i.t === "fork") return i.arms.flatMap((a) => mustKeep(a.body));
            if (i.t === "loop") return mustKeep(i.body);
            return [];
          });
        for (const span of mustKeep(f.items)) expect(keptSpans.has(span), `${id} keeps ${span}`).toBe(true);

        let cur = coupled;
        for (let guard = 0; guard < 100; guard++) {
          const ids = new Set<string>();
          const gather = (list: Item[]) => {
            for (const i of list) {
              if (i.t === "step" && i.foldId !== undefined && i.open !== true) ids.add(i.foldId);
              if (i.t === "fork") for (const a of i.arms) gather(a.body);
              if (i.t === "loop") gather(i.body);
            }
          };
          gather(cur);
          if (ids.size === 0) break;
          cur = unfold(cur, ids);
        }
        expect(flat(cur), id).toEqual(flat(f.items));
      }
    }
  });
});

/** The sequence of rows of a chart, with their roles, labels and spans; nested rows follow their parent. */
function flat(items: readonly Item[]): string[] {
  return items.flatMap((i): string[] => {
    // An open fold's header is not a row of the original chart.
    if (i.t === "step" && i.open === true) return [];
    // The hoisted suffix (` ⇢ fs.write`) is the coupling view's, not the original row's: compare the label before it.
    if (i.t === "step") return [`step:${i.role}:${i.label.split(" ⇢ ")[0]}:${JSON.stringify(i.span ?? null)}`];
    if (i.t === "term") return [`term:${i.role}:${JSON.stringify(i.span ?? null)}`];
    if (i.t === "fork") return [`fork:${i.role}:${JSON.stringify(i.span ?? null)}`, ...i.arms.flatMap((a) => [`arm:${a.label}`, ...flat(a.body)])];
    return [`loop:${JSON.stringify(i.span ?? null)}`, ...flat(i.body)];
  });
}

describe("coupling pass with no package metadata", () => {
  it("(j) top-level folders are the modules, so a call between them is cross", () => {
    expect(generic.modules.generic).toBe(true);
    expect(generic.modules.moduleOfFile("src/a.ts")).toBe("src");
    expect(generic.modules.moduleOfFile("lib/b.ts")).toBe("lib");
    const { items, info } = chartOf(generic, fid("src/a.ts", "go"));
    const rows = kept(items);
    expect(rows[0]).toMatchObject({ t: "step", role: "call", coupling: "cross" });
    expect(info.footprint.modules).toEqual(["lib"]);
  });
});

describe("footprintSummary", () => {
  const entry = (e: FootprintEntry) => e;
  it("formats modules, io counts by kind, concurrency and throws", () => {
    const fp: CouplingFootprint = {
      entries: [
        entry({ cls: "cross", label: "x()", target: "t", module: "pkgs/b" }),
        entry({ cls: "io", label: "w", kind: "effects.fs.write" }),
        entry({ cls: "io", label: "r", kind: "effects.fs.read" }),
        entry({ cls: "io", label: "n", kind: "effects.net.connect" }),
        entry({ cls: "conc", label: "await" }),
        entry({ cls: "escape", label: "throws" }),
      ],
      modules: ["pkgs/b"],
      escape: true,
    };
    expect(footprintSummary(fp)).toBe("⇄ 1 module · fs 2 · net 1 · conc 1 · throws ↑");
  });

  it("pluralises modules and says so when there is nothing", () => {
    const two: CouplingFootprint = { entries: [], modules: ["a", "b"], escape: false };
    expect(footprintSummary(two)).toBe("⇄ 2 modules");
    expect(footprintSummary({ entries: [], modules: [], escape: false })).toBe("no coupling");
  });
});

describe("unfoldChart", () => {
  /** The laid-out coupling chart of one function, with its coupling (as the file flow serves it). */
  function flowOf(ix: Indexed, id: string): FunctionFlow {
    const f = ix.facts.get(id);
    if (!f) throw new Error(`no function ${id}`);
    const { items, info } = couplingChart(id, f.items, ix.modules, ix.footprints);
    const chart = layoutFunction({ id, name: f.name, async: f.async, ...(f.span ? { span: f.span } : {}), items });
    return { ...chart, coupling: { ...info, chart, rows: { all: 0, coupling: chart.nodes.length } } };
  }

  it("opening a fold replaces it with its rows and keeps the coupling", () => {
    const id = fid("pkgs/a/src/pure.ts", "chain");
    const folded = flowOf(pkgs, id);
    const foldId = folded.items?.find((i) => i.t === "step" && i.foldId !== undefined);
    if (foldId?.t !== "step" || foldId.foldId === undefined) throw new Error("expected a fold row");
    const open = unfoldChart(folded, new Set([foldId.foldId]));
    // The only fold row left is the open header, which folds the rows back.
    expect(open.nodes.filter((n) => n.foldId !== undefined).map((n) => n.open)).toEqual([true]);
    expect(open.nodes.length).toBeGreaterThanOrEqual(folded.nodes.length);
    expect(open.coupling).toBe(folded.coupling);
    expect(unfoldChart(folded, new Set()).nodes).toEqual(folded.nodes);
  });

  it("an open fold emits its header row first, then the rows it folds", () => {
    const items: Item[] = [
      { t: "step", role: "call", label: "db.save()", target: "db#save" },
      { t: "step", role: "marker", label: "⋯ 2 local", foldId: "F1", fold: [{ t: "step", role: "call", label: "a()" }, { t: "step", role: "call", label: "b()" }] },
    ];
    const open = unfold(items, new Set(["F1"]));
    expect(open[1]).toMatchObject({ t: "step", role: "marker", label: "▾ 2 local", foldId: "F1", open: true });
    expect(open.slice(2).map((i) => (i.t === "step" ? i.label : ""))).toEqual(["a()", "b()"]);
    expect(unfold(items, new Set())).toEqual(items);
  });

  it("an open header's fold stays closed to a second unfold, so the rows are not expanded twice", () => {
    const items: Item[] = [{ t: "step", role: "marker", label: "⋯ 1 local", foldId: "F1", fold: [{ t: "step", role: "call", label: "a()" }] }];
    const once = unfold(items, new Set(["F1"]));
    expect(unfold(once, new Set(["F1"]))).toEqual(once);
  });

  it("returns a flow with no items as it is", () => {
    const bare: FunctionFlow = { id: "x", name: "x", async: false, stats: { steps: 0, decisions: 0, loops: 0, tries: 0, exits: 0, depth: 0 }, width: 0, height: 0, nodes: [], edges: [], tooLarge: true };
    expect(unfoldChart(bare, new Set(["f0"]))).toBe(bare);
  });
});

/** Indexes a fixture and gives every function's coupling chart and footprint, as the file flow does. */
async function couplingOf(files: Record<string, string>) {
  const { nodes, edges } = await indexFixture(files);
  const { modules, facts, footprints } = couplingFacts(nodes, edges);
  return { modules, facts, footprints };
}

describe("await hoisting", () => {
  const FILES: Record<string, string> = {
    "package.json": JSON.stringify({ name: "root", private: true }),
    "pkgs/a/package.json": JSON.stringify({ name: "a" }),
    "pkgs/a/src/io.ts": `import { writeFileSync } from "node:fs";
export async function save(): Promise<void> {
  writeFileSync("out.txt", "x");
  throw new Error("save");
}
export async function run(): Promise<void> {
  await save();
}
`,
  };
  let ix: Awaited<ReturnType<typeof couplingOf>>;
  beforeAll(async () => {
    ix = await couplingOf(FILES);
  });

  it("hoists a same-module callee's io and throws onto the await row, and the footprint has io, conc and escape", () => {
    const id = fid("pkgs/a/src/io.ts", "run");
    const f = ix.facts.get(id);
    if (!f) throw new Error(`no function ${id}`);
    const { items, info } = couplingChart(id, f.items, ix.modules, ix.footprints);
    const await_ = kept(items).find((i): i is Step => i.t === "step" && i.role === "await");
    if (!await_) throw new Error("expected an await row");
    // io outranks conc under ORDER, so the row takes io; the footprint entry for the await itself stays conc.
    expect(await_.coupling).toBe("io");
    expect(await_.hoisted).toMatch(/throws/);
    expect(await_.hoisted).toMatch(/fs|write|save/);
    expect(await_.title).toContain(" ⇢ ");
    const classes = new Set(info.footprint.entries.map((e) => e.cls));
    expect(classes).toEqual(new Set(["io", "conc", "escape"]));
    expect(info.footprint.entries.find((e) => e.cls === "conc")?.label).toMatch(/^await/);
  });
});

describe("footprint cap", () => {
  const FILES: Record<string, string> = {
    "package.json": JSON.stringify({ name: "root", private: true }),
    "pkgs/a/package.json": JSON.stringify({ name: "a" }),
    "pkgs/b/package.json": JSON.stringify({ name: "b" }),
    "pkgs/b/src/many.ts": Array.from({ length: 55 }, (_, k) => `export function f${k}(): number {\n  return ${k};\n}\n`).join(""),
    "pkgs/a/src/fan.ts": `import { ${Array.from({ length: 55 }, (_, k) => `f${k}`).join(", ")} } from "../../b/src/many.js";
export function fan(): void {
${Array.from({ length: 55 }, (_, k) => `  f${k}();`).join("\n")}
  throw new Error("fan");
}
`,
  };
  let ix: Awaited<ReturnType<typeof couplingOf>>;
  beforeAll(async () => {
    ix = await couplingOf(FILES);
  });

  it("keeps escape and the module past the entry cap", () => {
    const id = fid("pkgs/a/src/fan.ts", "fan");
    const fp = ix.footprints.get(id);
    if (!fp) throw new Error(`no footprint for ${id}`);
    expect(fp.entries.length).toBeLessThanOrEqual(50);
    expect(fp.escape).toBe(true);
    expect(fp.modules).toEqual(["pkgs/b"]);
    expect(footprintSummary(fp)).toContain("throws ↑");
    expect(footprintSummary(fp)).toContain("⇄ 1 module");
  });
});
