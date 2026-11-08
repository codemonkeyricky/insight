import type { IREdge, IRNode } from "@insight/ir";
import { edgeTargets, isExternal } from "@insight/sdk";
import { factsForFile, type FunctionFacts, type Item } from "./build.js";
import { measure } from "./layout.js";
import type {
  FlowSpan,
  FlowStats,
  ScopeCall,
  ScopeExternal,
  ScopeFile,
  ScopeFlow,
  ScopeFlowStats,
  ScopeFunction,
  ScopeGranularity,
  UnreferencedFunction,
} from "./types.js";

/** A scope with more functions than this is summarized per file, so the payload and the graph stay small. */
export const SCOPE_FUNCTION_LIMIT = 400;

const cmpText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function push<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  const list = m.get(k);
  if (list) list.push(v);
  else m.set(k, [v]);
}

/** Directory names whose files are tests, fixtures or samples. */
const NOISE_DIRS = new Set(["test", "tests", "__tests__", "fixtures", "sample", "samples"]);

/**
 * Whether a file is noise: a test, fixture or sample. A directory on its path is named `test`, `tests`, `__tests__`,
 * `fixtures`, `sample` or `samples`, or the file is `*.test.*` or `*.spec.*`. Nothing in the code calls such a function;
 * a test runner, a fixture loader or a reader does.
 */
export function isNoisePath(file: string): boolean {
  const parts = file.split("/");
  const base = parts[parts.length - 1] ?? "";
  if (parts.slice(0, -1).some((p) => NOISE_DIRS.has(p))) return true;
  return /\.(test|spec)\./.test(base);
}

/** The distinct functions reached from `start` through `edges`, not counting `start`. Iterative, so cycles are safe. */
function reachFrom(start: string, edges: ReadonlyMap<string, readonly string[]>): number {
  const seen = new Set<string>([start]);
  const stack = [start];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    for (const next of edges.get(cur) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      stack.push(next);
    }
  }
  return seen.size - 1;
}

/**
 * The functions that no function in the scope calls or refers to, each with its reach. `calledInScope` maps a callee to
 * its callers in the scope, where module-level code counts as a caller; a self-call or self-reference is not in it.
 * `calls` are the scope's call and reference rows, from which the reach graph is built: in-scope, function to function,
 * self-edges left out. The callers and callees given here are already read through anonymous functions (see
 * `summarizeScope`), so an anonymous function is in neither, and is never listed.
 */
function unreferencedOf(
  functions: readonly ScopeFunction[],
  calledInScope: ReadonlyMap<string, ReadonlySet<string>>,
  calls: Iterable<ScopeCall>,
): UnreferencedFunction[] {
  const local = new Set(functions.filter((f) => !f.anonymous).map((f) => f.id));
  const callees = new Map<string, string[]>();
  for (const c of calls) {
    if (c.external || c.from === c.to || !local.has(c.from) || !local.has(c.to)) continue;
    push(callees, c.from, c.to);
  }
  const out: UnreferencedFunction[] = [];
  for (const f of functions) {
    if (f.anonymous || calledInScope.has(f.id)) continue;
    const noise = isNoisePath(f.file);
    out.push({ ...f, reach: reachFrom(f.id, callees), ...(noise ? { noise: true as const } : {}) });
  }
  return out;
}

/** The file of an id such as `src/lib/math.ts#add`: the part before the '#'. */
function fileOfId(id: string): string | undefined {
  const at = id.indexOf("#");
  return at === -1 ? undefined : id.slice(0, at);
}

/** The name of an id such as `src/lib/math.ts#Counter.increment`: the part after the '#'. */
function nameOfId(id: string): string {
  const at = id.indexOf("#");
  return at === -1 ? id : id.slice(at + 1);
}

function countRoles(items: Item[], into: { awaits: number; spawns: number; effects: number }): void {
  for (const i of items) {
    if (i.t === "step") {
      if (i.role === "await") into.awaits++;
      else if (i.role === "spawn") into.spawns++;
      else if (i.role === "effect") into.effects++;
    } else if (i.t === "fork") {
      for (const a of i.arms) countRoles(a.body, into);
    } else if (i.t === "loop") {
      countRoles(i.body, into);
    }
  }
}

/**
 * The call flow of one scope, from its scoped IR (core `scopeDoc`): the in-scope nodes plus external
 * stubs for the far end of each edge that crosses the boundary. Ids are never rewritten, so a call
 * into a stub is external here and resolves in a wider scope that holds its callee.
 *
 * `scopeFiles` is the scope's file list when the caller has it. It only adds to `stats.files`.
 */
