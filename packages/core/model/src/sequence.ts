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
  inner: string,
  compOf: (file: string | undefined) => string | undefined,
  tests: boolean,
): PipelineSequence[] {
  void inner; // scope membership is already in compOf
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

  const candidates: Array<{ seq: PipelineSequence; score: number }> = [];
  for (const fn of model.functions) {
    if (!isStage(fn) || isComponent(fn)) continue;
    const own = (callsBy.get(fn.id) ?? []).filter((r) => r.to !== fn.id);
    if (own.length === 0) continue;
    const distinctCallees = new Set(own.map((r) => r.to)).size;

    // Each callee's stage site: its call with the smallest call end (callEnd, else span end), so `f(g(x))` puts g before f.
    const best = new Map<NodeId, { key: number; rel: Rel }>();
    for (const rel of own) {
      const callee = model.functionById.get(rel.to);
      if (callee === undefined || callee.file === fn.file || !isStage(callee)) continue;
      const key = callEnd(rel);
      const cur = best.get(rel.to);
      if (cur === undefined || key < cur.key) best.set(rel.to, { key, rel });
    }
    if (best.size < MIN_STAGES) continue;

    const stages = [...best.entries()]
      .filter(([callee]) => {
        const targets = new Set((callsBy.get(callee) ?? []).map((r) => r.to).filter((t) => t !== callee));
        return targets.size >= STAGE_TARGETS_MIN && (callersOf.get(callee)?.size ?? 0) <= FAN_IN_MAX;
      })
      .sort((a, b) => a[1].key - b[1].key || cmp(a[0], b[0]));
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

/**
 * The position a call finishes at, as one number: line * 1e6 + column. The frontend records the whole call expression's end
 * as `callEnd`, because the span covers only the callee name, which would put `f(g(x))` the wrong way round. Without it,
 * the span's end is used. A call with neither sorts last.
 */
function callEnd(rel: Rel): number {
  const end = rel.edge.attrs?.callEnd;
  if (Array.isArray(end) && typeof end[0] === "number" && typeof end[1] === "number") return end[0] * 1e6 + end[1];
  const span: Span | undefined = rel.edge.span;
  return span ? span.end[0] * 1e6 + span.end[1] : Number.MAX_SAFE_INTEGER;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
