// The exported-function call graph of the Symbols tab. Pure: it reads a ProjectModel and answers, for one exported function,
// the exported functions it reaches (its callees) or the exported functions that reach it (its callers). An internal (not
// exported) function is a helper: the walk follows through it and stops at the first exported function on each path.
// Lambdas fold into their owner, as refsOf does, and a spawned thread or process folds into the function that starts it.
// A maybe link is an interface-dispatch candidate, or a reference that does not invoke its target (a value, a closure).
import { anonymousOwned, INVOKING_HOWS, ownerOf, type ProjectModel, type Rel } from "@insight/model";
import { inScope } from "../router";

/** How far a walk goes, in calls: a path longer than this (through helpers) is not followed. */
export const SYMBOLS_MAX_DEPTH = 8;

/** An exported function, as the start list names it. */
export interface ExportedSymbol {
  id: string;
  name: string;
  file: string;
}

/**
 * One exported function a function reaches (a callee) or is reached by (a caller). `via` is the first helper on the shortest
 * path, when the path goes through one; `candidate` is true only when every path to it is a maybe.
 */
export interface SymbolLink extends ExportedSymbol {
  via?: string;
  candidate: boolean;
}

/** Whether a node is an exported function of the project: exported, and not an external stub. */
export function isExportedFunction(model: ProjectModel, id: string): boolean {
  const node = model.byId.get(id);
  return model.functionById.has(id) && node?.attrs.exported === true && node.attrs.external !== true;
}

/** Whether a function is a function of the project that can be walked: a known function that is not an external stub. */
function isWalkable(model: ProjectModel, id: string): boolean {
  return model.functionById.has(id) && model.byId.get(id)?.attrs.external !== true;
}

/**
 * Whether a relation is a maybe: an interface-dispatch candidate, or a reference that does not invoke its target (the function
 * is passed around as a value, not called). The same rule as the caller chain's "possible" (callers.ts).
 */
function isMaybe(rel: Rel): boolean {
  return rel.candidate || (rel.kind === "reference" && !INVOKING_HOWS.has(rel.how ?? ""));
}

function isSpawnKind(kind: string): boolean {
  return kind === "concurrency.spawn-thread" || kind === "concurrency.spawn-process";
}

/** The exported functions of a scope (the whole project for the empty scope), in file then line order. */
export function exportedFunctions(model: ProjectModel, scope: string): ExportedSymbol[] {
  const out: ExportedSymbol[] = [];
  for (const fn of model.functions) {
    if (!inScope(fn.file, scope) || !isExportedFunction(model, fn.id)) continue;
    out.push({ id: fn.id, name: fn.name, file: fn.file });
  }
  return out;
}

/**
 * The exported functions `id` calls, through helpers. Sorted: the direct callees first, then the rest, each group by name.
 * An unknown or non-exported id still answers (its own callees), so a helper can be inspected too.
 */
export function exportedCallees(model: ProjectModel, id: string): SymbolLink[] {
  return walk(model, id, (src) => calleeNeighbours(model, src));
}

/**
 * The exported functions that reach `id`, through helpers. Sorted as exportedCallees. Only the callers of the function itself
 * are listed: a call made from a lambda it owns is not one of its callers.
 */
export function exportedCallers(model: ProjectModel, id: string): SymbolLink[] {
  return walk(model, id, (dst) => callerNeighbours(model, dst));
}

interface Neighbour {
  next: string;
  candidate: boolean;
}

/** The spawn nodes each function starts: a spawn is a node of the body it sits in, so it folds into the owner (memoized per model). */
const spawnMemo = new WeakMap<ProjectModel, Map<string, string[]>>();
function spawnsBy(model: ProjectModel): Map<string, string[]> {
  const hit = spawnMemo.get(model);
  if (hit) return hit;
  const by = new Map<string, string[]>();
  for (const from of model.out.keys()) {
    const node = model.byId.get(from);
    if (node === undefined || !isSpawnKind(node.kind) || node.parent === undefined) continue;
    const owner = ownerOf(model.byId, node.parent);
    const list = by.get(owner);
    if (list) list.push(from);
    else by.set(owner, [from]);
  }
  spawnMemo.set(model, by);
  return by;
}

