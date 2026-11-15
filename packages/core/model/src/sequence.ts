// Sequence pipelines: a function that orchestrates a run of calls into other files, in source order. The orchestrator's exact
// calls to functions in other files are its stages; a stage must itself make exact calls and be called from a bounded set of
// callers. A sequence is shown in the Pipeline view as a strip of stages. Pure: the same model always gives the same output.
import type { NodeId, Span } from "@insight/ir";
import { isNoisePath } from "@insight/flow";
import type { FunctionEntity, ProjectModel, Rel } from "./model.js";
import type { Site } from "./system.js";

/** A sequence needs this many stages, spread over at least MIN_STAGE_FILES files. */
export const MIN_STAGES = 4;
export const MIN_STAGE_FILES = 2;
/** A stage makes at least this many distinct exact call targets, so a leaf helper never counts as a stage. */
const STAGE_TARGETS_MIN = 2;
/** A stage with more distinct folded callers than this is a shared utility, not a step of one run. */
const FAN_IN_MAX = 25;
/** Stages kept per sequence. The `more` count covers the rest. */
const STAGE_CAP = 16;
/** Sequences kept per scope. */
const SEQUENCE_CAP = 3;

export interface PipelineStage {
  fn: string; // the stage function's node id
  name: string;
  file: string;
  component?: string;
  order: number; // position in the sequence, 0 = first
  site: Site; // the orchestrator's call site for this stage
}

export interface PipelineSequence {
  id: string; // the orchestrator function's node id
  name: string;
  file: string;
  component?: string;
  stages: PipelineStage[]; // at most STAGE_CAP, in call order
  more: number; // stages not kept
  files: number; // distinct files of all stages
  score: number;
}

/** The function an owner node belongs to: its nearest named parent (anonymous functions count as their owner). */
export function enclosingFn(model: ProjectModel, id: NodeId): NodeId | undefined {
  let cur = id;
  for (let depth = 0; depth < 1000; depth++) {
    const node = model.byId.get(cur);
    if (!node || node.kind !== "structure.function" || node.attrs.anonymous !== true || node.parent === undefined) break;
    cur = node.parent;
  }
  return model.functionById.has(cur) ? cur : undefined;
}

/**
 * The sequences of one scope, best first. `compOf` gives a file's System component (undefined when the file is out of scope
 * or dropped), and `tests` says whether noise folders count. Orchestrators are in-scope, named, non-module functions that are
 * not React components. Stages are in-scope functions in other files.
 */
export function sequencePipelines(
  model: ProjectModel,
  compOf: (file: string | undefined) => string | undefined,
  tests: boolean,
): PipelineSequence[] {
  const inScope = (file: string | undefined): boolean => file !== undefined && compOf(file) !== undefined && (tests || !isNoisePath(file));

  const isModuleEntry = (id: NodeId): boolean => model.byId.get(id)?.attrs.module === true;
  const isStage = (fn: FunctionEntity): boolean => !fn.anonymous && !isModuleEntry(fn.id) && inScope(fn.file);

  const isComponent = (fn: FunctionEntity): boolean => {
    const rendered = [...(model.out.get(fn.id) ?? []), ...(model.in.get(fn.id) ?? [])].some((r) => r.how === "jsx");
    if (rendered) return true;
    return /\.(tsx|jsx)$/.test(fn.file) && /^[A-Z]/.test(fn.name);
  };

  // Exact calls by their folded caller, and the folded callers of each callee.
  const callsBy = new Map<NodeId, Rel[]>();
  const callersOf = new Map<NodeId, Set<NodeId>>();
  for (const rel of model.relations) {
    if (rel.kind !== "call" || rel.candidate) continue;
    const caller = enclosingFn(model, rel.from);
    if (caller === undefined) continue;
    const list = callsBy.get(caller);
    if (list) list.push(rel);
    else callsBy.set(caller, [rel]);
    const callers = callersOf.get(rel.to) ?? new Set<NodeId>();
    callers.add(caller);
    callersOf.set(rel.to, callers);
  }
  // A stage must call STAGE_TARGETS_MIN distinct functions besides itself: counted once per function, not per orchestrator.
  const targetCount = new Map<NodeId, number>();
  for (const [caller, rels] of callsBy) targetCount.set(caller, new Set(rels.map((r) => r.to).filter((t) => t !== caller)).size);

  const candidates: Array<{ seq: PipelineSequence; score: number }> = [];
  for (const fn of model.functions) {
    if (!isStage(fn) || isComponent(fn)) continue;
    const own = (callsBy.get(fn.id) ?? []).filter((r) => r.to !== fn.id);
    if (own.length === 0) continue;
    const distinctCallees = new Set(own.map((r) => r.to)).size;

    // Each callee's stage site: its call with the smallest order key (callEnd, else span end), so `f(g(x))` puts g before f.
    const keyOf = orderKeys(model, fn, own);
    const best = new Map<NodeId, { key: OrderKey; rel: Rel }>();
    for (const rel of own) {
      const callee = model.functionById.get(rel.to);
      if (callee === undefined || callee.file === fn.file || !isStage(callee)) continue;
      if ((callersOf.get(rel.to)?.size ?? 0) > FAN_IN_MAX || (targetCount.get(rel.to) ?? 0) < STAGE_TARGETS_MIN) continue;
      const key = keyOf(rel);
      const cur = best.get(rel.to);
      if (cur === undefined || cmpKey(key, cur.key) < 0) best.set(rel.to, { key, rel });
    }
    if (best.size < MIN_STAGES) continue;

    const stages = [...best.entries()].sort((a, b) => cmpKey(a[1].key, b[1].key) || cmp(a[0], b[0]));
    const files = new Set(stages.map(([callee]) => model.functionById.get(callee)?.file ?? ""));
    if (stages.length < MIN_STAGES || files.size < MIN_STAGE_FILES) continue;

    const kept = stages.slice(0, STAGE_CAP).map(([callee, { rel }], order): PipelineStage => {
      const target = model.functionById.get(callee) as FunctionEntity;
      const span = rel.edge.span;
      return {
        fn: callee,
        name: target.name,
        file: target.file,
        component: compOf(target.file),
        order,
        site: { file: span?.file ?? fn.file, line: span ? span.start[0] + 1 : 0, fn: fn.id },
      };
    });
    const score = (files.size * Math.log2(1 + stages.length) * stages.length) / distinctCallees;
    candidates.push({
      score,
      seq: {
        id: fn.id,
        name: fn.name,
        file: fn.file,
        component: compOf(fn.file),
        stages: kept,
        more: stages.length - kept.length,
        files: files.size,
        score: Math.round(score * 100) / 100,
      },
    });
  }

  return candidates
    .sort((a, b) => b.score - a.score || cmp(a.seq.id, b.seq.id))
    .slice(0, SEQUENCE_CAP)
    .map((c) => c.seq);
}

