import type { IREdge, IRNode } from "@insight/ir";
import { edgeTargets } from "@insight/sdk";
import { factsForFile, type Arm, type FunctionFacts, type Item, type StateIndex, type StateRef, type StateVariable } from "./build.js";
import { layoutFunction } from "./layout.js";
import type { FunctionFlow } from "./types.js";
import { moduleMap, type ModuleMap, type PackageRoot } from "./modules.js";
import type { CouplingClass } from "./types.js";

/** One row a function reaches, directly or through same-module calls. */
export interface FootprintEntry {
  cls: "cross" | "io" | "state" | "conc" | "escape";
  label: string;
  kind?: string;
  /** A cross entry: the callee. A state entry: the variable's id. */
  target?: string;
  module?: string;
  /** A state entry: the variable is written, not only read. */
  write?: boolean;
  /** A state entry: module-private state, reached from a function that is not on its module's surface. It hoists to the callers that are. */
  hidden?: boolean;
  /** A state entry: global state, visible from every module. */
  global?: boolean;
}

/** What a function reaches outside its own code: the rows that make it couple to the rest of the program. */
export interface CouplingFootprint {
  entries: FootprintEntry[];
  /** Sorted distinct modules the cross entries call into. */
  modules: string[];
  /** Some entry may throw out of the function. */
  escape: boolean;
  /** The variables the function reaches (distinct, not capped): written, read, and whether some module-private state is reached. */
  state?: { writes: number; reads: number; hidden: boolean };
}

export interface CouplingInfo {
  module: string;
  footprint: CouplingFootprint;
  summary: string;
}

/** Entries per function. The fixpoint stops growing a footprint at this size. */
const FOOTPRINT_CAP = 50;
/** Strongest first, for the class of a local call that hoists several kinds of row. */
const ORDER: CouplingClass[] = ["cross", "state", "io", "conc", "escape"];

type StepItem = Extract<Item, { t: "step" }>;

interface Ctx {
  M: string | undefined;
  modules: ModuleMap;
  footprints: ReadonlyMap<string, CouplingFootprint>;
  /** The function is on its module's surface. */
  onSurface: boolean;
}

/** How a state row classifies: whether it is kept, and its flags. */
export interface StateClass {
  keep: boolean;
  hidden: boolean;
  global: boolean;
  write: boolean;
}

/**
 * How a read or write of a mutable variable, from a function in module `M`, classifies. Global state (storage `global` or
 * `extern-decl`, a TypeScript global property, or an exported variable written from another module) is always kept.
 * Module-private state (file-static, function-static, class-static, or a non-exported module variable) in the variable's own
 * module is hidden: kept when the function is on the module surface, folded otherwise (its footprint still hoists to the
 * surface). Any other mutable access is kept.
 */
export function stateClass(ref: StateRef, M: string | undefined, onSurface: boolean): StateClass {
  const privateStorage = ref.storage === "file-static" || ref.storage === "function-static" || ref.storage === "class-static" || (ref.storage === "module" && !ref.exported);
  const global = ref.storage === "global" || ref.storage === "extern-decl" || ref.tsGlobal || (ref.exported && ref.writers.some((w) => w !== ref.owner));
  const hidden = !global && privateStorage && ref.owner !== undefined && ref.owner === M;
  return { keep: global || !hidden || onSurface, hidden, global, write: ref.write };
}

const targetsOf = (item: StepItem): string[] => item.targets ?? (item.target ? [item.target] : []);

/** A target is cross when its module is known and differs from the caller's. */
function isCross(t: string, M: string | undefined, modules: ModuleMap): boolean {
  const m = modules.moduleOf(t);
  return m !== undefined && m !== M;
}

/** The catch arm and everything outside a try-with-catch keep the outer `caught`; only the try arm is caught. */
function armCaught(fork: Extract<Item, { t: "fork" }>, arm: Arm, caught: boolean): boolean {
  return fork.role === "try" && arm.kind === "next" && fork.arms.some((a) => a.kind === "exception") ? true : caught;
}

