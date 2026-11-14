import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type IRRecord, type IREdge, type IRNode, validateIR } from "@insight/ir";
import { createCoreRegistry } from "@insight/ir/node";
import { runFrontendConformance, type IRBatch, type ProjectRoot } from "@insight/sdk";
import frontend from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "fixtures");
const fixtureRoot = join(fixturesDir, "basic");
const goldenFile = join(here, "golden", "basic.ndjson");
const kindsFile = join(here, "..", "data", "kinds.json");
const files = readdirSync(fixtureRoot).filter((f) => /\.(sv|svh)$/.test(f)).sort();

const root: ProjectRoot = { path: fixtureRoot, name: "basic", allowBuildTools: false };
const readFile = async (rel: string) => readFileSync(join(fixtureRoot, rel), "utf8");

/** Real corpora are optional. Set the variable to a checkout to run the corpus checks. */
const IBEX = process.env.INSIGHT_SV_IBEX;
const CVA6 = process.env.INSIGHT_SV_CVA6;

function registry() {
  const reg = createCoreRegistry();
  reg.add(JSON.parse(readFileSync(kindsFile, "utf8")) as unknown[], "frontend-systemverilog");
  return reg;
}

/** Every Verilog or SystemVerilog file under a directory, relative to it, skipping vendor build trees. */
function sourcesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d)) {
      if (e === ".git" || e === "node_modules" || e === ".insight") continue;
      const full = join(d, e);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(sv|svh|v|vh)$/i.test(e)) out.push(relative(dir, full));
    }
  };
  walk(dir);
  return out.sort();
}

async function extractDir(dir: string, rels: string[]): Promise<IRBatch[]> {
  const batches: IRBatch[] = [];
  const ctx = {
    root: { path: dir, name: "x", allowBuildTools: false },
    files: rels,
    listFiles: () => [...rels],
    readFile: async (rel: string) => readFileSync(join(dir, rel), "utf8"),
    log: () => undefined,
  };
  for await (const batch of frontend.extract(ctx)) batches.push(batch);
  return batches;
}

const extractAll = (): Promise<IRBatch[]> => extractDir(fixtureRoot, files);
const allRecords = (batches: IRBatch[]): IRRecord[] => batches.flatMap((b) => b.records);

/** One sorted line per record, so the golden file diffs cleanly. */
function toGolden(batches: IRBatch[]): string {
  return allRecords(batches).map((r) => JSON.stringify(r)).sort().join("\n") + "\n";
}

const nodesOf = (records: IRRecord[]): IRNode[] => records.flatMap((r) => ("node" in r ? [r.node] : []));
const edgesOf = (records: IRRecord[]): IREdge[] => records.flatMap((r) => ("edge" in r ? [r.edge] : []));

/** Ids that more than one node carries. Must be empty. */
function duplicateIds(records: IRRecord[]): string[] {
  const seen = new Map<string, number>();
  for (const n of nodesOf(records)) seen.set(n.id, (seen.get(n.id) ?? 0) + 1);
  return [...seen].filter(([, c]) => c > 1).map(([id]) => id);
}

