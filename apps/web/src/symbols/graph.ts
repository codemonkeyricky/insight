// The exported-function call graph of the Symbols tab. Pure: it reads a ProjectModel and answers, for one exported function,
// the exported functions it reaches (its callees) or the exported functions that reach it (its callers). An internal (not
// exported) function is a helper: the walk follows through it and stops at the first exported function on each path.
// Lambdas fold into their owner, as refsOf does, and a candidate (an interface-dispatch set) marks the link as a maybe.
import type { ProjectModel } from "@insight/model";
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
 * path, when the path goes through one; `candidate` is true only when every path to it is a candidate (a maybe).
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

/** The functions `src` calls: its own relations and those of the lambdas it owns, with a lambda callee folded into its owner. */
function calleeNeighbours(model: ProjectModel, src: string): Neighbour[] {
  const out: Neighbour[] = [];
  for (const from of [src, ...(ownedBy(model).get(src) ?? [])]) {
    for (const rel of model.out.get(from) ?? []) {
      const next = ownerOf(model, rel.to);
      if (isWalkable(model, next)) out.push({ next, candidate: rel.candidate });
    }
  }
  return out;
}

/** The functions that call `dst`, with a lambda caller folded into its owner (a spawn into the function that starts the thread). */
function callerNeighbours(model: ProjectModel, dst: string): Neighbour[] {
  const out: Neighbour[] = [];
  for (const rel of model.in.get(dst) ?? []) {
    const from = model.byId.get(rel.from);
    const spawned = from !== undefined && (from.kind === "concurrency.spawn-thread" || from.kind === "concurrency.spawn-process") && from.parent !== undefined;
    const next = ownerOf(model, spawned ? (from.parent as string) : rel.from);
    if (isWalkable(model, next)) out.push({ next, candidate: rel.candidate });
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
 * Breadth-first walk from `start`. Each exported function reached is a link; each helper is expanded once per candidate state,
 * so a cycle ends and the shortest path to every helper is the one followed. A link keeps the first path's `via`, and is a
 * maybe only while every path to it is a candidate path.
 */
function walk(model: ProjectModel, start: string, neighbours: (id: string) => Neighbour[]): SymbolLink[] {
  const found = new Map<string, SymbolLink>();
  const expanded = new Set<string>();
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
          } else if (!cand) {
            hit.candidate = false;
          }
          continue;
        }
        const state = `${to}\0${cand ? 1 : 0}`;
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

/** The named function an anonymous function folds into, walking up through anonymous parents (as refs-common's ownerOf). */
function ownerOf(model: ProjectModel, id: string): string {
  let cur = id;
  for (let depth = 0; depth < 1000; depth++) {
    const node = model.byId.get(cur);
    if (!node || node.kind !== "structure.function" || node.attrs.anonymous !== true || node.parent === undefined) return cur;
    cur = node.parent;
  }
  return cur;
}

const ownedMemo = new WeakMap<ProjectModel, Map<string, string[]>>();

/** The anonymous functions each owner holds, directly or through other anonymous functions. Memoized per model. */
function ownedBy(model: ProjectModel): Map<string, string[]> {
  const hit = ownedMemo.get(model);
  if (hit) return hit;
  const owned = new Map<string, string[]>();
  for (const fn of model.functions) {
    if (!fn.anonymous) continue;
    const owner = ownerOf(model, fn.id);
    if (owner === fn.id) continue;
    const list = owned.get(owner);
    if (list) list.push(fn.id);
    else owned.set(owner, [fn.id]);
  }
  ownedMemo.set(model, owned);
  return owned;
}