/** A local call's footprint as seen from one call site: escapes only count when the site is not caught. */
function effective(targets: string[], caught: boolean, ctx: Ctx): FootprintEntry[] {
  const out: FootprintEntry[] = [];
  for (const t of targets) {
    const fp = ctx.footprints.get(t);
    if (fp === undefined) continue;
    for (const e of fp.entries) {
      if (e.cls === "escape" && caught) continue;
      out.push(e);
    }
    // Past the cap the callee's throw may not be among its entries: its escape flag still hoists `throws`.
    if (fp.escape && !caught && !fp.entries.some((e) => e.cls === "escape")) out.push({ cls: "escape", label: "throws" });
  }
  return out;
}

function strongest(entries: FootprintEntry[]): CouplingClass {
  return ORDER.find((c) => entries.some((e) => e.cls === c)) ?? "local";
}

/** Up to three non-escape labels (hidden state with `◆`), then `throws` when some entry may throw, then ` +N` for the labels not shown. */
function hoistedText(entries: FootprintEntry[]): string {
  const labelOf = (e: FootprintEntry) => (e.hidden ? `◆ ${e.label}` : e.label);
  const labels = [...new Set(entries.filter((e) => e.cls !== "escape").map(labelOf))];
  const shown = labels.slice(0, 3);
  if (entries.some((e) => e.cls === "escape")) shown.push("throws");
  const text = shown.join(", ");
  return labels.length > 3 ? `${text} +${labels.length - 3}` : text;
}

/** How a step row classifies at one site: whether it is kept, its class, and what it hoists. */
function stepInfo(item: StepItem, caught: boolean, ctx: Ctx): { kept: boolean; coupling?: CouplingClass; hoisted?: string } {
  switch (item.role) {
    case "effect":
      return { kept: true, coupling: "io" };
    case "sync":
      return { kept: true, coupling: "conc" };
    case "state":
      return item.state !== undefined && stateClass(item.state, ctx.M, ctx.onSurface).keep ? { kept: true, coupling: "state" } : { kept: false };
    case "spawn":
      return { kept: true, coupling: "conc" };
    case "await":
    case "call": {
      const targets = targetsOf(item);
      const cross = targets.filter((t) => isCross(t, ctx.M, ctx.modules));
      if (cross.length > 0) {
        const mayThrow = !caught && cross.some((t) => ctx.footprints.get(t)?.escape === true);
        return { kept: true, coupling: "cross", ...(mayThrow ? { hoisted: "may throw" } : {}) };
      }
      const eff = effective(targets, caught, ctx);
      // An await is a concurrency row: it keeps class conc unless what its callee hoists is stronger under ORDER.
      if (item.role === "await") {
        if (eff.length === 0) return { kept: true, coupling: "conc" };
        return { kept: true, coupling: strongest([{ cls: "conc", label: item.label }, ...eff]), hoisted: hoistedText(eff) };
      }
      if (eff.length === 0) return { kept: false };
      return { kept: true, coupling: strongest(eff), hoisted: hoistedText(eff) };
    }
    default:
      return { kept: false };
  }
}

/** Whether an item keeps any row, judged without building folds, so dropped runs are never numbered by mistake. */
function kept(item: Item, caught: boolean, ctx: Ctx): boolean {
  switch (item.t) {
    case "step":
      return stepInfo(item, caught, ctx).kept;
    case "term":
      return item.role === "throw" && !caught;
    case "fork":
      return item.role === "lock" || item.arms.some((a) => a.body.some((b) => kept(b, armCaught(item, a, caught), ctx)));
    case "loop":
      return item.body.some((b) => kept(b, caught, ctx));
  }
}

function countItems(items: Item[]): number {
  let n = 0;
  for (const i of items) {
    n += 1;
    if (i.t === "fork") for (const a of i.arms) n += countItems(a.body);
    else if (i.t === "loop") n += countItems(i.body);
  }
  return n;
}

