import type { IREdge, IRNode } from "@insight/ir";
import type { FunctionFacts } from "./build.js";
import { execModel } from "./exec-model.js";
import { stateWriteSitesFromFacts, unguardedFromSites, type StateWriteSite, type UnguardedState } from "./state-writes.js";

/** The parent of each anonymous function, so a write inside one maps to the thread that runs its owner. */
function lambdaParents(nodes: readonly IRNode[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const n of nodes) {
    if (n.kind === "structure.function" && n.attrs?.anonymous === true && n.parent !== undefined) out.set(n.id, n.parent);
  }
  return out;
}

/**
 * Maps the function that makes a write to the exec threads that reach it. A write inside an anonymous function folds to
 * its owner; module-level code filed under a bare file id maps to the file's module entry when it has one. A write no
 * thread reaches maps to no threads.
 */
function threadMapper(
  threadOf: ReadonlyMap<string, readonly string[]>,
  parents: ReadonlyMap<string, string>,
): (fn: string) => readonly string[] {
  const memo = new Map<string, readonly string[]>();
  return (fn) => {
    const hit = memo.get(fn);
    if (hit !== undefined) return hit;
    const seen = new Set<string>();
    let cur: string | undefined = fn;
    let found: readonly string[] = [];
    while (cur !== undefined && !seen.has(cur)) {
      seen.add(cur);
      const threads = threadOf.get(cur);
      if (threads !== undefined) {
        found = threads;
        break;
      }
      const moduleEntry = threadOf.get(`${cur}#(module)`);
      if (moduleEntry !== undefined) {
        found = moduleEntry;
        break;
      }
      cur = parents.get(cur);
    }
    memo.set(fn, found);
    return found;
  };
}

/** The threads of a project-wide exec model, by the function each reaches. */
function threadsByFunction(model: ReturnType<typeof execModel>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const t of model.threads) {
    for (const id of t.reached) {
      const list = out.get(id);
      if (list) list.push(t.id);
      else out.set(id, [t.id]);
    }
  }
  return out;
}

/**
 * The unguarded variables of a project, computed from charts `factsForFile` already built. The project execution model gives
 * each writer function the threads that reach it; `maxFunctions: Infinity` keeps every thread's function list whole, so no
 * writer loses its thread to the cap.
 */
export function unguardedStateFromFacts(
  facts: Iterable<FunctionFacts>,
  nodes: readonly IRNode[],
  edges: readonly IREdge[],
): UnguardedState {
  const sites: StateWriteSite[] = stateWriteSitesFromFacts(facts);
  if (sites.length === 0) return { variables: new Map(), threads: new Set() };
  const model = execModel(nodes, edges, "", { maxFunctions: Infinity });
  return unguardedFromSites(sites, threadMapper(threadsByFunction(model), lambdaParents(nodes)));
}

