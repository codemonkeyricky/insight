import type { IREdge, IRNode } from "@insight/ir";
import { edgeTargets } from "@insight/sdk";
import { insideScope } from "./scope-map.js";
import { isNoisePath } from "./scope.js";
import { factsForFile } from "./build.js";
import { layoutFunction } from "./layout.js";

/**
 * The execution model of one scope: the threads its code starts, the functions each thread runs, and the
 * coroutines each one awaits. It reads the call, reference, spawn and dispatch facts the flow view reads, but
 * answers "what runs where" rather than "how one file branches".
 *
 * Pure: no I/O and no clock. Edges are sorted by content before use, so the same facts give the same model
 * whatever order they arrive in.
 */

/**
 * Most distinct functions one model lists. Each function is listed once, in the order threads are built, and
 * past the cap later functions are dropped and `truncated` is set. Keeps one scope's JSON to a few hundred KB.
 */
export const MAX_EXEC_FUNCTIONS = 2000;

/** How a spawn starts its thread, as the spawns edge says. */
export type ExecSpawnHow = "thread" | "process" | "async";
/**
 * How a dispatch starts its target. Only await and start make a coroutine; the others run on the same thread, except
 * message, which hands a postMessage to a handler on the other side of a Web Worker boundary.
 */
export type ExecDispatchHow = "await" | "start" | "callback" | "timer" | "microtask" | "message";
export type ExecHow = ExecSpawnHow | ExecDispatchHow;
/** "main" is the thread the program starts on. The others are the spawns of the scope. */
export type ExecThreadKind = "main" | ExecSpawnHow;
/**
 * resolved: some target is a function or script with code in the scope.
 * outside: the spawn has targets, and every one lies outside the scope.
 * unresolved: the frontend found no target, or the target has no code in the IR.
 */
export type ExecSpawnStatus = "resolved" | "outside" | "unresolved";
/**
 * How a function runs. "thread": some thread runs it on its own, through calls, closures or same-thread callbacks.
 * "coroutine": only an awaited or started coroutine runs it. "none": no thread reaches it.
 */
export type ExecRuntime = "thread" | "coroutine" | "none";

/** A function the model names. `file` is "" and `line` 0 for a function the IR has no source for. */
export interface ExecFunctionRef {
  id: string;
  name: string;
  file: string;
  /** 1-based line of the definition. */
  line: number;
  inScope: boolean;
  /** Set for a function in a test, fixture or sample file. */
  noise?: true;
  /** Set for an anonymous function: a function expression, arrow function or lambda with no declaration of its own. */
  anonymous?: true;
  /**
   * Set for a file's module entry, `<file>#(module)`: the code the file runs when it loads. An entry module of an HTML page
   * or of a file no project file imports is a main root (see `execModel`).
   */
  module?: true;
  /** For an anonymous function, the function, or the file for module-level code, it is written in. */
  parent?: string;
  /** How the function runs. See ExecRuntime. */
  runtime: ExecRuntime;
  /**
   * The width and height of the function's control-flow chart, in chart units. Absent when the IR has no chart for it
   * (no steps, or too many to chart). The canvas sizes the function's box to hold the chart.
   */
  chart?: [number, number];
}

/** The spawn that starts a thread. */
export interface ExecSpawn {
  /** The spawn node's id. */
  node: string;
  /** The function, or file, whose code contains the spawn. */
  owner?: string;
  file: string;
  line: number;
  how: ExecSpawnHow;
  status: ExecSpawnStatus;
  /** True when the spawn had several possible targets. */
  candidates: boolean;
  /** The script file a worker runs. Its top-level code starts the thread, so its roots are the functions that code calls. */
  script?: string;
  /** The API the spawn calls, as the IR names it (for example "Worker" or "child_process.execFileSync"). */
  api?: string;
}

/** A function that a thread awaits or starts. */
export interface ExecCoroutine {
  /** The coroutine's function. Each target is listed once per thread. */
  target: string;
  how: "await" | "start";
  /** The coroutine whose code awaits this one. Absent when the thread's own code does. */
  parent?: string;
  /** The functions or files whose dispatch edges start this coroutine. */
  dispatchedBy: string[];
  /** The functions the coroutine reaches by calls, before it awaits another coroutine. The target is not included. */
  callees: string[];
}

/** One thread of the scope: the main thread, or one spawn. */
export interface ExecThread {
  id: string;
  kind: ExecThreadKind;
  /**
   * True when the thread's existence rests on evidence in the IR: every spawn, and a main thread whose roots include a
   * real entry (a program's `main`, or a function named `main`). False for a main thread inferred only from the scope's
   * unreferenced entry functions. A saved model without this field: a main thread is grounded only when a root is named
   * `main`, and every other thread is grounded.
   */
  grounded: boolean;
  spawn?: ExecSpawn;
  /** The functions the thread starts in. */
  roots: string[];
  /** The number of distinct functions the thread runs, roots and coroutines included. Exact even when `reached` is cut. */
  reach: number;
  /** Those functions, sorted by id. Shorter than `reach` only when the model is truncated. */
  reached: string[];
  coroutines: ExecCoroutine[];
  /**
   * The functions this thread reaches only through its coroutines, sorted by id: `reached` without the functions the
   * thread runs on its own. Each one is a coroutine's target or callee. The thread's own functions are `reached`
   * without these.
   */
  coroutineOnly: string[];
}