function keepItem(item: Item, caught: boolean, ctx: Ctx, st: { next: number }): Item {
  switch (item.t) {
    case "step": {
      if (item.role === "state" && item.state !== undefined) {
        const cls = stateClass(item.state, ctx.M, ctx.onSurface);
        // A global row's title lists the other modules that write the variable.
        const writers = item.state.writers.filter((w) => w !== ctx.M);
        const title = cls.global && writers.length > 0 ? `${item.title ?? item.label} · written from ${writers.join(", ")}` : item.title;
        return {
          ...item,
          coupling: "state",
          label: cls.hidden ? `◆ ${item.label}` : item.label,
          ...(title !== undefined ? { title } : {}),
          ...(cls.write ? { write: true as const } : {}),
          ...(cls.hidden ? { hidden: true as const } : {}),
          ...(cls.global ? { global: true as const } : {}),
        };
      }
      const info = stepInfo(item, caught, ctx);
      // A suspension point says that other coroutines may run there; a hoisted callee footprint shows as ⇢ on the label and title.
      const suspends = item.role === "await";
      const hoisted = info.hoisted;
      const baseLabel = hoisted !== undefined ? `${item.label} ⇢ ${hoisted}` : item.label;
      const baseTitle = hoisted !== undefined ? `${item.title ?? item.label} ⇢ ${hoisted}` : item.title;
      return {
        ...item,
        ...(info.coupling !== undefined ? { coupling: info.coupling } : {}),
        ...(hoisted !== undefined ? { hoisted } : {}),
        label: suspends ? `⏸ ${baseLabel}` : baseLabel,
        ...(suspends
          ? { title: `${baseTitle ?? baseLabel} (other coroutines may run here)` }
          : baseTitle !== undefined ? { title: baseTitle } : {}),
      };
    }
    case "term":
      return { ...item, coupling: "escape" };
    case "fork":
      return {
        ...item,
        ...(item.role === "lock" ? { coupling: "conc" as const } : {}),
        arms: item.arms.map((a) => ({ ...a, body: prune(a.body, armCaught(item, a, caught), ctx, st) })),
      };
    case "loop":
      return { ...item, body: prune(item.body, caught, ctx, st) };
  }
}

/**
 * The kept rows of one list, in order. Every maximal run of dropped items becomes one `⋯ n local` fold row. Input items are
 * never changed: a fold holds the original items.
 */
function prune(items: readonly Item[], caught: boolean, ctx: Ctx, st: { next: number }): Item[] {
  const out: Item[] = [];
  let run: Item[] = [];
  const flush = () => {
    if (run.length === 0) return;
    st.next++;
    out.push({ t: "step", role: "marker", label: `⋯ ${countItems(run)} local`, fold: run, foldId: `f${st.next}` });
    run = [];
  };
  for (const item of items) {
    if (!kept(item, caught, ctx)) {
      run.push(item);
      continue;
    }
    flush();
    out.push(keepItem(item, caught, ctx, st));
  }
  flush();
  return out;
}

/**
 * A function's footprint while it is built. The entries stop at FOOTPRINT_CAP, but the escape flag and the module set are
 * kept past the cap, so the footprint's `escape` and `modules` stay right for a function with many entries.
 */
interface Acc {
  entries: Map<string, FootprintEntry>;
  escape: boolean;
  modules: Set<string>;
  /** Every variable reached, past the cap: whether it is written and whether it is read. */
  state: Map<string, { w: boolean; r: boolean }>;
  hidden: boolean;
}

const newAcc = (): Acc => ({ entries: new Map(), escape: false, modules: new Set(), state: new Map(), hidden: false });

/** Records that a variable is reached (written, or read). Reports whether that is new. */
function noteState(acc: Acc, variable: string, write: boolean): boolean {
  const cur = acc.state.get(variable);
  if (cur === undefined) {
    acc.state.set(variable, write ? { w: true, r: false } : { w: false, r: true });
    return true;
  }
  if (write && !cur.w) {
    cur.w = true;
    return true;
  }
  if (!write && !cur.r) {
    cur.r = true;
    return true;
  }
  return false;
}

/** Adds an entry, the escape flag, its module, and its state. Reports whether the footprint grew. */
function add(acc: Acc, e: FootprintEntry): boolean {
  let grew = false;
  if (e.cls === "escape" && !acc.escape) {
    acc.escape = true;
    grew = true;
  }
  if (e.cls === "cross" && e.module !== undefined && e.module !== "" && !acc.modules.has(e.module)) {
    acc.modules.add(e.module);
    grew = true;
  }
  if (e.cls === "state") {
    if (e.target !== undefined && noteState(acc, e.target, e.write === true)) grew = true;
    if (e.hidden === true && !acc.hidden) {
      acc.hidden = true;
      grew = true;
    }
  }
  const key = `${e.cls}|${e.label}|${e.target ?? ""}`;
  if (!acc.entries.has(key) && acc.entries.size < FOOTPRINT_CAP) {
    acc.entries.set(key, e);
    grew = true;
  }
  return grew;
}