type Pos = readonly [number, number];
/** Where a call sorts: the end of the orchestrator's own call it runs under (`at`), then its own end inside that (`sub`). */
type OrderKey = { at: Pos; sub: Pos };
const LAST: Pos = [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER];
const NONE: Pos = [-1, -1];

const cmpPos = (a: Pos, b: Pos): number => a[0] - b[0] || a[1] - b[1];
const cmpKey = (a: OrderKey, b: OrderKey): number => cmpPos(a.at, b.at) || cmpPos(a.sub, b.sub);

/**
 * The position a call finishes at, as [line, column]. The frontend records the whole call expression's end as `callEnd`,
 * because the span covers only the callee name, which would put `f(g(x))` the wrong way round. Without it, the span's end
 * is used. A call with neither sorts last.
 */
function callEnd(rel: Rel): Pos {
  const end = rel.edge.attrs?.callEnd;
  if (Array.isArray(end) && typeof end[0] === "number" && typeof end[1] === "number") return [end[0], end[1]];
  const span: Span | undefined = rel.edge.span;
  return span ? [span.end[0], span.end[1]] : LAST;
}

/**
 * The order keys of an orchestrator's calls. A call made directly by `fn` sorts at its own end. A call made inside an
 * anonymous callback of `fn` sorts right after the call of `fn` that the callback is passed to, so `s1(x, () => s2())` puts
 * s1 first: the callback runs once s1 has started. A callback that is not inside one of `fn`'s calls keeps its own end.
 */
function orderKeys(model: ProjectModel, fn: FunctionEntity, own: Rel[]): (rel: Rel) => OrderKey {
  const direct = own.filter((r) => r.from === fn.id && r.edge.span !== undefined);
  return (rel) => {
    const end = callEnd(rel);
    if (rel.from === fn.id) return { at: end, sub: NONE };
    // The callback directly under fn that holds this call.
    let top = rel.from;
    for (let depth = 0; depth < 1000; depth++) {
      const parent = model.byId.get(top)?.parent;
      if (parent === undefined || parent === fn.id) break;
      top = parent;
    }
    const start = model.byId.get(top)?.span?.start;
    if (start === undefined) return { at: end, sub: NONE };
    let host: Rel | undefined;
    for (const d of direct) {
      const ds = (d.edge.span as Span).start;
      if (cmpPos(ds, start) > 0 || cmpPos(callEnd(d), start) < 0) continue;
      if (host === undefined || cmpPos(ds, (host.edge.span as Span).start) > 0) host = d;
    }
    return host === undefined ? { at: end, sub: NONE } : { at: callEnd(host), sub: end };
  };
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