/** One dispatch edge whose source lies in the scope. */
export interface ExecDispatch {
  /** The function, or file for module-level code, that dispatches. */
  from: string;
  how: ExecDispatchHow;
  targets: string[];
  candidates: boolean;
  file: string;
  line: number;
}

/**
 * A program: a build target that links an executable (targetKind `add_executable` or a `*_binary` rule). Tests and
 * libraries are not programs. Only targets with a file inside the scope are listed.
 */
export interface ExecProgram {
  /** The build target's node id, or `entry:browser` and `entry:node:<file>` for a program an entry makes. */
  id: string;
  name: string;
  /**
   * The rule or command, such as `cc_binary`, `py_binary` or `add_executable`. An entry program says `html-entry` (a
   * browser page) or `node-entry` (a Node script).
   */
  targetKind: string;
  /** The files the target contains, sorted. Not limited to the scope. For an entry program, the files it imports, transitively. */
  files: string[];
  /** The id of a function named `main` defined in one of the program's files (first by id), when the IR has one. */
  main?: string;
  /**
   * Set for a program an entry makes (see `entries`): "browser" for the page scripts of index.html, "node" for one Node
   * script. Absent for a build target.
   */
  kind?: "browser" | "node";
  /**
   * The module entries that start the program's main thread. A browser program holds every page script of index.html;
   * a Node program holds its one script. Absent for a build target, whose main is `main`.
   */
  entries?: string[];
  /**
   * The threads that belong to the program: its own main thread (`main:<id>`) when it has `main`, then every spawn thread
   * whose spawn lies in one of its files or in a function its main thread reaches. A thread can belong to several programs.
   */
  threads: string[];
}

/**
 * A lock or channel the listed functions use. A lock is identified by `attrs.lock` of its `sync.lock-acquire` and
 * `sync.rwlock-acquire` nodes; a channel by `attrs.channel` of its `concurrency.channel-send` and `channel-recv` nodes.
 * A resource is listed when one of its sites lies in a listed function.
 */
export interface ExecResource {
  /** `lock:<identity>` or `channel:<identity>`. */
  id: string;
  kind: "lock" | "channel";
  /** The identity the IR gives the lock or channel. */
  name: string;
  /** The threads that run a function with a site, in thread order. Empty when only unthreaded functions use it. */
  threads: string[];
  /** Every site in a listed function, sorted by fn, then line. */
  sites: ExecResourceSite[];
}

/** One operation on a resource, in the function that performs it. */
export interface ExecResourceSite {
  /** The function that performs the operation. */
  fn: string;
  /** `acquire` for a lock, `send` or `recv` for a channel. */
  op: "acquire" | "send" | "recv";
  file: string;
  /** 1-based line. 0 when the node has no span. */
  line: number;
}

/** Counts over the listed model. */
export interface ExecModelStats {
  threads: number;
  spawns: number;
  /** The programs the model lists. */
  programs: number;
  resolved: number;
  outside: number;
  unresolved: number;
  candidates: number;
  coroutines: number;
  dispatches: number;
  /** The lock resources the model lists. */
  locks: number;
  /** The channel resources the model lists. */
  channels: number;
  /** Functions whose file lies in the scope. */
  functionsInScope: number;
  /** Of those, the ones some thread runs, coroutines included. */
  functionsThreaded: number;
  /**
   * Of those, the ones only a coroutine runs: an awaited or started function that no thread runs on its own. A subset
   * of `functionsThreaded`.
   */
  functionsCoroutineOnly: number;
  /**
   * Of those, the ones no thread runs. A function called only from module-level code, such as a script's `main()`
   * call at the bottom of the file, is in this count: it is referenced by its file, so it is no thread's root.
   */
  functionsUnthreaded: number;
  /** The distinct functions the model lists. */
  functionsListed: number;
}

