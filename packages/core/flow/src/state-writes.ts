import type { IREdge, IRNode } from "@insight/ir";
import { factsForFile, type FunctionFacts, type Item } from "./build.js";
import { stateIndex } from "./coupling.js";
import { moduleMap } from "./modules.js";

/** One write of a mutable variable, by the function that makes it and the locks held there. */
export interface StateWriteSite {
  /** The function (or file, for module-level code) whose chart holds the write. */
  fn: string;
  /** The data.variable node's id. */
  variable: string;
  /** The variable's name, for a thread box's badge. */
  name: string;
  /** The names of the locks held at the write, sorted. Empty when the write holds none. */
  locks: string[];
}

/** One mutable variable written from two or more threads with no lock held in common at every write. */
export interface UnguardedVariable {
  /** The data.variable node's id. */
  id: string;
  name: string;
  /** The exec thread ids that write it, sorted. */
  threads: string[];
}

/** The project's unguarded shared state, and the threads that write it. */
export interface UnguardedState {
  variables: ReadonlyMap<string, UnguardedVariable>;
  /** The exec thread ids that write some unguarded variable. */
  threads: ReadonlySet<string>;
}

/** A lock frame's lock name, when the item is one. */
function heldName(item: Item): string | undefined {
  return item.t === "fork" && item.role === "lock" ? item.lock : undefined;
}

/** Walks a chart's items, collecting each state write with the locks held above it. Lock frames hold their arms' rows. */
function walk(items: readonly Item[], held: readonly string[], fn: string, out: StateWriteSite[]): void {
  for (const item of items) {
    if (item.t === "step") {
      if (item.role === "state" && item.state !== undefined && item.state.write) {
        out.push({ fn, variable: item.state.variable, name: item.label.replace(/^▲\s*/, ""), locks: [...held].sort() });
      }
      continue;
    }
    if (item.t === "fork") {
      const lock = heldName(item);
      const inner = lock === undefined ? held : [...held, lock];
      for (const arm of item.arms) walk(arm.body, inner, fn, out);
      continue;
    }
    if (item.t === "loop") walk(item.body, held, fn, out);
  }
}

/** Every write of a mutable variable in the project, from charts already built by `factsForFile`. */
export function stateWriteSitesFromFacts(facts: Iterable<FunctionFacts>): StateWriteSite[] {
  const out: StateWriteSite[] = [];
  for (const f of facts) walk(f.items, [], f.id, out);
  return out;
}

/**
 * Every write of a mutable variable in the project, from IR records. Files' charts are rebuilt the way the flow view builds
 * them, so a write sits under the same lock frames. Returns nothing when the IR has no `data.write` edge, so a project
 * without the data facet pays only one scan of the edges.
 */
export function stateWriteSites(nodes: readonly IRNode[], edges: readonly IREdge[]): StateWriteSite[] {
  let any = false;
  for (const e of edges) {
    if (e.kind === "data.write") {
      any = true;
      break;
    }
  }
  if (!any) return [];
  const modules = moduleMap(nodes);
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
    if ((e.kind !== "data.read" && e.kind !== "data.write") || !e.span) continue;
    const list = byFileEdges.get(e.span.file);
    if (list) list.push(e);
    else byFileEdges.set(e.span.file, [e]);
  }
  const out: StateWriteSite[] = [];
  for (const [file, ns] of byFileNodes) {
    const facts = factsForFile(file, ns, byFileEdges.get(file) ?? [], { state });
    for (const site of stateWriteSitesFromFacts(facts)) out.push(site);
  }
  return out;
}

/**
 * The unguarded variables among some write sites: a variable with writes from two or more distinct threads whose held-lock
 * sets have an empty intersection. A write that holds no lock empties the intersection. A write no thread runs is not
 * counted. `threadsOf` maps the function that makes a write to the exec threads that reach it.
 */
export function unguardedFromSites(
  sites: readonly StateWriteSite[],
  threadsOf: (fn: string) => readonly string[],
): UnguardedState {
  interface Acc {
    name: string;
    threads: Set<string>;
    held: Set<string> | undefined;
  }
  const acc = new Map<string, Acc>();
  for (const site of sites) {
    const threads = threadsOf(site.fn);
    if (threads.length === 0) continue;
    let a = acc.get(site.variable);
    if (a === undefined) {
      a = { name: site.name, threads: new Set(), held: undefined };
      acc.set(site.variable, a);
    }
    for (const t of threads) a.threads.add(t);
    if (a.held === undefined) a.held = new Set(site.locks);
    else for (const lock of a.held) if (!site.locks.includes(lock)) a.held.delete(lock);
  }
  const variables = new Map<string, UnguardedVariable>();
  const threadSet = new Set<string>();
  for (const [id, a] of acc) {
    if (a.threads.size < 2 || (a.held?.size ?? 0) > 0) continue;
    const threads = [...a.threads].sort();
    variables.set(id, { id, name: a.name, threads });
    for (const t of threads) threadSet.add(t);
  }
  return { variables, threads: threadSet };
}
