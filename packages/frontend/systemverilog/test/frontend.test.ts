import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type IRRecord, type IREdge, type IRNode, validateIR } from "@insight/ir";
import { createCoreRegistry } from "@insight/ir/node";
import { runFrontendConformance, type IRBatch, type ProjectRoot } from "@insight/sdk";
import frontend, { extractFiles } from "../src/index.js";
import { buildProject, indexStats, releaseProject } from "../src/project.js";

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
      // lstat, not stat: a broken symlink has no target, and symlinks are not followed.
      const st = lstatSync(full);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) walk(full);
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
      expect.arrayContaining(["pkg.sv#pkg.saturate_add", "top.sv#top.report", "alu.sv#alu.always_comb[1]", "top.sv#top.always_ff[1]", "top.sv#top.g_lanes.always_ff[1]"]),
    );
    expect(kinds("structure.function").find((n) => n.id === "top.sv#top.always_ff[1]")?.attrs.clock).toBe("clk");

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
    expect(calls.some((e) => e.from === "alu.sv#alu.always_comb[1]" && e.to === "pkg.sv#pkg.saturate_add" && e.attrs?.callee === "pkg::saturate_add")).toBe(true);
  });

  it("detects a source file five directories down, and ignores one only under node_modules", async () => {
    const deep = mkdtempSync(join(tmpdir(), "sv-detect-"));
    mkdirSync(join(deep, "a", "b", "c", "d", "e"), { recursive: true });
    writeFileSync(join(deep, "a", "b", "c", "d", "e", "x.sv"), "module x;\nendmodule\n");
    expect(await frontend.detect({ path: deep, name: "deep", allowBuildTools: false })).toEqual({ reason: "found a/b/c/d/e/x.sv" });

    const vendored = mkdtempSync(join(tmpdir(), "sv-detect-"));
    mkdirSync(join(vendored, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(vendored, "node_modules", "pkg", "x.sv"), "module x;\nendmodule\n");
    expect(await frontend.detect({ path: vendored, name: "vendored", allowBuildTools: false })).toBeNull();
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

describe("structure, processes and calls", () => {
  const facts = async () => {
    const records = allRecords(await extractAll());
    return { records, nodes: nodesOf(records), edges: edgesOf(records) };
  };

  it("labelled begin blocks name their process", async () => {
    const { nodes } = await facts();
    const ids = nodes.filter((n) => n.attrs.hdl === "process").map((n) => n.attrs.name);
    expect(ids).toEqual(expect.arrayContaining(["rtl_nonansi.boot", "rtl_nonansi.seq_proc", "rtl_nonansi.comb_blk"]));
  });

  it("super.m() resolves to the base class, this.m() to the own class", async () => {
    const { edges } = await facts();
    const sup = edges.filter((e) => e.kind === "calls.call" && e.attrs?.callee === "super.log");
    expect(sup).toHaveLength(1);
    expect(sup[0]?.to).toBe("dv_pkg.sv#dv_base.log");
    const self = edges.filter((e) => e.kind === "calls.call" && e.attrs?.callee === "this.step");
    expect(self[0]?.to).toBe("dv_env.sv#dv_child.step");
    // A super call must never land on the caller's own method of the same name.
    expect(edges.some((e) => e.kind === "calls.call" && e.attrs?.callee === "super.log" && e.to === "dv_env.sv#dv_child.log")).toBe(false);
  });

  it("constructors are functions named Class.new, and out-of-class definitions are scoped to their class", async () => {
    const { nodes, edges } = await facts();
    const ctor = nodes.find((n) => n.id === "dv_env.sv#dv_child.new");
    expect(ctor?.kind).toBe("structure.function");
    expect(ctor?.attrs.hdl).toBe("function");
    expect(ctor?.parent).toBe("dv_env.sv#dv_child");
    expect(nodes.find((n) => n.id === "dv_env.sv#dv_child.step")?.attrs.name).toBe("dv_child.step");
    expect(nodes.find((n) => n.id === "dv_env.sv#other_c.run")?.attrs.name).toBe("other_c.run");
    expect(nodes.find((n) => n.id === "dv_env.sv#dv_child.run")?.attrs.name).toBe("dv_child.run");
    // The extern prototypes did not add a second node.
    expect(nodes.filter((n) => n.attrs.name === "other_c.run")).toHaveLength(1);
    // The constructor's empty `super.new();` is a call to the base constructor. dv_base has none, so it stays unresolved.
    const superNew = edges.find((e) => e.kind === "calls.call" && e.from === "dv_env.sv#dv_child.new");
    expect(superNew?.attrs?.callee).toBe("super.new");
    expect(superNew?.to).toEqual({ unresolved: { scheme: "sv.call", text: "super.new" } });
  });

  it("functions in generate branches get the generate path, and same-named ones never share an id", async () => {
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

  it("calls outside processes are attributed to the module, not dropped", async () => {
    const { edges } = await facts();
    const assignCall = edges.find((e) => e.kind === "calls.call" && e.attrs?.callee === "f");
    expect(assignCall?.from).toBe("rtl2.sv#rtl_nonansi");
    expect(assignCall?.to).toBe("rtl2.sv#rtl_nonansi.f");
    expect(edges.some((e) => e.kind === "calls.call" && e.from === "rtl2.sv#rtl_nonansi" && e.attrs?.callee === "pick")).toBe(true);
  });

  it("inherited, typed-handle and DPI calls resolve; the handle of an unknown type stays unresolved", async () => {
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

  it("two files with identical byte offsets keep their own module ids", async () => {
    const col = await extractDir(join(fixturesDir, "collide"), ["p1.sv", "p2.sv"]);
    const nodes = nodesOf(allRecords(col));
    expect(nodes.find((n) => n.id === "p1.sv#alpha")?.parent).toBe("p1.sv");
    expect(nodes.find((n) => n.id === "p2.sv#bravo")?.parent).toBe("p2.sv");
    expect(duplicateIds(allRecords(col))).toEqual([]);
  });

  it("an instantiated module defined twice is a candidate set, not an exact match", async () => {
    const amb = await extractDir(join(fixturesDir, "ambiguous"), ["gate_a.sv", "gate_b.sv", "top_amb.sv"]);
    const edges = edgesOf(allRecords(amb));
    const inst = edges.find((e) => e.kind === "x-sv.instantiates" && e.attrs?.instance === "u_g");
    expect(inst?.to).toEqual({ candidates: ["gate_a.sv#prim_gate", "gate_b.sv#prim_gate"] });
    expect(inst?.provenance?.confidence).toBe("heuristic");
  });

  it("a header the grammar cannot parse still defines its module, with a heuristic line span", async () => {
    const { nodes } = await facts();
    const m = nodes.find((n) => n.id === "unparsed_hdr.sv#prim_alert_sender");
    expect(m?.kind).toBe("structure.type");
    expect(m?.provenance?.confidence).toBe("heuristic");
    expect(m?.span?.start[0]).toBe(0);
    expect(m?.span?.end[1]).toBe("module prim_alert_sender".length);
  });

  it("a deliberate parse error still produces the finding", async () => {
    const { records } = await facts();
    const findings = records.flatMap((r) => ("finding" in r ? [r.finding] : []));
    expect(findings.some((f) => f.span?.file === "syntax_err.sv")).toBe(true);
  });

  it("non-ANSI port directions, interface ports without a direction, and typed parameters", async () => {
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
    // Process ordinals count the module's own processes: the second unlabelled initial is initial[2].
    expect(nodes.some((n) => n.id === "rtl2.sv#rtl_nonansi.initial[2]")).toBe(true);
    // disable and break become flow.jump; the disable keeps its target.
    const jumps = nodes.filter((n) => n.kind === "flow.jump");
    expect(jumps.some((n) => n.attrs.variant === "break" && n.attrs.label === "blk_x")).toBe(true);
    expect(jumps.some((n) => n.attrs.variant === "break" && n.parent === "rtl2.sv#rtl_nonansi.comb_blk")).toBe(true);
  });
});

describe("cross-file resolution", () => {
  const round2 = join(fixturesDir, "round2");
  /** Extracts `targets` from a project whose files are all `all`, the way the pipeline's retry does. */
  const extractSome = async (dir: string, all: string[], targets: string[], log: (m: string) => void = () => undefined) => {
    const ctx = {
      root: { path: dir, name: "x", allowBuildTools: false },
      files: targets,
      listFiles: () => [...all],
      readFile: async (rel: string) => readFileSync(join(dir, rel), "utf8"),
      log,
    };
    const out: IRBatch[] = [];
    for await (const batch of extractFiles(ctx)) out.push(batch);
    return out;
  };
  const callsFrom = (records: IRRecord[], from: string) => edgesOf(records).filter((e) => e.kind === "calls.call" && e.from === from);

  it("calls in a module instantiation's parameter and port connections are emitted and resolve to pk.f", async () => {
    const records = allRecords(await extractDir(round2, ["pk.sv", "sub.sv", "inst.sv"]));
    const calls = callsFrom(records, "inst.sv#top_inst");
    expect(calls.map((e) => e.attrs?.callee).sort()).toEqual(["pk::f", "pk::f"]);
    expect(calls.map((e) => e.to)).toEqual(["pk.sv#pk.f", "pk.sv#pk.f"]);
  });

  it("$unit functions and file-level DPI imports resolve from a module; several project-wide matches are candidates", async () => {
    const files = ["unit_dpi.sv", "unit_other.sv", "dup_a.sv", "dup_b.sv"];
    const records = allRecords(await extractDir(round2, files));
    const byCallee = (callee: string) => edgesOf(records).find((e) => e.kind === "calls.call" && e.attrs?.callee === callee);
    // Same file: exact.
    expect(byCallee("dpi_f")?.to).toBe("unit_dpi.sv#dpi_f");
    expect(byCallee("dpi_f")?.provenance?.confidence).toBe("exact");
    expect(byCallee("unit_fn")?.to).toBe("unit_dpi.sv#unit_fn");
    expect(byCallee("unit_fn")?.provenance?.confidence).toBe("exact");
    // Another file, unique: inferred.
    expect(byCallee("other_unit_fn")?.to).toBe("unit_other.sv#other_unit_fn");
    expect(byCallee("other_unit_fn")?.provenance?.confidence).toBe("inferred");
    // Two files define it, neither is this one: candidates.
    expect(byCallee("dupf")?.to).toEqual({ candidates: ["dup_a.sv#dupf", "dup_b.sv#dupf"] });
    expect(byCallee("dupf")?.provenance?.confidence).toBe("heuristic");
  });

  it("a retry over the same project gives the same facts as the full run, and the index is reused", async () => {
    const all = ["pk.sv", "sub.sv", "inst.sv", "ctor.sv"];
    const full = allRecords(await extractSome(round2, all, all));
    const retry = allRecords(await extractSome(round2, all, ["inst.sv"]));
    const forFile = (records: IRRecord[], file: string) => records.filter((r) => ("node" in r ? r.node.id : "edge" in r ? r.edge.from : "").toString().startsWith(file));
    expect(retry.map((r) => JSON.stringify(r))).toEqual(forFile(full, "inst.sv").map((r) => JSON.stringify(r)));
    // The same texts give back the same index object, so a retry does not rebuild it.
    const texts = new Map(all.map((rel) => [rel, readFileSync(join(round2, rel), "utf8")]));
    expect(await buildProject(texts)).toBe(await buildProject(new Map(texts)));
  });

  it("sources over the cross-file limit are indexed one file at a time, with a logged reason", async () => {
    const logs: string[] = [];
    const all = ["pk.sv", "sub.sv", "inst.sv"];
    const batches = await extractSome(round2, all, all, (m) => logs.push(m));
    expect(logs.length).toBe(0);
    const small: string[] = [];
    const ctx = {
      root: { path: round2, name: "x", allowBuildTools: false },
      files: all,
      listFiles: () => [...all],
      readFile: async (rel: string) => readFileSync(join(round2, rel), "utf8"),
      log: (m: string) => small.push(m),
    };
    const limited: IRBatch[] = [];
    for await (const b of extractFiles(ctx, 10)) limited.push(b);
    expect(small.length).toBe(1);
    expect(small[0]).toContain("cross-file limit");
    // Each file is still emitted, but pk::f is in another file, so it no longer resolves.
    expect(limited.map((b) => b.file)).toEqual(all);
    const calls = callsFrom(allRecords(limited), "inst.sv#top_inst");
    expect(calls).toHaveLength(2);
    expect(calls.every((e) => typeof e.to === "object" && "unresolved" in e.to)).toBe(true);
    expect(batches.length).toBe(3);
  });

  it("the fallback scan skips lifetime keywords, the class of interface class, and comments", async () => {
    const records = allRecords(await extractDir(round2, ["lexer_err.sv"]));
    const names = nodesOf(records).map((n) => n.attrs.name);
    expect(names).toEqual(expect.arrayContaining(["lt_mod", "ifc_k", "lt_pkg"]));
    for (const bad of ["class", "automatic", "static", "commented_line_mod", "commented_block_mod", "commented_pkg_x"]) {
      expect(names).not.toContain(bad);
    }
  });

  it("a non-ANSI `output reg b;` keeps its output direction", async () => {
    const nodes = nodesOf(allRecords(await extractDir(round2, ["nonansi_var.sv"])));
    expect(nodes.find((n) => n.id === "nonansi_var.sv#nonansi_v")?.attrs.ports).toEqual([
      { name: "a", dir: "input" },
      { name: "b", dir: "output" },
    ]);
  });

  it("new() is a call to the declared class's constructor, super.new is the base constructor, and C::type_id::create stays unresolved", async () => {
    const edges = edgesOf(allRecords(await extractDir(round2, ["ctor.sv"])));
    const news = callsFrom(allRecords(await extractDir(round2, ["ctor.sv"])), "ctor.sv#child_c.run_it").filter((e) => e.attrs?.callee === "base_c.new");
    expect(news.map((e) => e.to)).toEqual(["ctor.sv#base_c.new", "ctor.sv#base_c.new"]);
    const supers = edges.filter((e) => e.kind === "calls.call" && e.attrs?.callee === "super.new");
    expect(supers.map((e) => e.to)).toEqual(["ctor.sv#base_c.new", "ctor.sv#base_c.new"]);
    // A handle of a type that is not in the project stays unresolved.
    expect(edges.find((e) => e.attrs?.callee === "bi.new")?.to).toEqual({ unresolved: { scheme: "sv.call", text: "bi.new" } });
    // C::type_id::create is not a constructor call.
    expect(edges.find((e) => e.attrs?.callee === "base_c::type_id::create")?.to).toEqual({ unresolved: { scheme: "sv.call", text: "base_c::type_id::create" } });
  });

  it("a caller in a generate branch takes that branch's definition; a caller outside them gets the candidates", async () => {
    const edges = edgesOf(allRecords(await extractDir(round2, ["gen_pick.sv"])));
    const g1 = edges.find((e) => e.kind === "calls.call" && e.from === "gen_pick.sv#gen_pick.g1.initial[1]");
    const g2 = edges.find((e) => e.kind === "calls.call" && e.from === "gen_pick.sv#gen_pick.g2.initial[1]");
    const top = edges.find((e) => e.kind === "calls.call" && e.from === "gen_pick.sv#gen_pick.initial[1]");
    expect(g1?.to).toBe("gen_pick.sv#gen_pick.g1.pick");
    expect(g1?.provenance?.confidence).toBe("exact");
    expect(g2?.to).toBe("gen_pick.sv#gen_pick.g2.pick");
    expect(g2?.provenance?.confidence).toBe("exact");
    expect(top?.to).toEqual({ candidates: ["gen_pick.sv#gen_pick.g1.pick", "gen_pick.sv#gen_pick.g2.pick"] });
  });
});

describe("class handles, cache invalidation and size limits", () => {
  const round2 = join(fixturesDir, "round2");
  const round3 = join(fixturesDir, "round3");
  const callsFrom = (records: IRRecord[], from: string) => edgesOf(records).filter((e) => e.kind === "calls.call" && e.from === from);
  const pairs = (edges: IREdge[]) => edges.map((e) => [e.attrs?.callee, e.to]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

  it("a class handle declared after another declaration (a net declaration in the tree) resolves for new, method calls and array elements", async () => {
    const records = allRecords(await extractDir(round3, ["handles.sv"]));
    const calls = callsFrom(records, "handles.sv#handles_mod.initial[1]");
    expect(pairs(calls)).toEqual([
      ["C.new", "handles.sv#C.new"],
      ["C.new", "handles.sv#C.new"],
      ["C.new", "handles.sv#C.new"],
      ["C.new", "handles.sv#C.new"],
      ["c2.m", "handles.sv#C.m"],
    ]);
  });

  it("an `interface class` in an errored file is a class, not an instantiable interface", async () => {
    const records = allRecords(await extractDir(round3, ["iface_class.sv"]));
    const ic = nodesOf(records).find((n) => n.attrs.name === "ic");
    expect(ic?.kind).toBe("structure.type");
    expect(ic?.attrs.hdl).toBe("class");
    expect(ic?.attrs.typeKind).toBe("class");
    const inst = edgesOf(records).find((e) => e.kind === "x-sv.instantiates" && e.attrs?.instance === "x");
    expect(inst?.to).toEqual({ unresolved: { scheme: "sv.module", text: "ic" } });
  });

  it("super.new is found in the tree, so a comment or string that says super.new() adds no edge", async () => {
    const edges = edgesOf(allRecords(await extractDir(round3, ["super_new.sv"])));
    expect(callsFrom(allRecords(await extractDir(round3, ["super_new.sv"])), "super_new.sv#quiet_c.new")).toEqual([]);
    const supers = edges.filter((e) => e.kind === "calls.call" && e.attrs?.callee === "super.new");
    expect(supers.map((e) => e.from)).toEqual(["super_new.sv#kid_c.new"]);
    expect(supers.map((e) => e.to)).toEqual(["super_new.sv#base_c.new"]);
  });

  it("a $unit function of the same file wins over a file-level import of a package function with the same name", async () => {
    const edges = edgesOf(allRecords(await extractDir(round3, ["unit_pref.sv"])));
    const f = edges.find((e) => e.kind === "calls.call" && e.attrs?.callee === "f");
    expect(f?.to).toBe("unit_pref.sv#f");
    expect(f?.provenance?.confidence).toBe("exact");
  });

  it("an edit to the text invalidates the cached index, and a finished extract run keeps it", async () => {
    const a = new Map([["a.sv", "module m1; endmodule\n"]]);
    const first = await buildProject(a);
    const edited = await buildProject(new Map([["a.sv", "module m2; endmodule\n"]]));
    expect(edited).not.toBe(first);
    expect(edited.decls.has("m2")).toBe(true);
    expect(edited.decls.has("m1")).toBe(false);
    releaseProject();
    expect(await buildProject(a)).not.toBe(first);
    // A finished extract run keeps the index it built, so the next run over the same texts reuses it.
    const texts = new Map(["pk.sv", "sub.sv", "inst.sv"].map((rel) => [rel, readFileSync(join(round2, rel), "utf8")]));
    const before = await buildProject(texts);
    await extractDir(round2, [...texts.keys()]);
    expect(await buildProject(texts)).toBe(before);
  });

  it("over-limit sources are sized from the file system, so each file is read once", async () => {
    const all = ["pk.sv", "sub.sv", "inst.sv"];
    let reads = 0;
    const ctx = {
      root: { path: round2, name: "x", allowBuildTools: false },
      files: all,
      listFiles: () => [...all],
      readFile: async (rel: string) => {
        reads++;
        return readFileSync(join(round2, rel), "utf8");
      },
      log: () => undefined,
    };
    for await (const _ of extractFiles(ctx, 10)) void _;
    expect(reads).toBe(all.length);
  });

  it("without sizes from the file system, reading stops once the total is over the limit", async () => {
    const all = ["pk.sv", "sub.sv", "inst.sv"];
    let reads = 0;
    const ctx = {
      root: { path: join(round3, "no-such-dir"), name: "x", allowBuildTools: false },
      files: all,
      listFiles: () => [...all],
      readFile: async (rel: string) => {
        reads++;
        return readFileSync(join(round2, rel), "utf8");
      },
      log: () => undefined,
    };
    for await (const _ of extractFiles(ctx, 10)) void _;
    // One read in the pre-pass takes the total over the limit; the per-file pass reads each file once.
    expect(reads).toBe(1 + all.length);
  });
});

describe("index cache and retries", () => {
  const round2 = join(fixturesDir, "round2");
  const all = ["pk.sv", "sub.sv", "inst.sv", "ctor.sv"];
  const readRound2 = (rel: string) => readFileSync(join(round2, rel), "utf8");
  const extractWith = async (targets: string[], read: (rel: string) => string = readRound2): Promise<IRBatch[]> => {
    const ctx = {
      root: { path: round2, name: "x", allowBuildTools: false },
      files: targets,
      listFiles: () => [...all],
      readFile: async (rel: string) => read(rel),
      log: () => undefined,
    };
    const out: IRBatch[] = [];
    for await (const batch of frontend.extract(ctx)) out.push(batch);
    return out;
  };

  it("a retry over the same project reuses the index: the pre-pass parses once", async () => {
    releaseProject();
    const before = indexStats.builds;
    await extractWith(all);
    expect(indexStats.builds - before).toBe(1);
    await extractWith(["inst.sv"]);
    await extractWith(["pk.sv"]);
    expect(indexStats.builds - before).toBe(1);
  });

  it("changing one file's text between calls rebuilds the index, and the retry then reuses the new one", async () => {
    releaseProject();
    await extractWith(all);
    const built = indexStats.builds;
    const edited = (rel: string) => (rel === "inst.sv" ? `${readRound2(rel)}\n// edited between runs\n` : readRound2(rel));
    await extractWith(["inst.sv"], edited);
    expect(indexStats.builds - built).toBe(1);
    await extractWith(["inst.sv"], edited);
    expect(indexStats.builds - built).toBe(1);
  });

  it("the cached index holds no source text", async () => {
    releaseProject();
    const texts = new Map(all.map((rel) => [rel, readRound2(rel)]));
    const index = await buildProject(texts);
    // Every string reachable from the index. A leaked file would show up as a string as long as the longest file.
    const strings: string[] = [];
    const seen = new Set<object>();
    const walk = (v: unknown): void => {
      if (typeof v === "string") {
        strings.push(v);
        return;
      }
      if (v === null || typeof v !== "object" || seen.has(v)) return;
      seen.add(v);
      if (v instanceof Map) {
        for (const [k, x] of v) {
          walk(k);
          walk(x);
        }
        return;
      }
      for (const x of Object.values(v)) walk(x);
    };
    walk(index);
    const longest = Math.max(...[...texts.values()].map((t) => t.length));
    expect(longest).toBeGreaterThan(0);
    expect(Math.max(...strings.map((s) => s.length))).toBeLessThan(longest);
    expect([...index.units.values()].every((u) => !("text" in u))).toBe(true);
  });
});

describe("deeply nested sources", () => {
  const fresh = (): string => mkdtempSync(join(tmpdir(), "sv-deep-"));
  const findingsOf = (records: IRRecord[]) => records.flatMap((r) => ("finding" in r ? [r.finding] : []));

  it("a 5000-term expression does not fail its neighbours", async () => {
    releaseProject();
    const dir = fresh();
    writeFileSync(join(dir, "deep.sv"), `module deep(input logic a, output logic x);\n  assign x = ${Array(5000).fill("a").join(" | ")};\nendmodule\n`);
    writeFileSync(join(dir, "ok.sv"), `module ok;\nendmodule\n`);
    const before = indexStats.builds;
    const batches = await extractDir(dir, ["deep.sv", "ok.sv"]);
    expect(indexStats.builds - before).toBe(1);
    const byFile = new Map(batches.map((b) => [b.file, b.records]));
    expect(byFile.has("deep.sv")).toBe(true);
    expect(byFile.has("ok.sv")).toBe(true);
    expect(nodesOf(byFile.get("ok.sv") ?? []).some((n) => n.id === "ok.sv#ok")).toBe(true);
    expect(nodesOf(byFile.get("deep.sv") ?? []).some((n) => n.id === "deep.sv#deep")).toBe(true);
    // The index-pass guard must not fire for a file that parses.
    expect(findingsOf(allRecords(batches)).filter((f) => f.message.includes("index pass failed"))).toEqual([]);
  }, 120_000);

  it("a 1000-arm else-if chain emits one branch per arm", async () => {
    releaseProject();
    const dir = fresh();
    let src = "module chain(input logic [10:0] s, output logic [10:0] y);\n  always_comb begin\n    if (s == 0) y = 0;\n";
    for (let i = 1; i < 1000; i++) src += `    else if (s == ${i}) y = ${i};\n`;
    src += "    else y = 0;\n  end\nendmodule\n";
    writeFileSync(join(dir, "chain.sv"), src);
    const batches = await extractDir(dir, ["chain.sv"]);
    const branches = allRecords(batches).flatMap((r) => ("node" in r && r.node.kind === "flow.branch" ? [r.node] : []));
    expect(branches.length).toBeGreaterThanOrEqual(1000);
  }, 120_000);

  it("a 1500-arm conditional-operator chain parses and emits", async () => {
    releaseProject();
    const dir = fresh();
    let expr = "0";
    for (let i = 1499; i >= 0; i--) expr = `s == ${i} ? ${i} : ${expr}`;
    writeFileSync(join(dir, "ternary.sv"), `module ternary(input logic [11:0] s, output logic [11:0] y);\n  assign y = ${expr};\nendmodule\n`);
    const batches = await extractDir(dir, ["ternary.sv"]);
    expect(nodesOf(allRecords(batches)).some((n) => n.id === "ternary.sv#ternary")).toBe(true);
  }, 120_000);
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

describe("scope keys and lookup order", () => {
  const scopes = join(fixturesDir, "scopes");
  const calls = (batches: IRBatch[], callee: string): IREdge[] => edgesOf(allRecords(batches)).filter((e) => e.kind === "calls.call" && e.attrs?.callee === callee);

  it("three files that each define `module tb` keep their own task scope", async () => {
    const batches = await extractDir(scopes, ["a/tb.sv", "b/tb.sv", "c/tb.sv"]);
    const all = calls(batches, "runSeq");
    expect(all).toHaveLength(3);
    for (const dir of ["a", "b", "c"]) {
      const edge = all.find((e) => e.from.startsWith(`${dir}/tb.sv#`));
      expect(edge?.to).toBe(`${dir}/tb.sv#tb.runSeq`);
      expect(edge?.provenance?.confidence).toBe("exact");
    }
  });

  it("a plain call from a module takes a package function of an imported package, inferred", async () => {
    const batches = await extractDir(scopes, ["m1.sv", "util_pkg.sv", "m2.sv"]);
    const edge = calls(batches, "clog").find((e) => e.from.startsWith("m2.sv#"));
    expect(edge?.to).toBe("util_pkg.sv#util_pkg.clog");
    expect(edge?.provenance?.confidence).toBe("inferred");
  });

  it("a class's call to f() takes the enclosing package's f over a wildcard-imported f", async () => {
    const batches = await extractDir(scopes, ["q.sv", "r.sv"]);
    const edge = calls(batches, "f").find((e) => e.from.startsWith("r.sv#"));
    expect(edge?.to).toBe("r.sv#r.f");
  });

  it("two wildcard-imported packages that define h() give candidates containing both", async () => {
    const batches = await extractDir(scopes, ["w1.sv", "w2.sv", "wm.sv"]);
    const edge = calls(batches, "h").find((e) => e.from.startsWith("wm.sv#"));
    const to = edge?.to as { candidates: string[] } | undefined;
    expect(typeof to).toBe("object");
    expect(to?.candidates).toEqual(expect.arrayContaining(["w1.sv#w1.h", "w2.sv#w2.h"]));
  });

  it("an explicitly imported name with no such package in the project stays unresolved", async () => {
    const batches = await extractDir(scopes, ["h2_pkg.sv", "missing_imp.sv"]);
    const edge = calls(batches, "h2")[0];
    expect(edge?.to).toEqual({ unresolved: { scheme: "sv.call", text: "h2" } });
  });

  it("a class extending a class outside the project does not take another package's function", async () => {
    const batches = await extractDir(scopes, ["util2.sv", "my_env.sv"]);
    const edge = calls(batches, "print")[0];
    expect(edge?.to).toEqual({ unresolved: { scheme: "sv.call", text: "print" } });
  });

  it("a file a package includes resolves its calls to that package's functions", async () => {
    const batches = await extractDir(join(fixturesDir, "incpkg"), ["pkg.sv", "cls.sv"]);
    const edge = calls(batches, "helper").find((e) => e.from.startsWith("cls.sv#"));
    expect(edge?.to).toBe("pkg.sv#pk.helper");
  });

  it("a call through an interface-typed handle resolves to the interface's task", async () => {
    const batches = await extractDir(scopes, ["bus.sv"]);
    const edge = calls(batches, "vif.drive")[0];
    expect(edge?.to).toBe("bus.sv#bus_if.drive");
    expect(edge?.provenance?.confidence).toBe("exact");
  });
});

describe("confidence labels", () => {
  const dir = join(fixturesDir, "confidence");
  const run = async () => {
    const records = allRecords(await extractDir(dir, ["clean.sv", "broken.sv", "unparsed_hdr.sv", "user.sv"]));
    return { nodes: nodesOf(records), edges: edgesOf(records) };
  };
  const instantiation = (edges: IREdge[], from: string) => edges.find((e) => e.kind === "x-sv.instantiates" && e.from === from);

  it("an instance of a module from a clean file is inferred when the instantiating file has a parse error", async () => {
    const { edges } = await run();
    const e = instantiation(edges, "broken.sv#broken_top");
    expect(e?.to).toBe("clean.sv#clean_m");
    expect(e?.provenance?.confidence).toBe("inferred");
  });

  it("an instance of a module from a clean file is exact when the instantiating file is clean", async () => {
    const { edges } = await run();
    const e = edges.find((x) => x.kind === "x-sv.instantiates" && x.from === "user.sv#user_m" && x.to === "clean.sv#clean_m");
    expect(e?.provenance?.confidence).toBe("exact");
  });

  it("an instance of a module found only by text scan is heuristic", async () => {
    const { edges } = await run();
    const e = edges.find((x) => x.kind === "x-sv.instantiates" && x.to === "unparsed_hdr.sv#prim_alert_sender");
    expect(e?.provenance?.confidence).toBe("heuristic");
  });

  it("an always_ff on a clock is an exact process whose clock is a heuristic", async () => {
    const { nodes } = await run();
    const proc = nodes.find((n) => n.attrs?.process === "always_ff");
    expect(proc?.provenance?.confidence).toBe("exact");
    expect(proc?.attrs?.clock).toBe("clk");
    expect(proc?.attrs?.clockConfidence).toBe("heuristic");
  });
});

describe("name resolution by scope", () => {
  const fx = (name: string) => join(fixturesDir, name);
  const callsNamed = (batches: IRBatch[], callee: string): IREdge[] => edgesOf(allRecords(batches)).filter((e) => e.kind === "calls.call" && e.attrs?.callee === callee);

  it("an explicit import belongs to the module that writes it, so two modules in one file see two different f", async () => {
    const batches = await extractDir(fx("import_scope"), ["p1.sv", "p2.sv", "two_mods.sv"]);
    const calls = callsNamed(batches, "f");
    expect(calls.find((e) => e.from.startsWith("two_mods.sv#a."))?.to).toBe("p1.sv#p1.f");
    expect(calls.find((e) => e.from.startsWith("two_mods.sv#b."))?.to).toBe("p2.sv#p2.f");
  });

  it("a module's wildcard import beats a file-level $unit function of the same name", async () => {
    const batches = await extractDir(fx("import_scope_wild"), ["d.sv", "p3.sv"]);
    const call = callsNamed(batches, "g")[0];
    expect(call?.from).toBe("d.sv#d.initial[1]");
    expect(call?.to).toBe("p3.sv#p3.g");
    expect(call?.provenance?.confidence).toBe("inferred");
  });

  it("a top-level function of a file a package includes is a function of that package", async () => {
    const batches = await extractDir(fx("include_pkg_fns"), ["pkg.sv", "h.svh", "t.sv"]);
    const call = callsNamed(batches, "p::g")[0];
    expect(call?.to).toBe("h.svh#g");
    expect(nodesOf(allRecords(batches)).some((n) => n.id === "h.svh#g")).toBe(true);
  });

  it("a class inside a module finds the module's function through the enclosing scope, exactly", async () => {
    const batches = await extractDir(fx("module_scope_fn"), ["m.sv"]);
    const call = callsNamed(batches, "h")[0];
    expect(call?.from).toBe("m.sv#C.run");
    expect(call?.to).toBe("m.sv#m.h");
    expect(call?.provenance?.confidence).toBe("exact");
  });
});

describe("includes in any scope", () => {
  const fx = (name: string) => join(fixturesDir, name);
  const calleeOf = (batches: IRBatch[], callee: string): IREdge | undefined =>
    edgesOf(allRecords(batches)).find((e) => e.kind === "calls.call" && e.attrs?.callee === callee);

  it("one file included by two packages gives both packages its functions", async () => {
    const batches = await extractDir(fx("include_two_packages"), ["h.svh", "p1.sv", "p2.sv", "t.sv"]);
    expect(calleeOf(batches, "p1::g")?.to).toBe("h.svh#g");
    expect(calleeOf(batches, "p2::g")?.to).toBe("h.svh#g");
  });

  it("a file included by an included file is a function of the package that includes both", async () => {
    const batches = await extractDir(fx("include_nested_pkg"), ["a.svh", "b.svh", "p.sv", "t.sv"]);
    expect(calleeOf(batches, "p::g")?.to).toBe("b.svh#g");
  });

  it("a file included in a module gives the module its functions, not the file-level one of the same name", async () => {
    const batches = await extractDir(fx("include_in_module"), ["h2.svh", "m.sv", "o.sv"]);
    const call = calleeOf(batches, "g2");
    expect(call?.to).toBe("h2.svh#g2");
    expect(call?.provenance?.confidence).toBe("inferred");
  });

  it("a file included in a class gives the class its functions", async () => {
    const batches = await extractDir(fx("include_in_class"), ["k.sv", "kbody.svh"]);
    expect(calleeOf(batches, "kf")?.to).toBe("kbody.svh#kf");
  });

  it("a file included in a module and at file level stays visible in $unit", async () => {
    const batches = await extractDir(fx("unitinc"), ["m.sv", "h.svh", "t.sv"]);
    expect(calleeOf(batches, "f")?.to).toBe("h.svh#f");
  });
});

describe("include matching", () => {
  const dir = join(fixturesDir, "include_match");
  const files = ["pkg.sv", "h.svh", "other/h.svh", "t.sv", "rtl/pk2.sv", "rtl/a/defs.svh", "rtl/b/defs.svh", "rtl/t2.sv", "rtl/pk3.sv", "inc/x.svh", "rtl/t3.sv"];
  const callTo = async (callee: string) => {
    const edges = edgesOf(allRecords(await extractDir(dir, files)));
    return edges.find((e) => e.kind === "calls.call" && e.attrs?.callee === callee)?.to;
  };

  it("a root include takes the file in its own directory, not another file with the same name", async () => {
    expect(await callTo("p::ha")).toBe("h.svh#ha");
    // other/h.svh is not included, so its hb is not a function of p.
    expect(await callTo("p::hb")).toEqual({ unresolved: { scheme: "sv.call", text: "p::hb" } });
  });

  it("an include that matches two files by suffix links neither", async () => {
    expect(await callTo("p2::da")).toEqual({ unresolved: { scheme: "sv.call", text: "p2::da" } });
    expect(await callTo("p2::db")).toEqual({ unresolved: { scheme: "sv.call", text: "p2::db" } });
  });

  it("an include with ../ resolves against the including file's directory", async () => {
    expect(await callTo("p3b::xf")).toBe("inc/x.svh#xf");
  });

  it("an include that climbs out of its directory links by the suffix of the file it names, without the ../ segments", async () => {
    const batches = await extractDir(join(fixturesDir, "include_updir"), ["rtl/p.sv", "rtl/t.sv", "vendor/inc/y.svh"]);
    expect(edgesOf(allRecords(batches)).find((e) => e.kind === "calls.call" && e.attrs?.callee === "p::fy")?.to).toBe("vendor/inc/y.svh#fy");
  });
});

describe("package declared in several files", () => {
  it("an import of a package that two files declare is a candidate set of both, heuristic", async () => {
    const edges = edgesOf(allRecords(await extractDir(join(fixturesDir, "package_twice"), ["cfg_a.sv", "cfg_b.sv", "user.sv"])));
    const imp = edges.find((e) => e.kind === "packaging.import" && e.from === "user.sv#user_m");
    expect(imp?.to).toEqual({ candidates: ["cfg_a.sv#cfg_pkg", "cfg_b.sv#cfg_pkg"] });
    expect(imp?.provenance?.confidence).toBe("heuristic");
  });

  it("an import of a package that more than 32 files declare is cut to 32 candidates and marked truncated", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sv-many-pkgs-"));
    const rels: string[] = [];
    for (let i = 0; i <= 32; i++) {
      writeFileSync(join(dir, `pk${i}.sv`), "package pk;\nendpackage\n");
      rels.push(`pk${i}.sv`);
    }
    writeFileSync(join(dir, "u.sv"), "module u;\n  import pk::*;\nendmodule\n");
    rels.push("u.sv");
    const edges = edgesOf(allRecords(await extractDir(dir, rels)));
    const imp = edges.find((e) => e.kind === "packaging.import" && e.attrs?.specifier === "pk");
    expect(imp?.to).toEqual({ candidates: expect.any(Array) });
    expect((imp?.to as { candidates: string[] }).candidates).toHaveLength(32);
    expect(imp?.attrs?.truncated).toBe(true);
  });
});

describe("process ordinals per generate path", () => {
  it("a process in one generate block is numbered from 1 in that block, whatever the other blocks hold", async () => {
    const nodes = nodesOf(allRecords(await extractDir(join(fixturesDir, "gen_ordinals"), ["top.sv"])));
    const g1 = nodes.find((n) => n.id === "top.sv#top.g1.always_ff[1]");
    expect(g1?.attrs.name).toBe("top.g1.always_ff[1]");
    expect(g1?.parent).toBe("top.sv#top");
    expect(nodes.find((n) => n.id === "top.sv#top.g0.always_ff[2]")?.attrs.name).toBe("top.g0.always_ff[2]");
    expect(nodes.some((n) => n.id === "top.sv#top.g1.always_ff[2]")).toBe(false);
  });
});

describe("plugin manifest", () => {
  it("declares the four source globs as its inputs", () => {
    const manifest = JSON.parse(readFileSync(join(here, "..", "insight-plugin.json"), "utf8")) as { inputs?: unknown };
    expect(manifest.inputs).toEqual(["**/*.v", "**/*.sv", "**/*.svh", "**/*.vh"]);
  });
});

describe("system task effects", () => {
  it("a $fopen whose mode is a variable is a write, marked as an unknown mode", async () => {
    const batches = await extractDir(join(fixturesDir, "fopen"), ["mode.sv"]);
    const fopen = nodesOf(allRecords(batches)).find((n) => n.attrs?.api === "$fopen");
    expect(fopen?.kind).toBe("effects.fs.write");
    expect(fopen?.attrs?.modeUnknown).toBe(true);
    expect(fopen?.attrs?.path).toBe("out.txt");
  });
});