export interface ExecModel {
  scope: string;
  /** True when the function cap cut a list. */
  truncated: boolean;
  /** Every function the model names, each once. Thread and coroutine lists refer to these by id. */
  functions: ExecFunctionRef[];
  /**
   * The general main thread first, then one main thread per program that has `main` (sorted by program id), then one
   * thread per spawn in scope, sorted by spawn id.
   */
  threads: ExecThread[];
  /** The programs in scope, sorted by id. Empty when the IR has no build targets. */
  programs: ExecProgram[];
  dispatches: ExecDispatch[];
  /**
   * The calls and references between listed functions, as index pairs into `functions`: [caller, callee]. Closures
   * count, except a closure that is a spawn or dispatch target. Each pair once, sorted, with no self-calls. Index
   * pairs keep the JSON small, since a scope can have thousands.
   */
  calls: [number, number][];
  /**
   * The in-scope functions no thread runs (runtime "none"), sorted by id. Test, fixture and sample functions are left
   * out unless the scope is one of those. Listed after the threads, so the cap cuts these first.
   */
  unthreaded: string[];
  /** The locks and channels the listed functions use, sorted by id. Empty when the IR has no such nodes. */
  resources: ExecResource[];
  stats: ExecModelStats;
}

export interface ExecModelOptions {
  /** Overrides MAX_EXEC_FUNCTIONS. Tests use small values to exercise truncation. */
  maxFunctions?: number;
  /**
   * `lambdas: true` keeps anonymous functions as functions of their own. The default folds each one into the function
   * (or, for module-level code, the file) it is written in: its calls, closures, spawns and dispatches belong to the owner,
   * and it is never listed.
   */
  lambdas?: boolean;
}

interface Fn {
  id: string;
  name: string;
  file: string | undefined;
  line: number;
  inScope: boolean;
  noise: boolean;
  anonymous: boolean;
  parent: string | undefined;
  /** A file's module entry. See ExecFunctionRef.module. */
  module: boolean;
  /** A module entry an HTML page loads with a script tag. */
  htmlEntry: boolean;
  /** A module entry of a Node script (see the frontend's nodeEntry). Only an entry when no project file imports it. */
  nodeEntry: boolean;
}

interface Dispatch {
  how: ExecDispatchHow;
  targets: string[];
  candidates: boolean;
  file: string;
  line: number;
}

interface Spawns {
  targets: Set<string>;
  candidates: boolean;
  how: ExecSpawnHow | undefined;
}

interface Plan {
  kind: ExecThreadKind;
  id: string;
  spawn?: ExecSpawn;
  roots: string[];
  /** Every function the thread runs, coroutines included. */
  reach: Set<string>;
  /** The functions the thread runs on its own: calls, closures and same-thread callbacks. */
  plain: Set<string>;
  coroutines: ExecCoroutine[];
}

const SPAWN_KINDS: ReadonlySet<string> = new Set(["concurrency.spawn-thread", "concurrency.spawn-process"]);
const DISPATCH_HOWS: readonly ExecDispatchHow[] = ["await", "start", "callback", "timer", "microtask", "message"];
const SPAWN_HOWS: readonly ExecSpawnHow[] = ["thread", "process", "async"];

/** The sync and channel nodes that are resource sites: the node kind, what it does, and the attribute naming the resource. */
const RESOURCE_SITES: Readonly<Record<string, { kind: ExecResource["kind"]; op: ExecResourceSite["op"]; attr: string }>> = {
  "sync.lock-acquire": { kind: "lock", op: "acquire", attr: "lock" },
  "sync.rwlock-acquire": { kind: "lock", op: "acquire", attr: "lock" },
  // The C++ frontend's RAII guards (lock_guard, unique_lock, scoped_lock, shared_lock). The kind extends
  // sync.lock-acquire in frontend-cpp's kinds.json, but the model reads raw kinds with no registry, so it is named here.
  "x-cpp.scoped-lock": { kind: "lock", op: "acquire", attr: "lock" },
  "concurrency.channel-send": { kind: "channel", op: "send", attr: "channel" },
  "concurrency.channel-recv": { kind: "channel", op: "recv", attr: "channel" },
};

/** The last path segment of a file: the name a module entry's card shows, with its "top level" tag beside it. */
const basenameOf = (file: string): string => file.slice(file.lastIndexOf("/") + 1);

/** Code-unit order, so sorts do not depend on the locale. */
const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function pick<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return allowed.find((a) => a === value);
}

function strAttr(attrs: Readonly<Record<string, unknown>> | undefined, key: string): string | undefined {
  const v = attrs?.[key];
  return typeof v === "string" ? v : undefined;
}

/** Await and start make a coroutine. The other dispatches run on the dispatching thread. */
const isCoroutine = (how: ExecDispatchHow): boolean => how === "await" || how === "start";

/** A sort key that covers everything the model reads from an edge, so the order is fixed by content alone. */
function edgeKey(e: IREdge): string {
  return [e.kind, e.from, JSON.stringify(e.to), e.span?.file ?? "", e.span?.start.join(":") ?? "", JSON.stringify(e.attrs ?? {})].join("\0");
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  const list = m.get(k);
  if (list) list.push(v);
  else m.set(k, [v]);
}

/** The functions reached from `roots` through `next`, roots included. Iterative, so cycles are safe. */
function reachBy(roots: readonly string[], next: (id: string) => readonly string[]): Set<string> {
  const seen = new Set(roots);
  const stack = [...roots];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    for (const to of next(cur)) {
      if (!seen.has(to)) {
        seen.add(to);
        stack.push(to);
      }
    }
  }
  return seen;
}