interface Site {
  label: string;
  targets: string[];
  caught: boolean;
}

/** The module and surface of the function whose list is collected. */
interface Env {
  M: string | undefined;
  modules: ModuleMap;
  onSurface: boolean;
}

/** The direct entries of a list, and the call sites that may pull in a callee's footprint. */
function collect(list: readonly Item[], caught: boolean, env: Env, mine: Acc, sites: Site[]): void {
  const { M, modules } = env;
  for (const item of list) {
    switch (item.t) {
      case "step": {
        if (item.role === "state" && item.state !== undefined) {
          // Kept or folded alike: a folded hidden row still hoists to the callers on the surface.
          const cls = stateClass(item.state, M, env.onSurface);
          add(mine, {
            cls: "state",
            label: item.label,
            target: item.state.variable,
            ...(cls.write ? { write: true } : {}),
            ...(cls.hidden ? { hidden: true } : {}),
            ...(cls.global ? { global: true } : {}),
          });
        } else if (item.role === "effect") {
          add(mine, { cls: "io", label: item.label, ...(item.kind !== undefined ? { kind: item.kind } : {}) });
        } else if (item.role === "spawn") {
          add(mine, { cls: "conc", label: item.label });
        } else if (item.role === "sync") {
          // A release is the end of a frame, not a new interaction, so it adds no entry.
          if (item.lockOp !== "release") add(mine, { cls: "conc", label: item.text ?? item.label });
        } else if (item.role === "await" || item.role === "call") {
          const targets = targetsOf(item);
          const cross = targets.filter((t) => isCross(t, M, modules));
          const first = cross[0];
          if (first !== undefined) add(mine, { cls: "cross", label: item.label, target: first, module: modules.moduleOf(first) ?? "" });
          else if (item.role === "await") add(mine, { cls: "conc", label: item.label });
          if (targets.length > 0) sites.push({ label: item.label, targets, caught });
        }
        break;
      }
      case "term":
        if (item.role === "throw" && !caught) add(mine, { cls: "escape", label: "throws" });
        break;
      case "fork":
        // A lock frame's head is the acquire it replaces.
        if (item.role === "lock") add(mine, { cls: "conc", label: `lock ${item.lock ?? ""}`.trim() });
        for (const a of item.arms) collect(a.body, armCaught(item, a, caught), env, mine, sites);
        break;
      case "loop":
        collect(item.body, caught, env, mine, sites);
        break;
    }
  }
}

/**
 * The footprint of every function: the rows it reaches directly or through same-module calls. A cross call only adds
 * `may throw` when its callee may throw. A fixpoint, so recursion terminates: entries only grow, up to a cap.
 */
export function computeFootprints(fns: ReadonlyMap<string, readonly Item[]>, modules: ModuleMap, surface?: ReadonlySet<string>): Map<string, CouplingFootprint> {
  const accs = new Map<string, Acc>();
  const sites = new Map<string, Site[]>();
  const modOf = new Map<string, string | undefined>();
  for (const [id, items] of fns) {
    const M = modules.moduleOf(id);
    const mine = newAcc();
    const ss: Site[] = [];
    // Without a surface every function counts as on it, so no row is folded for want of one.
    collect(items, false, { M, modules, onSurface: surface === undefined || surface.has(id) }, mine, ss);
    accs.set(id, mine);
    sites.set(id, ss);
    modOf.set(id, M);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const [id, ss] of sites) {
      const M = modOf.get(id);
      const mine = accs.get(id) as Acc;
      for (const s of ss) {
        for (const t of s.targets) {
          const tm = modules.moduleOf(t);
          const callee = accs.get(t);
          if (tm === undefined || callee === undefined) continue;
          if (tm === M) {
            for (const e of callee.entries.values()) {
              if (e.cls === "escape" && s.caught) continue;
              if (add(mine, e)) changed = true;
            }
            // Past the cap the callee's entries may be gone: its variables and hidden flag still hoist.
            for (const [v, rw] of callee.state) {
              if (rw.w && noteState(mine, v, true)) changed = true;
              if (rw.r && noteState(mine, v, false)) changed = true;
            }
            if (callee.hidden && !mine.hidden) {
              mine.hidden = true;
              changed = true;
            }
            // A callee whose throw is past the cap has no stored escape entry: the flag still hoists `throws`.
            const storedEscape = [...callee.entries.values()].some((e) => e.cls === "escape");
            if (callee.escape && !s.caught && !storedEscape && add(mine, { cls: "escape", label: "throws" })) changed = true;
            for (const m of callee.modules) {
              if (!mine.modules.has(m)) {
                mine.modules.add(m);
                changed = true;
              }
            }
          } else if (!s.caught && callee.escape) {
            if (add(mine, { cls: "escape", label: `${s.label} may throw` })) changed = true;
          }
        }
      }
    }
  }
  const out = new Map<string, CouplingFootprint>();
  for (const [id, acc] of accs) {
    const mods = [...acc.modules].filter((m) => m !== "").sort();
    const state = { writes: [...acc.state.values()].filter((x) => x.w).length, reads: [...acc.state.values()].filter((x) => x.r).length, hidden: acc.hidden };
    out.set(id, { entries: [...acc.entries.values()], modules: mods, escape: acc.escape, state });
  }
  return out;
}

