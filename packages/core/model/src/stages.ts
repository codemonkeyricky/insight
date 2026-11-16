// Stage graphs: the call order of one pipeline driver, read from the IR's flow facts (loops, branches, try/catch, exits) and its
// call sites. A driver's exact calls to in-scope functions are its stages. A candidate call with how interface|registry fans
// out to every candidate. A named helper nested in the driver is inlined under its call. Pure: the same model always gives the
// same output.
import type { IREdge, IRNode, NodeId, Span } from "@insight/ir";
import { isNoisePath } from "@insight/flow";
import type { FunctionEntity, ProjectModel, Rel } from "./model.js";
import {
  cmpKey,
  cmpPos,
  enclosingFn,
  FAN_IN_MAX,
  foldedCalls,
  isComponentFn,
  MIN_STAGE_FILES,
  MIN_STAGES,
  NONE,
  orderKeys,
  STAGE_TARGETS_MIN,
  type OrderKey,
  type Pos,
} from "./sequence.js";
import type { Site } from "./system.js";

/** Fanout targets kept per call. The `truncated` flag says more exist. */
const FANOUT_CAP = 20;
/** Named helpers inlined under the driver, nested at most this deep. */
const MAX_INLINE_DEPTH = 3;

export type StageNode =
  | {
      kind: "call";
      id: string;
      name: string;
      fn?: NodeId;
      file?: string;
      component?: string;
      site: Site;
      minor?: boolean; // utility callee (fan-in > FAN_IN_MAX or fewer than STAGE_TARGETS_MIN targets): hidden unless "Show all"
      fanout?: { how: "interface" | "registry"; targets: { fn: NodeId; name: string; component?: string }[]; truncated?: boolean };
      ambiguous?: boolean; // candidates without how interface|registry: ONE stage, no fan-out
      body?: StageNode[]; // inlined local helper (named fn nested in the driver), depth <= 3, cycle-guarded
      binds?: string[];
      reads?: string[]; // P2
    }
  | { kind: "loop"; id: string; variant: string; condition?: string; reads?: string[]; site: Site; body: StageNode[] }
  | { kind: "branch"; id: string; condition: string; site: Site; arms: { id: string; label: string; body: StageNode[] }[] }
  | { kind: "try"; id: string; site: Site; body: StageNode[]; handler: StageNode[] }
  | { kind: "exit"; id: string; how: "continue" | "break" | "return" | "throw"; site: Site };

/** A data edge between two stages (P2: not produced yet, always empty here). */
export interface DataEdge {
  from: string;
  to: string;
  label: string;
  type?: string;
}

export interface StageGraph {
  driver: { id: NodeId; name: string; file: string; component?: string };
  body: StageNode[];
  edges: DataEdge[];
  coverage: string[]; // human notes for missing facts
}

export interface StageDriver {
  id: NodeId;
  name: string;
  file: string;
  component?: string;
  score: number;
}

/** Shared per-model indexes: flow nodes and call groups by their folded function, and the folded call counts. */
interface Index {
  flowByFn: Map<NodeId, IRNode[]>;
  groupsByFn: Map<NodeId, Rel[][]>;
  callersOf: Map<NodeId, Set<NodeId>>;
  targetCount: Map<NodeId, number>;
}
const indexes = new WeakMap<ProjectModel, Index>();

function indexOf(model: ProjectModel): Index {
  const hit = indexes.get(model);
  if (hit) return hit;
  const flowByFn = new Map<NodeId, IRNode[]>();
  for (const n of model.doc.nodes) {
    if (!n.kind.startsWith("flow.") || n.span === undefined || n.parent === undefined) continue;
    const owner = enclosingFn(model, n.parent);
    if (owner === undefined) continue;
    const list = flowByFn.get(owner);
    if (list) list.push(n);
    else flowByFn.set(owner, [n]);
  }
  // One group is one call site: the relations that share its edge (a candidate set expands to several).
  const groups = new Map<IREdge, Rel[]>();
  for (const rel of model.relations) {
    if (rel.kind !== "call") continue;
    const list = groups.get(rel.edge);
    if (list) list.push(rel);
    else groups.set(rel.edge, [rel]);
  }
  const groupsByFn = new Map<NodeId, Rel[][]>();
  for (const group of groups.values()) {
    const owner = enclosingFn(model, (group[0] as Rel).from);
    if (owner === undefined) continue;
    const list = groupsByFn.get(owner);
    if (list) list.push(group);
    else groupsByFn.set(owner, [group]);
  }
  const { callersOf, targetCount } = foldedCalls(model);
  const idx: Index = { flowByFn, groupsByFn, callersOf, targetCount };
  indexes.set(model, idx);
  return idx;
}