/**
 * The functions `src` calls: its own relations, those of the lambdas it owns, and those of the threads and processes it starts
 * (a spawned target is a callee of the function that starts it). A callee folds into its owner.
 */
function calleeNeighbours(model: ProjectModel, src: string): Neighbour[] {
  const out: Neighbour[] = [];
  const froms = [src, ...(anonymousOwned(model).get(src) ?? []), ...(spawnsBy(model).get(src) ?? [])];
  for (const from of froms) {
    for (const rel of model.out.get(from) ?? []) {
      const next = ownerOf(model.byId, rel.to);
      if (isWalkable(model, next)) out.push({ next, candidate: isMaybe(rel) });
    }
  }
  return out;
}

/** The functions that call `dst`, with a lambda caller folded into its owner (a spawn into the function that starts the thread). */
function callerNeighbours(model: ProjectModel, dst: string): Neighbour[] {
  const out: Neighbour[] = [];
  for (const rel of model.in.get(dst) ?? []) {
    const from = model.byId.get(rel.from);
    const spawned = from !== undefined && isSpawnKind(from.kind) && from.parent !== undefined;
    const next = ownerOf(model.byId, spawned ? (from.parent as string) : rel.from);
    if (isWalkable(model, next)) out.push({ next, candidate: isMaybe(rel) });
  }
  return out;
}

interface Frame {
  id: string;
  /** The first helper on this frame's path from the walk's start. Undefined for the start itself and for direct links. */
  via?: string;
  candidate: boolean;
}

/**
 * Breadth-first walk from `start`. Each exported function reached is a link; each helper is expanded once per maybe state, so a
 * cycle ends and the shortest path to every helper is the one followed. A helper already walked as a sure call is not walked
 * again as a maybe. A link keeps the first path's `via`, except that a sure path found after a maybe one takes its `via`; a link
 * is a maybe only while every path to it is a maybe path.
 */
function walk(model: ProjectModel, start: string, neighbours: (id: string) => Neighbour[]): SymbolLink[] {
  const found = new Map<string, SymbolLink>();
  const expanded = new Set<string>();
  const stateKey = (id: string, cand: boolean) => `${id}\0${cand ? 1 : 0}`;
  let level: Frame[] = [{ id: start, candidate: false }];
  for (let depth = 0; depth < SYMBOLS_MAX_DEPTH && level.length > 0; depth++) {
    const next: Frame[] = [];
    for (const frame of level) {
      for (const { next: to, candidate } of neighbours(frame.id)) {
        if (to === start) continue;
        const cand = frame.candidate || candidate;
        if (isExportedFunction(model, to)) {
          const hit = found.get(to);
          if (hit === undefined) {
            const fn = model.functionById.get(to);
            if (fn === undefined) continue;
            found.set(to, { id: to, name: fn.name, file: fn.file, ...(frame.via !== undefined ? { via: frame.via } : {}), candidate: cand });
          } else if (hit.candidate && !cand) {
            // A sure path found after a maybe one: the link is sure, and it names the sure path's helper.
            hit.candidate = false;
            if (frame.via !== undefined) hit.via = frame.via;
            else delete hit.via;
          }
          continue;
        }
        // A helper walked as a sure call reaches everything its maybe walk would, so it is not walked again as a maybe.
        if (cand && expanded.has(stateKey(to, false))) continue;
        const state = stateKey(to, cand);
        if (expanded.has(state)) continue;
        expanded.add(state);
        const fn = model.functionById.get(to);
        const via = frame.via ?? fn?.name ?? to;
        next.push({ id: to, via, candidate: cand });
      }
    }
    level = next;
  }
  return [...found.values()].sort((a, b) => (a.via === undefined ? 0 : 1) - (b.via === undefined ? 0 : 1) || cmpName(a, b));
}

function cmpName(a: SymbolLink, b: SymbolLink): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