/** One line for a function header or canvas box: `⇄ 2 modules · fs 2 · conc 1 · state 1w 2r · ◆ · throws ↑`, or `no coupling`. */
export function footprintSummary(fp: CouplingFootprint): string {
  const parts: string[] = [];
  if (fp.modules.length > 0) parts.push(`⇄ ${fp.modules.length} ${fp.modules.length === 1 ? "module" : "modules"}`);
  const io = new Map<string, number>();
  let conc = 0;
  for (const e of fp.entries) {
    if (e.cls === "conc") conc++;
    if (e.cls !== "io") continue;
    const group = e.kind === undefined ? "io" : e.kind.replace(/^effects\./, "").split(".")[0] ?? "io";
    io.set(group, (io.get(group) ?? 0) + 1);
  }
  for (const group of [...io.keys()].sort()) parts.push(`${group} ${io.get(group) ?? 0}`);
  if (conc > 0) parts.push(`conc ${conc}`);
  const st = fp.state;
  if (st !== undefined && st.writes + st.reads > 0) parts.push(`state ${st.writes}w ${st.reads}r`);
  if (st?.hidden === true) parts.push("◆");
  if (fp.escape) parts.push("throws ↑");
  return parts.length === 0 ? "no coupling" : parts.join(" · ");
}

/**
 * A function's chart pruned to its coupling rows. Same-module calls with a footprint stay as one row carrying what they
 * hoist; dropped runs fold into `⋯ n local` rows. `footprints` comes from `computeFootprints`.
 */
export function couplingChart(
  fnId: string,
  items: Item[],
  modules: ModuleMap,
  footprints: ReadonlyMap<string, CouplingFootprint>,
  surface?: ReadonlySet<string>,
): { items: Item[]; info: CouplingInfo } {
  const M = modules.moduleOf(fnId);
  const fp = footprints.get(fnId) ?? { entries: [], modules: [], escape: false, state: { writes: 0, reads: 0, hidden: false } };
  const out = prune(items, false, { M, modules, footprints, onSurface: surface === undefined || surface.has(fnId) }, { next: 0 });
  return { items: out, info: { module: M ?? ".", footprint: fp, summary: footprintSummary(fp) } };
}

/** The chart with every fold whose id is in `open` replaced by the rows it folds, recursively. */
export function unfold(items: readonly Item[], open: ReadonlySet<string>): Item[] {
  return items.flatMap((item): Item[] => {
    // An open fold keeps a thin header row (`▾ n local`) before its rows, so it can be folded back.
    if (item.t === "step" && item.foldId !== undefined && open.has(item.foldId) && item.fold !== undefined && item.open !== true) {
      const header: Item = { t: "step", role: "marker", label: `▾ ${countItems(item.fold)} local`, foldId: item.foldId, fold: item.fold, open: true };
      return [header, ...unfold(item.fold, open)];
    }
    if (item.t === "fork") return [{ ...item, arms: item.arms.map((a) => ({ ...a, body: unfold(a.body, open) })) }];
    if (item.t === "loop") return [{ ...item, body: unfold(item.body, open) }];
    return [item];
  });
}

/**
 * The coupling chart with every fold in `open` replaced by the rows it folds, laid out again. The chart keeps its coupling
 * (`coupling`). A flow without its pre-layout items (too large to draw) is returned as it is.
 */