export function summarizeScope(nodes: Iterable<IRNode>, edges: Iterable<IREdge>, scopeFiles: Iterable<string> = []): ScopeFlow {
  const stubs = new Set<string>();
  const fnNodes = new Map<string, IRNode>();
  const nodesByFile = new Map<string, IRNode[]>();
  const fileSet = new Set<string>(scopeFiles);
  for (const n of nodes) {
    if (isExternal(n)) {
      stubs.add(n.id);
      continue;
    }
    if (!n.span) continue;
    fileSet.add(n.span.file);
    push(nodesByFile, n.span.file, n);
    if (n.kind === "structure.function") fnNodes.set(n.id, n);
  }

  const callEdges: IREdge[] = [];
  const refEdges: IREdge[] = [];
  for (const e of edges) {
    if (e.kind === "calls.call") callEdges.push(e);
    else if (e.kind === "calls.reference") refEdges.push(e);
  }

  // A caller is in scope when it is a local function, or a file in scope (module-level code).
  const inScope = (id: string) => !stubs.has(id) && (fnNodes.has(id) || fileSet.has(id));

  // An anonymous function belongs to the function or file it is written in, so its calls and references count as
  // that owner's. A function reached only through a lambda then has the same callers and reach as if the lambda's
  // body were written inline in its owner.
  const anonymousParent = new Map<string, string>();
  for (const n of fnNodes.values()) if (n.attrs?.anonymous === true && n.parent !== undefined) anonymousParent.set(n.id, n.parent);
  const ownerOf = (id: string): string => {
    let cur = id;
    for (let hops = 0; hops <= anonymousParent.size; hops++) {
      const up = anonymousParent.get(cur);
      if (up === undefined) break;
      cur = up;
    }
    return cur;
  };

  const totals = { calls: 0, resolved: 0, external: 0, unresolved: 0, inbound: 0 };
  const rows = new Map<string, ScopeCall>();
  // Callers of each function in scope, other than the function itself.
  const calledInScope = new Map<string, Set<string>>();
  const calledFromOutside = new Set<string>();

  for (const e of callEdges) {
    const { nodes: direct, candidates } = edgeTargets(e);
    const targets = direct.length > 0 ? direct : candidates;
    const candidate = direct.length === 0 && candidates.length > 0;
    if (!inScope(e.from)) {
      const hits = targets.filter((t) => fnNodes.has(t));
      if (hits.length > 0) {
        totals.inbound++;
        for (const t of hits) calledFromOutside.add(t);
      }
      continue;
    }
    totals.calls++;
    if (targets.length === 0) {
      totals.unresolved++;
      continue;
    }
    if (targets.some((t) => fnNodes.has(t))) totals.resolved++;
    else totals.external++;
    const caller = ownerOf(e.from);
    for (const t of targets) {
      const local = fnNodes.has(t);
      if (local && t !== caller) {
        const set = calledInScope.get(t) ?? new Set<string>();
        set.add(caller);
        calledInScope.set(t, set);
      }
      const key = `${e.from}\0${t}\0${candidate}`;
      const row = rows.get(key);
      if (row) row.count++;
      else rows.set(key, { from: e.from, to: t, count: 1, external: !local, ...(candidate ? { candidate: true as const } : {}) });
    }
  }

  // A reference makes its target referenced without a call. It counts for unreferenced, entries and reach, but adds no call row.
  const referenceRows: ScopeCall[] = [];
  for (const e of refEdges) {
    const { nodes: direct, candidates } = edgeTargets(e);
    const targets = direct.length > 0 ? direct : candidates;
    if (!inScope(e.from)) {
      for (const t of targets) if (fnNodes.has(t)) calledFromOutside.add(t);
      continue;
    }
    const caller = ownerOf(e.from);
    for (const t of targets) {
      if (!fnNodes.has(t) || t === caller) continue;
      const set = calledInScope.get(t) ?? new Set<string>();
      set.add(caller);
      calledInScope.set(t, set);
      referenceRows.push({ from: e.from, to: t, count: 1, external: false });
    }
  }

  const callsByFile = new Map<string, IREdge[]>();
  for (const e of callEdges) if (e.span) push(callsByFile, e.span.file, e);

  const functions: ScopeFunction[] = [];
  const fileRows = new Map<string, ScopeFile>();
  for (const [file, ns] of nodesByFile) {
    for (const fn of factsForFile(file, ns, callsByFile.get(file) ?? [])) {
      const s = measure(fn.items);
      const fr = fileRows.get(file) ?? { file, functions: 0, decisions: 0, loops: 0, tries: 0 };
      fr.decisions += s.decisions;
      fr.loops += s.loops;
      fr.tries += s.tries;
      fileRows.set(file, fr);
      // Module-level code is not a function: it counts toward its file and appears as a caller.
      if (fn.id === file) continue;
      fr.functions++;
      const anonymous = fnNodes.get(fn.id)?.attrs?.anonymous === true;
      functions.push(functionRow(fn, file, s, calledFromOutside.has(fn.id), anonymous));
    }
  }
  functions.sort((a, b) => cmpText(a.file, b.file) || a.line - b.line || cmpText(a.id, b.id));
  for (const f of functions) {
    const fr = fileRows.get(f.file);
    if (f.calledFromOutside && fr) fr.calledFromOutside = true;
  }
  const fileList = [...fileRows.values()].sort((a, b) => cmpText(a.file, b.file));

  const fileOf = (id: string): string => fnNodes.get(id)?.span?.file ?? id;
  const granularity: ScopeGranularity = functions.length > SCOPE_FUNCTION_LIMIT ? "files" : "functions";
  const callRows = granularity === "functions" ? [...rows.values()] : aggregateByFile(rows.values(), fileOf);
  callRows.sort((a, b) => cmpText(a.from, b.from) || cmpText(a.to, b.to) || Number(a.external) - Number(b.external));

  const externals = new Map<string, ScopeExternal>();
  for (const r of callRows) {
    if (!r.external) continue;
    const key = granularity === "files" ? (fileOfId(r.to) ?? r.to) : r.to;
    if (externals.has(key)) continue;
    if (granularity === "files") {
      externals.set(key, { id: key, name: key, file: key });
      continue;
    }
    const file = fileOfId(key);
    externals.set(key, { id: key, name: nameOfId(key), ...(file !== undefined ? { file } : {}) });
  }

  const entries = granularity === "functions" ? entryFunctions(functions, calledInScope, calledFromOutside) : entryFiles(fileList, calledInScope, calledFromOutside, fileOf);

  // Built from the function rows, not the payload rows, so it holds at every granularity.
  const readThroughAnonymous = (c: ScopeCall): ScopeCall => ({ ...c, from: ownerOf(c.from), to: ownerOf(c.to) });
  const unreferenced = unreferencedOf(functions, calledInScope, [...rows.values(), ...referenceRows].map(readThroughAnonymous));
  const unreferencedNoise = unreferenced.filter((f) => f.noise).length;
  const functionsNoise = functions.filter((f) => isNoisePath(f.file)).length;
  const stats: ScopeFlowStats = {
    functions: functions.length,
    files: fileSet.size,
    calls: totals.calls,
    resolved: totals.resolved,
    external: totals.external,
    unresolved: totals.unresolved,
    inbound: totals.inbound,
    entries: entries.length,
    functionsTotal: functions.length,
    functionsNoise,
    functionsNonNoise: functions.length - functionsNoise,
    unreferenced: unreferenced.length - unreferencedNoise,
    unreferencedNoise,
    unreferencedOutside: unreferenced.filter((f) => !f.noise && f.calledFromOutside).length,
  };
  return {
    granularity,
    functions: granularity === "functions" ? functions : [],
    unreferenced,
    calls: callRows,
    externals: [...externals.values()].sort((a, b) => cmpText(a.id, b.id)),
    entries,
    files: fileList,
    stats,
  };
}