describe("frontend-systemverilog", () => {
  it("passes the SDK conformance kit", async () => {
    const report = await runFrontendConformance({ frontend, root, files, readFile, registry: registry() });
    const failed = report.checks.filter((c) => !c.ok);
    expect(failed).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("detects a project with Verilog or SystemVerilog sources", async () => {
    expect(await frontend.detect(root)).not.toBeNull();
    expect(await frontend.detect({ path: join(here, "..", "data"), name: "x", allowBuildTools: false })).toBeNull();
  });

  it("emits the structure, instances, imports, flow, calls and effects the fixture holds", async () => {
    const records = allRecords(await extractAll());
    const nodes = nodesOf(records);
    const edges = edgesOf(records);
    const kinds = (k: string) => nodes.filter((n) => n.kind === k);

    expect(kinds("structure.type").map((n) => n.attrs.name)).toEqual(expect.arrayContaining(["alu", "top"]));
    expect(kinds("structure.module").map((n) => n.attrs.name)).toEqual(expect.arrayContaining(["pkg", "dv_pkg"]));
    expect(kinds("structure.function").map((n) => n.id)).toEqual(
      expect.arrayContaining(["pkg.sv#pkg.saturate_add", "top.sv#top.report", "alu.sv#alu.always_comb#1", "top.sv#top.always_ff#1", "top.sv#top.g_lanes.always_ff#2"]),
    );
    expect(kinds("structure.function").find((n) => n.id === "top.sv#top.always_ff#1")?.attrs.clock).toBe("clk");

    const instances = kinds("x-sv.instance").map((n) => [n.attrs.name, n.attrs.module, n.attrs.generate ?? ""]);
    expect(instances).toEqual(
      expect.arrayContaining([
        ["u_alu", "alu", ""],
        ["u_lane_alu", "alu", "g_lanes"],
      ]),
    );
    const inst = edges.filter((e) => e.kind === "x-sv.instantiates");
    expect(inst.some((e) => e.from === "top.sv#top" && e.to === "alu.sv#alu" && e.attrs?.instance === "u_alu")).toBe(true);

    expect(edges.some((e) => e.kind === "packaging.import" && e.from === "top.sv#top" && e.to === "pkg.sv#pkg")).toBe(true);
    expect(
      edges.some((e) => e.kind === "packaging.include" && e.from === "top.sv" && typeof e.to === "object" && "unresolved" in e.to && e.to.unresolved.text === "defs.svh"),
    ).toBe(true);

    expect(kinds("flow.switch").map((n) => n.attrs.hasDefault)).toEqual(expect.arrayContaining([true]));
    expect(kinds("flow.branch").map((n) => n.attrs.condition)).toEqual(expect.arrayContaining(["!rst_n", "alu_zero"]));
    expect(kinds("effects.fs.read").map((n) => [n.attrs.api, n.attrs.path])).toEqual(expect.arrayContaining([["$readmemh", "init.hex"]]));

    const calls = edges.filter((e) => e.kind === "calls.call");
    expect(calls.some((e) => e.from === "alu.sv#alu.always_comb#1" && e.to === "pkg.sv#pkg.saturate_add" && e.attrs?.callee === "pkg::saturate_add")).toBe(true);
  });

  it("matches the golden IR for the fixture project", async () => {
    const actual = toGolden(await extractAll());
    if (process.env.UPDATE_GOLDEN === "1") writeFileSync(goldenFile, actual);
    expect(actual).toBe(readFileSync(goldenFile, "utf8"));
  });

  it("produces IR that validates, with no duplicate node ids", async () => {
    const text = toGolden(await extractAll());
    const report = validateIR(text, registry(), { closed: false });
    expect(report.errors).toEqual([]);
    expect(duplicateIds(allRecords(await extractAll()))).toEqual([]);
  });
});

describe("review fixes", () => {
  const facts = async () => {
    const records = allRecords(await extractAll());
    return { records, nodes: nodesOf(records), edges: edgesOf(records) };
  };

  it("fix 1: labelled begin blocks name their process", async () => {
    const { nodes } = await facts();
    const ids = nodes.filter((n) => n.attrs.hdl === "process").map((n) => n.attrs.name);
    expect(ids).toEqual(expect.arrayContaining(["rtl_nonansi.boot", "rtl_nonansi.seq_proc", "rtl_nonansi.comb_blk"]));
  });

  it("fix 2: super.m() resolves to the base class, this.m() to the own class", async () => {
    const { edges } = await facts();
    const sup = edges.filter((e) => e.kind === "calls.call" && e.attrs?.callee === "super.log");
    expect(sup).toHaveLength(1);
    expect(sup[0]?.to).toBe("dv_pkg.sv#dv_base.log");
    const self = edges.filter((e) => e.kind === "calls.call" && e.attrs?.callee === "this.step");
    expect(self[0]?.to).toBe("dv_env.sv#dv_child.step");
    // A super call must never land on the caller's own method of the same name.
    expect(edges.some((e) => e.kind === "calls.call" && e.attrs?.callee === "super.log" && e.to === "dv_env.sv#dv_child.log")).toBe(false);
  });

  it("fix 3: constructors are functions named Class.new, and out-of-class definitions are scoped to their class", async () => {
    const { nodes, edges } = await facts();
    const ctor = nodes.find((n) => n.id === "dv_env.sv#dv_child.new");
    expect(ctor?.kind).toBe("structure.function");
    expect(ctor?.attrs.hdl).toBe("function");
    expect(ctor?.parent).toBe("dv_env.sv#dv_child");
    expect(nodes.find((n) => n.id === "dv_env.sv#dv_child.step")?.attrs.name).toBe("dv_child.step");
    expect(nodes.find((n) => n.id === "dv_env.sv#other_c.run")?.attrs.name).toBe("other_c.run");
    expect(nodes.find((n) => n.id === "dv_env.sv#dv_child.run")).toBeDefined();
    // The extern prototypes did not add a second node.
    expect(nodes.filter((n) => n.attrs.name === "other_c.run")).toHaveLength(1);
    expect(edges).toBeDefined();
  });

  it("fix 4: functions in generate branches get the generate path, and same-named ones never share an id", async () => {
    const { nodes } = await facts();
    const g1 = nodes.find((n) => n.id === "rtl2.sv#rtl_nonansi.g1.pick");
    const g2 = nodes.find((n) => n.id === "rtl2.sv#rtl_nonansi.g2.pick");
    expect(g1?.attrs.name).toBe("rtl_nonansi.g1.pick");
    expect(g2?.attrs.name).toBe("rtl_nonansi.g2.pick");
    // Same name, no labels: the second one gets the deterministic suffix, not a line number.
    expect(nodes.some((n) => n.id === "rtl2.sv#rtl_nonansi.h")).toBe(true);
    expect(nodes.some((n) => n.id === "rtl2.sv#rtl_nonansi.h~2")).toBe(true);
    expect(duplicateIds((await facts()).records)).toEqual([]);
  });

  it("fix 5: calls outside processes are attributed to the module, not dropped", async () => {
    const { edges } = await facts();
    const assignCall = edges.find((e) => e.kind === "calls.call" && e.attrs?.callee === "f");
    expect(assignCall?.from).toBe("rtl2.sv#rtl_nonansi");
    expect(assignCall?.to).toBe("rtl2.sv#rtl_nonansi.f");
    expect(edges.some((e) => e.kind === "calls.call" && e.from === "rtl2.sv#rtl_nonansi" && e.attrs?.callee === "pick")).toBe(true);
  });

  it("fix 6: inherited, typed-handle and DPI calls resolve; the handle of an unknown type stays unresolved", async () => {
    const { nodes, edges } = await facts();
    // Unqualified call through two extends levels: dv_grand -> dv_child -> dv_base.
    expect(edges.find((e) => e.kind === "calls.call" && e.from === "dv_env.sv#dv_grand.go")?.to).toBe("dv_pkg.sv#dv_base.log");
    // Unqualified inherited task.
    expect(edges.find((e) => e.kind === "calls.call" && e.from === "dv_env.sv#dv_child.run" && e.attrs?.callee === "wait_clks")?.to).toBe("dv_pkg.sv#dv_base.wait_clks");
    // Typed handle: vif is a virtual bus_if, so the interface task.
    expect(edges.find((e) => e.kind === "calls.call" && e.attrs?.callee === "vif.wait_clks")?.to).toBe("bus_if.sv#bus_if.wait_clks");
    // bi_t is not in the project.
    const bi = edges.find((e) => e.kind === "calls.call" && e.attrs?.callee === "bi.send");
    expect(bi?.to).toEqual({ unresolved: { scheme: "sv.call", text: "bi.send" } });
    // DPI import: a function node with an effects.unknown child, and the call resolves to it.
    const dpi = nodes.find((n) => n.id === "dv_pkg.sv#dv_pkg.c_add");
    expect(dpi?.attrs.dpi).toBe(true);
    expect(nodes.find((n) => n.id === "dv_pkg.sv#dv_pkg.c_add/dpi")).toMatchObject({ kind: "effects.unknown", parent: "dv_pkg.sv#dv_pkg.c_add" });
    expect(edges.find((e) => e.kind === "calls.call" && e.attrs?.callee === "c_add")?.to).toBe("dv_pkg.sv#dv_pkg.c_add");
  });

  it("fix 4b: two files with identical byte offsets keep their own module ids", async () => {
    const col = await extractDir(join(fixturesDir, "collide"), ["p1.sv", "p2.sv"]);
    const nodes = nodesOf(allRecords(col));
    expect(nodes.find((n) => n.id === "p1.sv#alpha")?.parent).toBe("p1.sv");
    expect(nodes.find((n) => n.id === "p2.sv#bravo")?.parent).toBe("p2.sv");
    expect(duplicateIds(allRecords(col))).toEqual([]);
  });

  it("fix 6: an instantiated module defined twice is a candidate set, not an exact match", async () => {
    const amb = await extractDir(join(fixturesDir, "ambiguous"), ["gate_a.sv", "gate_b.sv", "top_amb.sv"]);
    const edges = edgesOf(allRecords(amb));
    const inst = edges.find((e) => e.kind === "x-sv.instantiates" && e.attrs?.instance === "u_g");
    expect(inst?.to).toEqual({ candidates: ["gate_a.sv#prim_gate", "gate_b.sv#prim_gate"] });
    expect(inst?.provenance?.confidence).toBe("heuristic");
  });

  it("fix 7: a header the grammar cannot parse still defines its module, with a heuristic line span", async () => {
    const { nodes } = await facts();
    const m = nodes.find((n) => n.id === "unparsed_hdr.sv#prim_alert_sender");
    expect(m?.kind).toBe("structure.type");
    expect(m?.provenance?.confidence).toBe("heuristic");
    expect(m?.span?.start[0]).toBe(0);
    expect(m?.span?.end[1]).toBe("module prim_alert_sender".length);
  });

  it("fix 7: a deliberate parse error still produces the finding", async () => {
    const { records } = await facts();
    const findings = records.flatMap((r) => ("finding" in r ? [r.finding] : []));
    expect(findings.some((f) => f.span?.file === "syntax_err.sv")).toBe(true);
  });

  it("fix 8: non-ANSI port directions, interface ports without a direction, and typed parameters", async () => {
    const { nodes, edges } = await facts();
    const nonansi = nodes.find((n) => n.id === "rtl2.sv#rtl_nonansi")?.attrs.ports;
    expect(nonansi).toEqual([
      { name: "a", dir: "input" },
      { name: "b", dir: "output" },
      { name: "c", dir: "input" },
    ]);
    const ansi = nodes.find((n) => n.id === "rtl2.sv#ansi_if")?.attrs;
    expect(ansi?.ports).toEqual([
      { name: "a", dir: "input" },
      { name: "b", dir: "interface" },
      { name: "y", dir: "output" },
    ]);
    expect(ansi?.params).toEqual(["T"]);
    // $fopen(f, "r") reads; $fopen(f, "w") and $fopen(f) (no mode, multichannel) write; $fclose has no effect.
    const fs = nodes.filter((n) => n.kind.startsWith("effects.fs"));
    expect(fs.find((n) => n.attrs.path === "cfg.txt")?.kind).toBe("effects.fs.read");
    expect(fs.find((n) => n.attrs.path === "out.log")?.kind).toBe("effects.fs.write");
    expect(fs.find((n) => n.attrs.path === "multi.log")?.kind).toBe("effects.fs.write");
    expect(fs.some((n) => n.attrs.api === "$fclose")).toBe(false);
    // Method calls on objects are named with a dot in the unresolved text.
    expect(edges.some((e) => e.kind === "calls.call" && JSON.stringify(e.to).includes("bi::send"))).toBe(false);
    // Process ordinals count the module's own processes: the second unlabelled initial is initial#2.
    expect(nodes.some((n) => n.id === "rtl2.sv#rtl_nonansi.initial#2")).toBe(true);
    // disable and break become flow.jump; the disable keeps its target.
    const jumps = nodes.filter((n) => n.kind === "flow.jump");
    expect(jumps.some((n) => n.attrs.variant === "break" && n.attrs.label === "blk_x")).toBe(true);
    expect(jumps.some((n) => n.attrs.variant === "break" && n.parent === "rtl2.sv#rtl_nonansi.comb_blk")).toBe(true);
  });
});

/** Walks the whole corpus through the frontend and returns the records. Used by the corpus checks. */
async function corpusRecords(dir: string) {
  const rels = sourcesUnder(dir);
  return allRecords(await extractDir(dir, rels));
}

describe.skipIf(!IBEX)("ibex corpus (INSIGHT_SV_IBEX)", () => {
  it("has no duplicate node ids and validates", async () => {
    const records = await corpusRecords(IBEX as string);
    expect(duplicateIds(records)).toEqual([]);
    const text = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
    expect(validateIR(text, registry(), { closed: false }).errors).toEqual([]);
  }, 300_000);
});

describe.skipIf(!CVA6)("cva6 corpus (INSIGHT_SV_CVA6)", () => {
  it("has no duplicate node ids", async () => {
    const records = await corpusRecords(CVA6 as string);
    expect(duplicateIds(records)).toEqual([]);
  }, 300_000);
});

describe("corpus guard", () => {
  it("reads the corpus variables only when they name a directory", () => {
    for (const v of [IBEX, CVA6]) if (v !== undefined) expect(existsSync(v)).toBe(true);
  });
});