export function execModel(nodes: readonly IRNode[], edges: readonly IREdge[], scope: string, opts: ExecModelOptions = {}): ExecModel {
  const max = opts.maxFunctions ?? MAX_EXEC_FUNCTIONS;
  const fold = opts.lambdas !== true;
  // The parent of each anonymous function, so a lambda folds to its owner: a function, or the file for module-level code.
  const lambdaParent = new Map<string, string>();
  if (fold) {
    for (const n of nodes) if (n.kind === "structure.function" && n.attrs?.anonymous === true && n.parent !== undefined) lambdaParent.set(n.id, n.parent);
  }
  const foldId = (id: string): string => {
    if (!fold) return id;
    let cur = id;
    for (let hops = 0; hops <= lambdaParent.size; hops++) {
      const up = lambdaParent.get(cur);
      if (up === undefined) break;
      cur = up;
    }
    return cur;
  };
  // A scope inside a test, fixture or sample folder shows its test code as roots. isNoisePath reads folders
  // from a path's parents, so a folder needs a trailing slash to count its own name, and a file needs its base name.
  const scopeNoise = isNoisePath(scope) || isNoisePath(`${scope}/`);

  const byId = new Map<string, IRNode>();
  const fns = new Map<string, Fn>();
  for (const n of nodes) {
    byId.set(n.id, n);
    if (n.kind !== "structure.function") continue;
    const file = n.span?.file;
    const anonymous = n.attrs?.anonymous === true;
    if (fold && anonymous) continue;
    fns.set(n.id, {
      id: n.id,
      name: n.attrs?.module === true && file !== undefined ? basenameOf(file) : (strAttr(n.attrs, "name") ?? (n.id.split("#")[1] ?? n.id)),
      file,
      line: n.span ? n.span.start[0] + 1 : 0,
      inScope: file !== undefined && insideScope(file, scope),
      noise: file !== undefined && isNoisePath(file),
      anonymous,
      parent: anonymous ? n.parent : undefined,
      module: n.attrs?.module === true,
      htmlEntry: n.attrs?.htmlEntry === true,
      nodeEntry: n.attrs?.nodeEntry === true,
    });
  }

  // The file an id stands for. A function or spawn node gives its own file, or its owner's when it has no span.
  // An id with no node is a file, as module-level code's id is.
  const fileOf = (id: string): string | undefined => {
    const fn = fns.get(id);
    if (fn) return fn.file;
    const node = byId.get(id);
    if (!node) return id;
    if (node.span) return node.span.file;
    const owner = node.parent;
    if (owner === undefined) return undefined;
    const ownerFn = fns.get(owner);
    return ownerFn ? ownerFn.file : owner;
  };
  const inScopeId = (id: string): boolean => {
    const file = fileOf(id);
    return file !== undefined && insideScope(file, scope);
  };
  const noiseId = (id: string): boolean => {
    const file = fileOf(id);
    return file !== undefined && isNoisePath(file);
  };

  // Each edge with its targets, in content order.
  const keyed = edges
    .map((e) => ({ e, k: edgeKey(e) }))
    .sort((a, b) => byText(a.k, b.k))
    .map(({ e }) => {
      const t = edgeTargets(e);
      return { e, ids: [...t.nodes, ...t.candidates].map(foldId), candidates: t.candidates.length > 0 };
    });

  // Adjacency covers the whole IR, so a thread's reach does not depend on the scope it is seen from.
  // The targets of every spawn and dispatch in the IR. A closure that is one of them is not its creator's to run:
  // a spawned lambda runs on its own thread, and an awaited one is a coroutine.
  const boundary = new Set<string>();
  for (const { e, ids } of keyed) {
    if (e.kind === "concurrency.spawns" || e.kind === "concurrency.dispatches") for (const id of ids) boundary.add(id);
  }

  const callOut = new Map<string, Set<string>>();
  const closureOut = new Map<string, Set<string>>();
  const dispatchOut = new Map<string, Dispatch[]>();
  const spawnsOf = new Map<string, Spawns>();
  const dispatchSites: Array<Dispatch & { from: string }> = [];
  // A function is referenced when a caller in the scope names it. A reference from outside the scope does not
  // count, so a function the scope's own code never calls is a root of the scope even when another folder calls it.
  // Test, fixture and sample code counts only in a noise scope, as its functions are roots only there.
  const referenced = new Set<string>();

  for (const { e, ids, candidates } of keyed) {
    const from = foldId(e.from);
    const local = inScopeId(from);
    const counted = local && (scopeNoise || !noiseId(from));
    if (e.kind === "calls.call" || e.kind === "calls.reference") {
      const closure = e.kind === "calls.reference" && strAttr(e.attrs, "how") === "closure";
      const out = closure ? closureOut : callOut;
      const callees = out.get(from) ?? new Set<string>();
      for (const to of ids) if (fns.has(to)) callees.add(to);
      out.set(from, callees);
      if (counted) for (const to of ids) if (to !== from) referenced.add(to);
    } else if (e.kind === "concurrency.dispatches") {
      const d: Dispatch = {
        how: pick(e.attrs?.how, DISPATCH_HOWS) ?? "callback",
        targets: ids.filter((id) => fns.has(id)),
        candidates,
        file: e.span?.file ?? "",
        line: e.span ? e.span.start[0] + 1 : 0,
      };
      push(dispatchOut, from, d);
      if (local) dispatchSites.push({ from, ...d });
      if (counted) for (const to of ids) if (to !== from) referenced.add(to);
    } else if (e.kind === "concurrency.spawns") {
      const s = spawnsOf.get(from) ?? { targets: new Set<string>(), candidates: false, how: undefined };
      for (const to of ids) s.targets.add(to);
      s.candidates = s.candidates || candidates;
      s.how = s.how ?? pick(e.attrs?.how, SPAWN_HOWS);
      spawnsOf.set(from, s);
      if (counted) for (const to of ids) referenced.add(to);
    }
  }

  /** Calls and references from `id`, closures included unless the closure is a spawn or dispatch target. */
  const callsOf = (id: string): string[] => {
    const out = [...(callOut.get(id) ?? [])];
    for (const to of closureOut.get(id) ?? []) if (!boundary.has(to)) out.push(to);
    return out;
  };
  /** Full reach: calls, closures and every dispatch. Spawns start other threads, so they are not followed. */
  const neighbours = (id: string): string[] => [...callsOf(id), ...(dispatchOut.get(id) ?? []).flatMap((d) => d.targets)];
  /** Plain reach: the same, except that awaited and started coroutines are left out, since they are not run on the thread's own. */
  const plainNeighbours = (id: string): string[] => [
    ...callsOf(id),
    ...(dispatchOut.get(id) ?? []).filter((d) => !isCoroutine(d.how)).flatMap((d) => d.targets),
  ];

  /**
   * The coroutines of one thread. Each target is listed once, and a target already listed is not expanded again,
   * which is what cuts a cycle of awaits. Callees stop at the next await, so each coroutine's own list stays
   * flat, and the nesting is in `parent`.
   */
  const coroutinesOf = (roots: readonly string[]): ExecCoroutine[] => {
    const out: ExecCoroutine[] = [];
    const byTarget = new Map<string, ExecCoroutine>();
    const explore = (entries: readonly string[], parent: string | undefined): Set<string> => {
      const region = new Set(entries);
      const stack = [...entries];
      while (stack.length > 0) {
        const cur = stack.pop() as string;
        for (const next of callsOf(cur)) {
          if (!region.has(next)) {
            region.add(next);
            stack.push(next);
          }
        }
        for (const d of dispatchOut.get(cur) ?? []) {
          for (const target of d.targets) {
            if (isCoroutine(d.how)) {
              const known = byTarget.get(target);
              if (known) {
                if (!known.dispatchedBy.includes(cur)) known.dispatchedBy.push(cur);
                continue;
              }
              const co: ExecCoroutine = {
                target,
                how: d.how === "await" ? "await" : "start",
                ...(parent !== undefined ? { parent } : {}),
                dispatchedBy: [cur],
                callees: [],
              };
              byTarget.set(target, co);
              out.push(co);
              co.callees = [...explore([target], target)].filter((x) => x !== target).sort(byText);
            } else if (!region.has(target)) {
              region.add(target);
              stack.push(target);
            }
          }
        }
      }
      return region;
    };
    explore(roots, undefined);
    for (const co of out) co.dispatchedBy.sort(byText);
    return out;
  };

  // Programs: the build targets that link an executable, with the files they contain. Their `main` is the root of
  // the program's own main thread, so it is taken out of the general main thread's roots below.
  const contains = new Map<string, Set<string>>();
  for (const e of edges) {
    if (e.kind !== "packaging.target-contains") continue;
    const files = contains.get(e.from) ?? new Set<string>();
    for (const file of edgeTargets(e).nodes) files.add(file);
    contains.set(e.from, files);
  }
  const programs: ExecProgram[] = [];
  for (const n of nodes) {
    if (n.kind !== "packaging.build-target") continue;
    const targetKind = strAttr(n.attrs, "targetKind");
    if (targetKind === undefined || !(targetKind === "add_executable" || targetKind.endsWith("_binary"))) continue;
    const files = [...(contains.get(n.id) ?? [])].sort(byText);
    if (!files.some((f) => insideScope(f, scope))) continue;
    // A program built only from test, fixture or sample files is left out unless the scope is one of those, as their
    // functions are left out of the main roots: at a project's root, every test binary and fixture would crowd it.
    if (!scopeNoise && files.every((f) => isNoisePath(f))) continue;
    const inFiles = new Set(files);
    const main = [...fns.values()]
      .filter((f) => f.name === "main" && f.file !== undefined && inFiles.has(f.file))
      .map((f) => f.id)
      .sort(byText)[0];
    programs.push({
      id: n.id,
      name: strAttr(n.attrs, "name") ?? n.id,
      targetKind,
      files,
      ...(main !== undefined ? { main } : {}),
      threads: [],
    });
  }
  // Entry programs. A TS project has no build targets, so its programs come from its entries. Every index.html script is
  // a page script of ONE browser program, and each Node script that no project file imports is a program of its own. A
  // program's files are what its entries import, transitively. Test, fixture and sample files are never entries.
  const scriptFiles = new Set<string>();
  for (const { e, ids } of keyed) {
    if (e.kind === "concurrency.spawns") for (const id of ids) scriptFiles.add(fileOf(id) ?? id);
  }
  const importedFiles = new Set<string>();
  const importsOf = new Map<string, string[]>();
  for (const e of edges) {
    if (e.kind !== "packaging.import" && e.kind !== "packaging.re-export") continue;
    for (const to of edgeTargets(e).nodes) {
      if (to === e.from) continue;
      importedFiles.add(to);
      push(importsOf, e.from, to);
    }
  }
  const entryFns = [...fns.values()].filter(
    (f) => f.module && f.inScope && f.file !== undefined && !isNoisePath(f.file) && !f.file.endsWith(".d.ts") && !scriptFiles.has(f.file),
  );
  const browserFns = entryFns.filter((f) => f.htmlEntry);
  const nodeFns = entryFns
    .filter((f) => !f.htmlEntry && f.nodeEntry && !importedFiles.has(f.file ?? ""))
    .sort((a, b) => byText(a.file ?? "", b.file ?? ""));
  const entryMode = browserFns.length > 0 || nodeFns.length > 0;
  const closureOf = (start: readonly string[]): string[] => [...reachBy(start, (f) => importsOf.get(f) ?? [])].sort(byText);
  if (browserFns.length > 0) {
    programs.push({
      id: "entry:browser",
      name: "index.html",
      targetKind: "html-entry",
      files: closureOf(browserFns.map((f) => f.file ?? "")),
      kind: "browser",
      entries: browserFns.map((f) => f.id).sort(byText),
      threads: [],
    });
  }
  for (const f of nodeFns) {
    const file = f.file ?? "";
    programs.push({ id: `entry:node:${file}`, name: file, targetKind: "node-entry", files: closureOf([file]), kind: "node", entries: [f.id], threads: [] });
  }
  programs.sort((a, b) => byText(a.id, b.id));
  const programMains = new Set(programs.flatMap((p) => (p.main !== undefined ? [p.main] : [])));

  // Without any entry, the fallback roots stand: every unreferenced function, and a module entry that no project file
  // imports (or an HTML page loads). With entries, only the entries are roots: an unreferenced function runs on no thread.
  const fallbackEntryModules = entryMode
    ? []
    : [...fns.values()]
        .filter(
          (f) =>
            f.module &&
            f.inScope &&
            (scopeNoise || !f.noise) &&
            f.file !== undefined &&
            !f.file.endsWith(".d.ts") &&
            !scriptFiles.has(f.file) &&
            (f.htmlEntry || !importedFiles.has(f.file)),
        )
        .map((f) => f.id);

  // An anonymous function is never a main root: whatever runs it is its creator, a spawn or a dispatch.
  const mainRoots = entryMode
    ? []
    : [
        ...[...fns.values()]
          .filter((f) => f.inScope && !f.anonymous && !f.module && !referenced.has(f.id) && (scopeNoise || !f.noise) && !programMains.has(f.id))
          .map((f) => f.id),
        ...fallbackEntryModules,
      ].sort(byText);
  const planOf = (kind: ExecThreadKind, id: string, roots: string[], spawn?: ExecSpawn): Plan => ({
    kind,
    id,
    ...(spawn !== undefined ? { spawn } : {}),
    roots,
    reach: reachBy(roots, neighbours),
    plain: reachBy(roots, plainNeighbours),
    coroutines: coroutinesOf(roots),
  });
  // The general main thread exists only without entries. Each program has its own main thread: from its `main` function,
  // or from its entry modules.
  const plans: Plan[] = entryMode ? [] : [planOf("main", "main", mainRoots)];
  const programPlans = new Map<string, Plan>();
  for (const p of programs) {
    const roots = p.main !== undefined ? [p.main] : (p.entries ?? []);
    if (roots.length === 0) continue;
    const plan = planOf("main", `main:${p.id}`, roots);
    programPlans.set(p.id, plan);
    plans.push(plan);
  }

  // Spawn threads are not filtered by noise. A spawn in a test file is still a fact of the code, and filtering it
  // would make a scope's threads depend on whether the scope is noise, which breaks monotonicity across scopes.
  const spawnNodes = nodes
    .filter((n) => SPAWN_KINDS.has(n.kind) && inScopeId(n.id))
    .sort((a, b) => byText(a.id, b.id));
  for (const n of spawnNodes) {
    const s = spawnsOf.get(n.id);
    const targets = s ? [...s.targets].sort(byText) : [];
    // A target that is not a function is a script file. Its top-level code runs the thread, so its callees are the roots.
    const roots = new Set<string>();
    let script: string | undefined;
    for (const t of targets) {
      if (fns.has(t)) {
        roots.add(t);
        continue;
      }
      script = t;
      for (const c of callsOf(t)) roots.add(c);
    }
    const rootList = [...roots].sort(byText);
    const status: ExecSpawnStatus =
      rootList.length === 0 ? "unresolved" : rootList.some((r) => fns.get(r)?.inScope === true) ? "resolved" : "outside";
    const how: ExecSpawnHow = s?.how ?? (n.kind === "concurrency.spawn-process" ? "process" : "thread");
    const spawn: ExecSpawn = {
      node: n.id,
      file: fileOf(n.id) ?? "",
      line: n.span ? n.span.start[0] + 1 : 0,
      how,
      status,
      candidates: s?.candidates ?? false,
      ...(n.parent !== undefined ? { owner: foldId(n.parent) } : {}),
      ...(script !== undefined ? { script } : {}),
      ...(strAttr(n.attrs, "api") !== undefined ? { api: strAttr(n.attrs, "api") } : {}),
    };
    plans.push(planOf(how, n.id, rootList, spawn));
  }

  // A program's threads: its main thread, and each spawn that lies in one of its files or in a function its main reaches.
  for (const prog of programs) {
    const own = programPlans.get(prog.id);
    const inFiles = new Set(prog.files);
    const threadIds: string[] = own !== undefined ? [own.id] : [];
    for (const p of plans) {
      const s = p.spawn;
      if (s === undefined) continue;
      const viaFile = inFiles.has(s.file);
      const viaMain = own !== undefined && s.owner !== undefined && own.reach.has(s.owner);
      if (viaFile || viaMain) threadIds.push(p.id);
    }
    prog.threads = threadIds;
  }

  // A function runs on a thread when some thread reaches it on its own, and as a coroutine when only a coroutine does.
  const reachedOnThread = new Set<string>();
  const reachedAll = new Set<string>();
  for (const p of plans) {
    for (const id of p.plain) reachedOnThread.add(id);
    for (const id of p.reach) reachedAll.add(id);
  }
  const runtimeOf = (id: string): ExecRuntime => (reachedOnThread.has(id) ? "thread" : reachedAll.has(id) ? "coroutine" : "none");

  // The function table. Threads are cut in order, so the first threads keep their full lists when the cap is hit.
  const table = new Map<string, ExecFunctionRef>();
  let truncated = false;
  // Chart sizes by file, computed on first use: the chart layout is cheap, but only files with a listed function need it.
  const chartSizes = new Map<string, Map<string, [number, number]>>();
  const chartOf = (file: string, id: string): [number, number] | undefined => {
    if (file === "") return undefined;
    let sizes = chartSizes.get(file);
    if (sizes === undefined) {
      sizes = new Map();
      for (const f of factsForFile(file, nodes, edges).map(layoutFunction)) {
        if (!f.tooLarge && f.nodes.length > 0) sizes.set(f.id, [f.width, f.height]);
      }
      chartSizes.set(file, sizes);
    }
    return sizes.get(id);
  };
  const take = (id: string): boolean => {
    if (table.has(id)) return true;
    const fn = fns.get(id);
    if (!fn) return false;
    if (table.size >= max) {
      truncated = true;
      return false;
    }
    const chart = chartOf(fn.file ?? "", id);
    table.set(id, {
      id,
      name: fn.name,
      file: fn.file ?? "",
      line: fn.line,
      inScope: fn.inScope,
      ...(fn.noise ? { noise: true as const } : {}),
      ...(fn.anonymous ? { anonymous: true as const, ...(fn.parent !== undefined ? { parent: fn.parent } : {}) } : {}),
      ...(fn.module ? { module: true as const } : {}),
      runtime: runtimeOf(id),
      ...(chart !== undefined ? { chart } : {}),
    });
    return true;
  };

  const threads: ExecThread[] = plans.map((p) => {
    const roots = p.roots.filter(take);
    const reached = [...p.reach].sort(byText).filter(take);
    // A subset of `reached`, so every id was already offered to the table: filter by it instead of taking again.
    const coroutineOnly = [...p.reach]
      .filter((id) => !p.plain.has(id))
      .sort(byText)
      .filter((id) => table.has(id));
    const coroutines: ExecCoroutine[] = [];
    for (const co of p.coroutines) {
      if (!take(co.target)) continue;
      coroutines.push({ ...co, callees: co.callees.filter(take) });
    }
    // A main thread is grounded when a root is a program's main, a function named `main`, or a module entry; a spawn always is.
    const grounded = p.kind !== "main" || p.roots.some((r) => programMains.has(r) || fns.get(r)?.name === "main" || fns.get(r)?.module === true);
    return {
      id: p.id,
      kind: p.kind,
      grounded,
      ...(p.spawn !== undefined ? { spawn: p.spawn } : {}),
      roots,
      reach: p.reach.size,
      reached,
      coroutines,
      coroutineOnly,
    };
  });

  const dispatches: ExecDispatch[] = dispatchSites.map((d) => ({
    from: d.from,
    how: d.how,
    targets: d.targets.filter(take),
    candidates: d.candidates,
    file: d.file,
    line: d.line,
  }));

  // Taken after the threads and dispatches, so the cap cuts these first.
  const unthreaded = [...fns.values()]
    .filter((f) => f.inScope && (scopeNoise || !f.noise) && runtimeOf(f.id) === "none")
    .map((f) => f.id)
    .sort(byText)
    .filter(take);

  // The table is final here. Callers that are files, not functions, are never in it.
  const listed = [...table.keys()];
  const indexOf = new Map(listed.map((id, i) => [id, i]));
  const pairs = new Set<string>();
  const calls: [number, number][] = [];
  listed.forEach((a, i) => {
    for (const b of callsOf(a)) {
      const j = indexOf.get(b);
      if (j === undefined || b === a) continue;
      const key = `${i}:${j}`;
      if (pairs.has(key)) continue;
      pairs.add(key);
      calls.push([i, j]);
    }
  });
  calls.sort((x, y) => x[0] - y[0] || x[1] - y[1]);

  // Locks and channels. A site is an acquire, send or receive whose parent is a listed function: module-level code
  // (a file parent) runs on no thread, so it is not a site. The resource's threads are the threads that reach a site.
  const sitesOf = new Map<string, { kind: ExecResource["kind"]; name: string; sites: ExecResourceSite[] }>();
  for (const n of nodes) {
    const spec = RESOURCE_SITES[n.kind];
    if (spec === undefined) continue;
    const fn = n.parent === undefined ? undefined : foldId(n.parent);
    if (fn === undefined || !fns.has(fn) || !table.has(fn)) continue;
    const name = strAttr(n.attrs, spec.attr);
    if (name === undefined || name === "") continue;
    const id = `${spec.kind}:${name}`;
    const r = sitesOf.get(id) ?? { kind: spec.kind, name, sites: [] };
    r.sites.push({ fn, op: spec.op, file: n.span?.file ?? "", line: n.span ? n.span.start[0] + 1 : 0 });
    sitesOf.set(id, r);
  }
  const reachSets = threads.map((t) => ({ id: t.id, reached: new Set(t.reached) }));
  const resources: ExecResource[] = [...sitesOf]
    .map(([id, r]) => {
      const sites = r.sites.sort((a, b) => byText(a.fn, b.fn) || a.line - b.line || byText(a.op, b.op) || byText(a.file, b.file));
      return {
        id,
        kind: r.kind,
        name: r.name,
        threads: reachSets.filter((t) => sites.some((s) => t.reached.has(s.fn))).map((t) => t.id),
        sites,
      };
    })
    .sort((a, b) => byText(a.id, b.id));

  const inScopeFns = [...fns.values()].filter((f) => f.inScope);
  const functionsThreaded = inScopeFns.filter((f) => reachedAll.has(f.id)).length;
  const functionsCoroutineOnly = inScopeFns.filter((f) => runtimeOf(f.id) === "coroutine").length;
  const spawned = plans.flatMap((p) => (p.spawn !== undefined ? [p.spawn] : []));
  const countStatus = (s: ExecSpawnStatus) => spawned.filter((x) => x.status === s).length;

  return {
    scope,
    truncated,
    functions: [...table.values()],
    threads,
    programs,
    dispatches,
    calls,
    unthreaded,
    resources,
    stats: {
      threads: threads.length,
      spawns: spawned.length,
      programs: programs.length,
      resolved: countStatus("resolved"),
      outside: countStatus("outside"),
      unresolved: countStatus("unresolved"),
      candidates: spawned.filter((x) => x.candidates).length,
      coroutines: threads.reduce((n, t) => n + t.coroutines.length, 0),
      dispatches: dispatches.length,
      locks: resources.filter((r) => r.kind === "lock").length,
      channels: resources.filter((r) => r.kind === "channel").length,
      functionsInScope: inScopeFns.length,
      functionsThreaded,
      functionsCoroutineOnly,
      functionsUnthreaded: inScopeFns.length - functionsThreaded,
      functionsListed: table.size,
    },
  };
}