export function unfoldChart(flow: FunctionFlow, open: ReadonlySet<string>, coupling: FunctionFlow["coupling"] = flow.coupling): FunctionFlow {
  if (flow.items === undefined) return flow;
  const out = layoutFunction({ id: flow.id, name: flow.name, async: flow.async, ...(flow.span ? { span: flow.span } : {}), items: unfold(flow.items, open) });
  return coupling === undefined ? out : { ...out, coupling };
}

const ENTRY_FILE = /^index\.(ts|tsx|js|jsx|mjs|cjs)$/;

/** Whether a file is the entry of a package root: `index.*` directly in the root's directory. */
function isEntryFile(file: string, roots: readonly PackageRoot[]): boolean {
  const slash = file.lastIndexOf("/");
  const dir = slash >= 0 ? file.slice(0, slash) : ".";
  return ENTRY_FILE.test(file.slice(slash + 1)) && roots.some((r) => r.path === dir);
}

/**
 * The module surface: the functions another module reaches (a `calls.call` or `calls.reference` from a different module), plus
 * the exported functions of package entry files (`index.*` at a package root; C++ has none). Plain `exported` alone does not
 * count.
 */
export function moduleSurface(nodes: readonly IRNode[], edges: readonly IREdge[], modules: ModuleMap): Set<string> {
  const surface = new Set<string>();
  for (const e of edges) {
    if (e.kind !== "calls.call" && e.kind !== "calls.reference") continue;
    const fromM = modules.moduleOf(e.from);
    const targets = edgeTargets(e);
    for (const callee of [...targets.nodes, ...targets.candidates]) {
      const cm = modules.moduleOf(callee);
      if (cm !== undefined && cm !== fromM) surface.add(callee);
    }
  }
  for (const n of nodes) {
    if (n.kind !== "structure.function" || n.attrs.exported !== true || n.span === undefined) continue;
    if (isEntryFile(n.span.file, modules.roots)) surface.add(n.id);
  }
  return surface;
}

/** The project's data.variable nodes, each with its module and the modules that write it (from data.write edges). */
export function stateIndex(nodes: readonly IRNode[], edges: readonly IREdge[], modules: ModuleMap): StateIndex {
  const writers = new Map<string, Set<string>>();
  for (const e of edges) {
    if (e.kind !== "data.write" || typeof e.to !== "string") continue;
    const m = modules.moduleOf(e.from);
    if (m === undefined) continue;
    const set = writers.get(e.to);
    if (set) set.add(m);
    else writers.set(e.to, new Set([m]));
  }
  const out = new Map<string, StateVariable>();
  for (const n of nodes) {
    if (n.kind !== "data.variable") continue;
    out.set(n.id, { node: n, module: modules.moduleOf(n.id), writers: [...(writers.get(n.id) ?? [])].sort() });
  }
  return out;
}

/** The module map, every function's chart with call sites that resolve, every footprint, the module surface and the state index, for a set of IR records. */
export function couplingFacts(
  nodes: readonly IRNode[],
  edges: readonly IREdge[],
): { modules: ModuleMap; facts: Map<string, FunctionFacts>; footprints: Map<string, CouplingFootprint>; surface: Set<string>; state: StateIndex } {
  const modules = moduleMap(nodes);
  const surface = moduleSurface(nodes, edges, modules);
  const state = stateIndex(nodes, edges, modules);
  const byFileNodes = new Map<string, IRNode[]>();
  const byFileEdges = new Map<string, IREdge[]>();
  for (const n of nodes) {
    if (!n.span) continue;
    const list = byFileNodes.get(n.span.file);
    if (list) list.push(n);
    else byFileNodes.set(n.span.file, [n]);
  }
  for (const e of edges) {
    if ((e.kind !== "calls.call" && e.kind !== "data.read" && e.kind !== "data.write") || !e.span) continue;
    const list = byFileEdges.get(e.span.file);
    if (list) list.push(e);
    else byFileEdges.set(e.span.file, [e]);
  }
  const facts = new Map<string, FunctionFacts>();
  for (const [file, ns] of byFileNodes) {
    for (const f of factsForFile(file, ns, byFileEdges.get(file) ?? [], { sources: true, state })) facts.set(f.id, f);
  }
  const fns = new Map<string, readonly Item[]>();
  for (const [id, f] of facts) fns.set(id, f.items);
  return { modules, facts, footprints: computeFootprints(fns, modules, surface), surface, state };
}