function functionRow(fn: FunctionFacts, file: string, s: FlowStats, fromOutside: boolean, anonymous: boolean): ScopeFunction {
  const roles = { awaits: 0, spawns: 0, effects: 0 };
  countRoles(fn.items, roles);
  const span: FlowSpan | undefined = fn.span;
  return {
    id: fn.id,
    name: fn.name,
    file,
    async: fn.async,
    ...(span ? { span } : {}),
    line: (span?.start[0] ?? 0) + 1,
    steps: s.steps,
    decisions: s.decisions,
    loops: s.loops,
    tries: s.tries,
    awaits: roles.awaits,
    spawns: roles.spawns,
    effects: roles.effects,
    exits: s.exits,
    ...(fromOutside ? { calledFromOutside: true as const } : {}),
    ...(anonymous ? { anonymous: true as const } : {}),
  };
}

/** Calls between files: one row per pair of files and per external or in-scope kind. Calls within a file are dropped. */
function aggregateByFile(rows: Iterable<ScopeCall>, fileOf: (id: string) => string): ScopeCall[] {
  const agg = new Map<string, ScopeCall>();
  for (const r of rows) {
    const from = fileOf(r.from);
    const to = r.external ? (fileOfId(r.to) ?? r.to) : fileOf(r.to);
    if (from === to && !r.external) continue;
    const key = `${from}\0${to}\0${r.external}`;
    const row = agg.get(key);
    if (row) row.count += r.count;
    else agg.set(key, { from, to, count: r.count, external: r.external });
  }
  return [...agg.values()];
}

/** A function is an entry when nothing in the scope calls it and nothing outside does. An anonymous function is never one. */
function entryFunctions(functions: ScopeFunction[], calledInScope: Map<string, Set<string>>, calledFromOutside: Set<string>): string[] {
  return functions.filter((f) => !f.anonymous && !calledInScope.has(f.id) && !calledFromOutside.has(f.id)).map((f) => f.id);
}

/** A file is an entry when no other file in the scope calls into it and nothing outside does. */
function entryFiles(files: ScopeFile[], calledInScope: Map<string, Set<string>>, calledFromOutside: Set<string>, fileOf: (id: string) => string): string[] {
  const reached = new Set<string>();
  for (const [callee, callers] of calledInScope) {
    const home = fileOf(callee);
    for (const c of callers) if (fileOf(c) !== home) reached.add(home);
  }
  for (const f of calledFromOutside) reached.add(fileOf(f));
  return files.filter((f) => !reached.has(f.file)).map((f) => f.file);
}