// ---- the nesting tree -------------------------------------------------------------------------------------------------------

type TKind = "root" | "loop" | "branch" | "arm" | "try" | "block" | "exit" | "call";
interface TNode {
  kind: TKind;
  start?: Pos;
  end?: Pos;
  key: OrderKey; // position among siblings
  ir?: IRNode; // the flow node of a container or exit
  group?: Rel[]; // the call group of a call
  children: TNode[];
}

const KIND_OF: Record<string, TKind> = {
  "flow.loop": "loop",
  "flow.try": "try",
  "flow.branch": "branch",
  "flow.switch": "branch",
  "flow.branch-arm": "arm",
  "flow.block": "block",
  "flow.jump": "exit",
  "flow.return": "exit",
  "flow.throw": "exit",
};
/** Outer-first order for spans that start at the same place: containers before their arms, blocks, exits and calls. */
const RANK: Record<string, number> = { "flow.loop": 0, "flow.try": 0, "flow.branch": 0, "flow.switch": 0, "flow.branch-arm": 1, "flow.block": 2, "flow.jump": 3, "flow.return": 3, "flow.throw": 3 };
const CALL_RANK = 4;
const CONTAINERS = new Set<TKind>(["loop", "branch", "arm", "try", "block"]);

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const attr = (n: IRNode, key: string): unknown => (n.attrs as Record<string, unknown>)[key];
const bindsOf = (v: unknown): string[] | undefined => {
  if (typeof v === "string") return v === "" ? undefined : [v];
  if (Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string")) return v as string[];
  return undefined;
};

/**
 * The statements of one function as a tree. Flow parents are always the function, so nesting comes from span containment:
 * sort by start (outer first), then stack-nest. A call sits in the innermost container that holds its span start.
 */
function membersOf(fnId: NodeId, ctx: Ctx): TNode[] {
  const memo = ctx.memo.get(fnId);
  if (memo) return memo;
  const fn = ctx.model.functionById.get(fnId);
  const root: TNode = { kind: "root", key: { at: NONE, sub: NONE }, children: [] };
  if (fn === undefined) return root.children;
  const groups = ctx.idx.groupsByFn.get(fnId) ?? [];
  const keyOf = orderKeys(ctx.model, fn, groups.flat());

  const items: Array<{ node: TNode; rank: number }> = [];
  for (const n of ctx.idx.flowByFn.get(fnId) ?? []) {
    const kind = KIND_OF[n.kind];
    const span = n.span as Span;
    if (kind === undefined) continue;
    items.push({
      node: { kind, start: span.start, end: span.end, key: { at: span.start, sub: NONE }, ir: n, children: [] },
      rank: RANK[n.kind] as number,
    });
  }
  const spanless: TNode[] = [];
  for (const group of groups) {
    const rel = group[0] as Rel;
    const key = keyOf(rel);
    const span = rel.edge.span;
    if (span === undefined) {
      spanless.push({ kind: "call", key, group, children: [] });
      continue;
    }
    items.push({ node: { kind: "call", start: span.start, end: span.end, key, group, children: [] }, rank: CALL_RANK });
  }
  items.sort((a, b) => cmpPos(a.node.start as Pos, b.node.start as Pos) || cmpPos(b.node.end as Pos, a.node.end as Pos) || a.rank - b.rank);

  const stack: TNode[] = [root];
  for (const { node } of items) {
    while (stack.length > 1 && !contains(stack[stack.length - 1] as TNode, node)) stack.pop();
    (stack[stack.length - 1] as TNode).children.push(node);
    if (CONTAINERS.has(node.kind)) stack.push(node);
  }
  root.children.push(...spanless);
  ctx.memo.set(fnId, root.children);
  return root.children;
}

function contains(outer: TNode, inner: TNode): boolean {
  if (outer.start === undefined || outer.end === undefined || inner.start === undefined || inner.end === undefined) return false;
  return cmpPos(outer.start, inner.start) <= 0 && cmpPos(inner.end, outer.end) <= 0;
}

const minStart = (nodes: TNode[]): Pos | undefined => {
  let best: Pos | undefined;
  for (const n of nodes) if (n.start !== undefined && (best === undefined || cmpPos(n.start, best) < 0)) best = n.start;
  return best;
};

/** Calls that run before a loop's body or a branch's first arm (the iterable, the condition): they run before the container. */
function headerOf(n: TNode): TNode[] {
  const first = minStart(n.kind === "loop" ? n.children.filter((c) => c.kind === "block") : n.kind === "branch" ? n.children.filter((c) => c.kind === "arm") : []);
  if (first === undefined) return [];
  return n.children.filter((c) => c.kind === "call" && c.start !== undefined && cmpPos(c.start, first) < 0);
}

const isHandlerBlock = (n: TNode): boolean => n.kind === "block" && (str(attr(n.ir as IRNode, "label")) === "catch" || str(attr(n.ir as IRNode, "label")) === "finally");

// ---- emitting stages ---------------------------------------------------------------------------------------------------------

interface Ctx {
  model: ProjectModel;
  idx: Index;
  compOf: (file: string | undefined) => string | undefined;
  tests: boolean;
  driverId: NodeId;
  inScope: (file: string) => boolean;
  memo: Map<NodeId, TNode[]>;
  ids: Set<string>;
  noCallEnd: boolean;
}

interface Env {
  ctx: Ctx;
  fnId: NodeId; // the function whose statements these are
  prefix: string; // keeps ids unique when a helper is inlined more than once
  stack: NodeId[]; // the driver and the helpers being inlined
  loops: number; // loops around this point
  exitOk: boolean; // an exit here is kept: its nearest enclosing statement is a branch arm inside a loop
}

function emitList(nodes: TNode[], env: Env): StageNode[] {
  const out: StageNode[] = [];
  for (const n of [...nodes].sort((a, b) => cmpKey(a.key, b.key))) {
    switch (n.kind) {
      case "call": {
        const c = resolveCall(n.group as Rel[], env);
        if (c) out.push(c);
        break;
      }
      case "exit": {
        const e = exitNode(n, env);
        if (e) out.push(e);
        break;
      }
      case "block":
      case "arm":
      case "root":
        out.push(...emitList(n.children, env));
        break;
      case "loop":
        out.push(...emitList(headerOf(n), env), loopNode(n, env));
        break;
      case "branch":
        if (!n.children.some((c) => c.kind === "arm")) out.push(...emitList(n.children, env));
        else out.push(...emitList(headerOf(n), env), branchNode(n, env));
        break;
      case "try":
        out.push(tryNode(n, env));
        break;
    }
  }
  return out;
}

const siteOf = (ir: IRNode, env: Env): Site => ({ file: (ir.span as Span).file, line: (ir.span as Span).start[0] + 1, fn: env.fnId });

function exitNode(n: TNode, env: Env): StageNode | undefined {
  if (!env.exitOk) return undefined;
  const ir = n.ir as IRNode;
  const how = ir.kind === "flow.return" ? "return" : ir.kind === "flow.throw" ? "throw" : str(attr(ir, "variant")) === "break" ? "break" : "continue";
  return { kind: "exit", id: env.prefix + ir.id, how, site: siteOf(ir, env) };
}

function loopNode(n: TNode, env: Env): StageNode {
  const ir = n.ir as IRNode;
  const condition = str(attr(ir, "condition"));
  const headers = headerOf(n);
  const bodyNodes = n.children.filter((c) => !headers.includes(c));
  return {
    kind: "loop",
    id: env.prefix + ir.id,
    variant: str(attr(ir, "variant")) ?? "loop",
    ...(condition !== undefined ? { condition } : {}),
    site: siteOf(ir, env),
    body: emitList(bodyNodes, { ...env, loops: env.loops + 1, exitOk: false }),
  };
}

function branchNode(n: TNode, env: Env): StageNode {
  const ir = n.ir as IRNode;
  const armEnv: Env = { ...env, exitOk: env.loops > 0 };
  const headers = headerOf(n);
  const arms: Array<{ id: string; label: string; body: StageNode[] }> = n.children
    .filter((c) => c.kind === "arm")
    .sort((a, b) => cmpKey(a.key, b.key))
    .map((a) => ({
      id: env.prefix + (a.ir as IRNode).id,
      label: str(attr(a.ir as IRNode, "label")) ?? "arm",
      body: emitList(a.children, armEnv),
    }));
  // Statements between the arms (an `else if` chain has no else arm of its own): they make up an implicit else.
  const extras = n.children.filter((c) => c.kind !== "arm" && !headers.includes(c));
  if (extras.length > 0) arms.push({ id: `${env.prefix}${ir.id}#else`, label: "else", body: emitList(extras, armEnv) });
  return { kind: "branch", id: env.prefix + ir.id, condition: str(attr(ir, "condition")) ?? "", site: siteOf(ir, env), arms };
}

function tryNode(n: TNode, env: Env): StageNode {
  const ir = n.ir as IRNode;
  const inner: Env = { ...env, exitOk: false };
  return {
    kind: "try",
    id: env.prefix + ir.id,
    site: siteOf(ir, env),
    body: emitList(
      n.children.filter((c) => !isHandlerBlock(c)),
      inner,
    ),
    // A catch handler of a try inside a loop keeps its exits: "try detect, catch continue" renders as a skip. A finally does not.
    handler: n.children
      .filter((c) => isHandlerBlock(c))
      .flatMap((c) => emitList([c], { ...env, exitOk: str(attr(c.ir as IRNode, "label")) === "catch" && env.loops > 0 })),
  };
}

/** A candidate-free or candidate call turned into one stage: an exact target, a fan-out, or one ambiguous stage. */
function resolveCall(group: Rel[], env: Env): StageNode | undefined {
  const { ctx } = env;
  const first = group[0] as Rel;
  const span = first.edge.span;
  const site: Site = { file: span?.file ?? ctx.model.fileOf(first.from) ?? "", line: span ? span.start[0] + 1 : 0, fn: env.fnId };
  const callee = str(first.edge.attrs?.callee);
  const binds = bindsOf(first.edge.attrs?.binds);
  const id = unique(ctx, `${env.prefix}call@${first.from}@${span ? `${span.start[0]}:${span.start[1]}` : "?"}`);
  const targetOk = (t: NodeId): boolean => {
    const f = ctx.model.functionById.get(t);
    return f !== undefined && t !== env.fnId && ctx.inScope(f.file);
  };
  if (first.edge.attrs?.callEnd === undefined) ctx.noCallEnd = true;

  if (first.candidate) {
    const targets = [...new Set(group.map((r) => r.to))].filter(targetOk).sort();
    if (targets.length === 0) return undefined;
    const how = first.how;
    if (how === "interface" || how === "registry") {
      const shown = targets.slice(0, FANOUT_CAP).map((t): { fn: NodeId; name: string; component?: string } => {
        const f = ctx.model.functionById.get(t) as FunctionEntity;
        const component = ctx.compOf(f.file);
        return { fn: t, name: f.name, ...(component !== undefined ? { component } : {}) };
      });
      return {
        kind: "call",
        id,
        name: callee ?? shown[0]?.name ?? "call",
        site,
        fanout: { how, targets: shown, ...(targets.length > FANOUT_CAP ? { truncated: true } : {}) },
        ...(binds !== undefined ? { binds } : {}),
      };
    }
    return { kind: "call", id, name: callee ?? "call", site, ambiguous: true, ...(binds !== undefined ? { binds } : {}) };
  }

  const t = first.to;
  const fn = ctx.model.functionById.get(t);
  if (fn === undefined || !targetOk(t)) return undefined;
  const minor = (ctx.idx.callersOf.get(t)?.size ?? 0) > FAN_IN_MAX || (ctx.idx.targetCount.get(t) ?? 0) < STAGE_TARGETS_MIN;
  let body: StageNode[] = [];
  if (isLocalTo(ctx.model, fn, ctx.driverId) && env.stack.length <= MAX_INLINE_DEPTH && !env.stack.includes(t)) {
    body = emitList(membersOf(t, ctx), { ctx, fnId: t, prefix: `${id}/`, stack: [...env.stack, t], loops: 0, exitOk: false });
  }
  // An inlined helper with no non-minor stage in its body is itself a utility: hidden like one.
  const utility = minor || (body.length > 0 && countStages(body) === 0);
  const component = ctx.compOf(fn.file);
  return {
    kind: "call",
    id,
    name: callee ?? fn.name,
    fn: t,
    file: fn.file,
    ...(component !== undefined ? { component } : {}),
    site,
    ...(utility ? { minor: true } : {}),
    ...(body.length > 0 ? { body } : {}),
    ...(binds !== undefined ? { binds } : {}),
  };
}

function unique(ctx: Ctx, base: string): string {
  let id = base;
  for (let n = 1; ctx.ids.has(id); n++) id = `${base}#${n}`;
  ctx.ids.add(id);
  return id;
}

/** A named function whose parent chain reaches the driver: a helper nested in it (a const arrow, a local function). */
function isLocalTo(model: ProjectModel, fn: FunctionEntity, driverId: NodeId): boolean {
  let cur = fn.parent;
  for (let depth = 0; depth < 1000 && cur !== undefined; depth++) {
    if (cur === driverId) return true;
    const node = model.byId.get(cur);
    if (!node || node.kind !== "structure.function") return false;
    cur = node.parent;
  }
  return false;
}

// ---- pruning ------------------------------------------------------------------------------------------------------------------

/** A node that keeps its container: a non-minor call, or an exit, or a container that survived pruning. */
const isSig = (n: StageNode): boolean => n.kind !== "call" || n.minor !== true;

function pruneList(nodes: StageNode[]): StageNode[] {
  const out: StageNode[] = [];
  for (const n of nodes) {
    if (n.kind === "call") {
      out.push(n.body === undefined ? n : { ...n, body: pruneList(n.body) });
    } else if (n.kind === "exit") {
      out.push(n);
    } else if (n.kind === "loop") {
      const body = pruneList(n.body);
      if (body.some(isSig)) out.push({ ...n, body });
    } else if (n.kind === "try") {
      const body = pruneList(n.body);
      const handler = pruneList(n.handler);
      if (body.some(isSig) || handler.some(isSig)) out.push({ ...n, body, handler });
    } else {
      const arms = n.arms.map((a) => ({ ...a, body: pruneList(a.body) }));
      const kept = arms.filter((a) => a.body.some(isSig));
      if (kept.length === 0) continue;
      // One kept arm of two keeps its empty sibling too, so the view can show it as "else: —".
      out.push({ ...n, arms: kept.length === 1 && arms.length === 2 ? arms : kept });
    }
  }
  return out;
}

// ---- scoring --------------------------------------------------------------------------------------------------------------------

function countStages(nodes: StageNode[]): number {
  let total = 0;
  for (const n of nodes) {
    if (n.kind === "call") {
      if (n.minor === true) continue;
      total += 1 + (n.body ? countStages(n.body) : 0);
    } else if (n.kind === "loop") total += countStages(n.body);
    else if (n.kind === "branch") for (const a of n.arms) total += countStages(a.body);
    else if (n.kind === "try") total += countStages(n.body) + countStages(n.handler);
  }
  return total;
}

/**
 * The share of non-minor stage calls (fan-outs count as one call each) whose path from the body passes through a branch arm.
 * An `else if` link is a branch inside its parent's else arm, so a whole ladder counts as arms of one branch. Catch and finally
 * handlers are not arms. A router is a body with a share above one half.
 */
export function armShare(body: StageNode[]): number {
  let all = 0;
  let inArm = 0;
  const walk = (nodes: StageNode[], arm: boolean): void => {
    for (const n of nodes) {
      if (n.kind === "call") {
        if (n.minor === true) continue;
        all++;
        if (arm) inArm++;
        if (n.body) walk(n.body, arm);
      } else if (n.kind === "loop") walk(n.body, arm);
      else if (n.kind === "branch") for (const a of n.arms) walk(a.body, true);
      else if (n.kind === "try") {
        walk(n.body, arm);
        walk(n.handler, arm);
      }
    }
  };
  walk(body, false);
  return all === 0 ? 0 : inArm / all;
}

/** The score of a stage graph, or undefined when it has too few stages or files to be a pipeline. */
function scoreBody(model: ProjectModel, body: StageNode[]): number | undefined {
  const total = countStages(body);
  const files = new Set<string>();
  let fanouts = 0;
  let inLoop = false;
  const walk = (nodes: StageNode[], looped: boolean): void => {
    for (const n of nodes) {
      if (n.kind === "call") {
        if (n.minor === true) continue;
        if (n.fanout) {
          fanouts++;
          for (const t of n.fanout.targets) {
            const f = model.functionById.get(t.fn);
            if (f) files.add(f.file);
          }
        } else if (n.file) files.add(n.file);
        if (looped) inLoop = true;
        if (n.body) walk(n.body, looped);
      } else if (n.kind === "loop") walk(n.body, true);
      else if (n.kind === "branch") {
        for (const a of n.arms) walk(a.body, looped);
      } else if (n.kind === "try") {
        walk(n.body, looped);
        walk(n.handler, looped);
      }
    }
  };
  walk(body, false);
  if (total < MIN_STAGES || files.size < MIN_STAGE_FILES) return undefined;
  const base = files.size * Math.log2(1 + total) * total;
  const router = armShare(body) > 0.5;
  return base * (router ? 0.3 : 1) * (inLoop ? 1.5 : 1) * Math.min(2, 1.2 ** fanouts);
}

function countAmbiguous(nodes: StageNode[]): number {
  let n = 0;
  for (const node of nodes) {
    if (node.kind === "call") n += (node.ambiguous === true ? 1 : 0) + (node.body ? countAmbiguous(node.body) : 0);
    else if (node.kind === "loop") n += countAmbiguous(node.body);
    else if (node.kind === "branch") for (const a of node.arms) n += countAmbiguous(a.body);
    else if (node.kind === "try") n += countAmbiguous(node.body) + countAmbiguous(node.handler);
  }
  return n;
}

// ---- public API -----------------------------------------------------------------------------------------------------------------

/**
 * The pipeline drivers of one scope, best first: named, in-scope, non-module, non-component functions whose stage graph has
 * enough stages across enough files. Router-shaped functions are penalised. Functions with loops, and fan-outs, are preferred.
 */
export function stageDrivers(
  model: ProjectModel,
  compOf: (file: string | undefined) => string | undefined,
  tests: boolean,
): StageDriver[] {
  const idx = indexOf(model);
  const inScope = (file: string): boolean => compOf(file) !== undefined && (tests || !isNoisePath(file));
  const scored: Array<{ driver: StageDriver; raw: number }> = [];
  for (const fn of model.functions) {
    if (fn.anonymous || model.byId.get(fn.id)?.attrs.module === true || !inScope(fn.file) || isComponentFn(model, fn)) continue;
    if (!idx.flowByFn.has(fn.id) && !idx.groupsByFn.has(fn.id)) continue;
    const raw = scoreBody(model, stageGraph(model, fn.id, compOf, tests).body);
    if (raw === undefined) continue;
    const component = compOf(fn.file);
    scored.push({
      driver: { id: fn.id, name: fn.name, file: fn.file, ...(component !== undefined ? { component } : {}), score: Math.round(raw * 100) / 100 },
      raw,
    });
  }
  return scored.sort((a, b) => b.raw - a.raw || cmpStr(a.driver.id, b.driver.id)).map((s) => s.driver);
}

/**
 * The stage graph of one driver function: its statements in call order, with loops, branches, try/catch and exits, and its
 * calls as stages. `tests` says whether noise folders count. Pure.
 */
export function stageGraph(
  model: ProjectModel,
  driverId: NodeId,
  compOf: (file: string | undefined) => string | undefined,
  tests: boolean,
): StageGraph {
  const idx = indexOf(model);
  const inScope = (file: string): boolean => compOf(file) !== undefined && (tests || !isNoisePath(file));
  const ctx: Ctx = { model, idx, compOf, tests, driverId, inScope, memo: new Map(), ids: new Set(), noCallEnd: false };
  const fn = model.functionById.get(driverId);
  const env: Env = { ctx, fnId: driverId, prefix: "", stack: [driverId], loops: 0, exitOk: false };
  const body = pruneList(emitList(membersOf(driverId, ctx), env));
  const component = fn ? compOf(fn.file) : undefined;
  return {
    driver: { id: driverId, name: fn?.name ?? driverId, file: fn?.file ?? "", ...(component !== undefined ? { component } : {}) },
    body,
    edges: [],
    coverage: coverageOf(ctx, body, driverId),
  };
}

function coverageOf(ctx: Ctx, body: StageNode[], driverId: NodeId): string[] {
  const notes: string[] = [];
  if (ctx.noCallEnd) notes.push("Nested call order approximate");
  const flows = ctx.idx.flowByFn.get(driverId) ?? [];
  const hasLoop = flows.some((n) => n.kind === "flow.loop");
  const hasExit = flows.some((n) => n.kind === "flow.jump" || n.kind === "flow.return");
  if (hasLoop && !hasExit) notes.push("Early exits not shown");
  const ambiguous = countAmbiguous(body);
  if (ambiguous > 0) notes.push(`${ambiguous} calls with several possible targets shown once`);
  return notes;
}

function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
