import type { IREdge, IRFinding, IRNode, IRRecord, NodeId, Provenance, Span, UnresolvedRef } from "@insight/ir";
import type { IRBatch } from "@insight/sdk";

type Confidence = Provenance["confidence"];
import type { SyntaxNode } from "./parser.js";
import {
  blockOf,
  effectCatalog,
  type EffectEntry,
  FRONTEND_ID,
  lockIdentity,
  nodeKey,
  norm,
  normName,
  scopeOf,
  stripTemplates,
  type FnDecl,
  type Project,
} from "./project.js";
import { emitData, localReads } from "./data.js";
import { analyze, atomOf, caseGroups, decompose, enumerator, holderRef, shadowNames, stateIndexOf, testId, writeOf, type Atom, type Holder, type RefCtx, type WriteInfo } from "./state.js";
import {
  CONDVAR_OP,
  classAt,
  declArgs,
  DYNAMIC,
  GUARDS,
  guardedQueues,
  isAtomicMethod,
  LOCKFREE_SEND_RECV,
  NO_LOCK_ARGS,
  nameText,
  POSIX_COND_OPS,
  POSIX_SEM_OPS,
  refOf,
  resolveVar,
  SEMAPHORE_OP,
  stdQueueCall,
  waitLock,
} from "./sync.js";
const THREAD_TYPES = new Set(["std::thread", "std::jthread"]);
type SpawnHow = "thread" | "async";
/** Calls that start a thread or task. `arg` is the argument holding the function, or -1 for the first argument that is not a launch policy. */
const SPAWN_CALLS = new Map<string, { arg: number; how: SpawnHow }>([
  ["std::thread", { arg: 0, how: "thread" }],
  ["std::jthread", { arg: 0, how: "thread" }],
  ["std::async", { arg: -1, how: "async" }],
  ["pthread_create", { arg: 2, how: "thread" }],
]);
/** Above this many possible targets, a call is too ambiguous to record. */
const MAX_CANDIDATES = 8;

const pointSpan = (file: string, p: { row: number; column: number }): Span => ({ file, start: [p.row, p.column], end: [p.row, p.column] });
const spanOf = (file: string, n: SyntaxNode): Span => ({
  file,
  start: [n.startPosition.row, n.startPosition.column],
  end: [n.endPosition.row, n.endPosition.column],
});

/** Keeps node IDs unique within one file. Function IDs are reserved first, so they never change. */
class Ids {
  private readonly seen: Set<string>;
  constructor(reserved: Iterable<string>) {
    this.seen = new Set(reserved);
  }
  take(base: string): string {
    let id = base;
    let n = 2;
    while (this.seen.has(id)) id = `${base}~${n++}`;
    this.seen.add(id);
    return id;
  }
}

/** The modes a stream type opens its file in. */
const STREAM_MODES: Record<string, ("read" | "write")[]> = {
  "std::ifstream": ["read"],
  "std::ofstream": ["write"],
  "std::fstream": ["read", "write"],
};

/** A string literal's contents, without the quotes. Other expressions are not literal paths. */
const stringLiteral = (n: SyntaxNode): string | undefined => {
  const m = /^"((?:[^"\\]|\\.)*)"$/s.exec(n.text);
  return n.type === "string_literal" && m ? (m[1] as string) : undefined;
};

/** A macro or signal name written as a literal: an upper-case identifier, or a number. A lower-case name is a variable. */
const nameLiteral = (n: SyntaxNode): string | undefined => {
  if (n.type === "number_literal") return n.text;
  return n.type === "identifier" && /^[A-Z][A-Z0-9_]*$/.test(n.text) ? n.text : undefined;
};

/** The attribute value a catalog row takes from its argument, or <dynamic> when the argument is not a literal. */
function catalogValue(row: EffectEntry, args: SyntaxNode[]): string {
  if (row.arg === undefined) return DYNAMIC;
  const a = args[row.arg];
  if (!a) return DYNAMIC;
  const literal = row.attr === "path" || row.op === "fd" ? stringLiteral(a) : nameLiteral(a);
  return literal ?? DYNAMIC;
}

/**
 * True when the project defines a function this call could reach: a qualified name that matches, or an
 * unqualified name that is a method of the enclosing class, or a free function visible here (same file, or not static).
 */
function definesCallee(project: Project, rel: string, callee: string, cls: string | undefined): boolean {
  if (callee.includes("::")) {
    const simple = callee.split("::").pop() ?? callee;
    return (project.bySimple.get(simple) ?? []).some((d) => d.qname === callee || d.qname.endsWith(`::${callee}`));
  }
  return (project.bySimple.get(callee) ?? []).some((d) => (d.cls === undefined ? d.exported || d.rel === rel : d.cls === cls));
}

/** The first argument in a parenthesised or braced argument list, as written. */
function firstArgument(list: string | undefined): string | undefined {
  if (list === undefined) return undefined;
  const inner = list.trim().replace(/^[({]/, "").replace(/[)}]$/, "");
  let depth = 0;
  let out = "";
  for (const ch of inner) {
    if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch)) depth--;
    if (ch === "," && depth === 0) break;
    out += ch;
  }
  return out.trim() || undefined;
}

/** The named children of an argument list, without comments. */
const namedArgs = (list: SyntaxNode | null | undefined): SyntaxNode[] => (list?.namedChildren ?? []).filter((n) => n.type !== "comment");
const argsOf = (call: SyntaxNode): SyntaxNode[] => namedArgs(call.childForFieldName("arguments"));

/** A set of candidate functions, and how sure the frontend is that one of them is the target. */
interface Resolved {
  targets: FnDecl[];
  confidence: Confidence;
}

/** A constructor is a function named by the last scope segment of its qualified name, `X::X`. */
const isConstructor = (fn: FnDecl): boolean => {
  const segments = fn.qname.split("::");
  return segments.length >= 2 && segments[segments.length - 2] === fn.simple;
};

/**
 * The candidates, or undefined when there are none or too many to be useful. Overloads are one function to a caller,
 * so the cap is bypassed only when every candidate has the same qualified name and is defined in the same file, as a
 * real overload set is. Candidates spread across files, such as `operator<<`, stay capped.
 * Several candidates are never more than heuristic.
 */
function candidatesOf(targets: FnDecl[], confidence: Confidence): Resolved | undefined {
  if (targets.length === 0) return undefined;
  const first = targets[0];
  const overloads = targets.every((t) => t.qname === first?.qname && t.rel === first?.rel);
  if (targets.length > MAX_CANDIDATES && !overloads) return undefined;
  return { targets, confidence: targets.length > 1 ? "heuristic" : confidence };
}

/**
 * Candidates for a name written as an identifier or as a qualified name. A defined qualified name is
 * exact; otherwise it matches the definitions whose qualified name ends with it.
 */
function resolveName(project: Project, name: string, qualified: boolean): Resolved | undefined {
  if (!qualified) return candidatesOf(project.bySimple.get(name) ?? [], "inferred");
  const exact = project.byQName.get(name) ?? [];
  if (exact.length > 0) return candidatesOf(exact, "exact");
  const last = name.split("::").pop() ?? name;
  const suffixed = (project.bySimple.get(last) ?? []).filter((d) => d.qname === name || d.qname.endsWith(`::${name}`));
  return candidatesOf(suffixed, "heuristic");
}

/** Candidate targets for a callee. A qualified name that is defined is exact, an ambiguous name is heuristic. */
function resolveCallee(project: Project, fnNode: SyntaxNode): Resolved | undefined {
  switch (fnNode.type) {
    case "identifier":
      return resolveName(project, stripTemplates(normName(fnNode.text)), false);
    case "template_function":
      return resolveName(project, stripTemplates(normName(fnNode.childForFieldName("name")?.text ?? "")), false);
    case "qualified_identifier":
      return resolveName(project, stripTemplates(normName(fnNode.text)).replace(/^::/, ""), true);
    case "field_expression": {
      const field = fnNode.childForFieldName("field")?.text;
      if (!field) return undefined;
      const simple = normName(field);
      // A member call is never a constructor call, so constructors are not candidates.
      return candidatesOf((project.bySimple.get(simple) ?? []).filter((d) => d.cls !== undefined && !isConstructor(d)), "heuristic");
    }
    default:
      return undefined;
  }
}

/**
 * The function name a thread or task start names, past the `&`, casts, `+` and parentheses around it.
 * A lambda names itself. Other expressions name no function, so they give undefined.
 */
function functionNameOf(arg: SyntaxNode): SyntaxNode | undefined {
  let n: SyntaxNode | null = arg;
  while (n) {
    switch (n.type) {
      // A type_identifier is here because `std::thread t(worker);` parses as a parameter whose type is the name.
      case "identifier":
      case "type_identifier":
      case "qualified_identifier":
      case "lambda_expression":
        return n;
      case "template_function":
        n = n.childForFieldName("name");
        break;
      case "pointer_expression":
        // Only `&f` names a function. `*p` does not.
        n = n.childForFieldName("operator")?.text === "&" ? n.childForFieldName("argument") : null;
        break;
      case "unary_expression":
        // `+[]{}` converts a captureless lambda to a function pointer, as pthread_create takes one.
        n = n.childForFieldName("operator")?.text === "+" ? n.childForFieldName("argument") : null;
        break;
      case "cast_expression":
        n = n.childForFieldName("value");
        break;
      case "parenthesized_expression":
        n = n.namedChild(0);
        break;
      default:
        n = null;
    }
  }
  return undefined;
}

const isPrefix = (prefix: string[], path: string[]): boolean => prefix.length <= path.length && prefix.every((s, i) => s === path[i]);

/**
 * The lambda a name refers to, when a variable of this name holds one and is visible at the use. A
 * variable is visible inside its block after its declaration. One at namespace or file scope is visible
 * within its namespaces. The innermost visible variable wins, as in C++ name lookup. An assigned lambda
 * is heuristic: the variable may have been set again.
 */
function boundLambda(project: Project, rel: string, use: SyntaxNode): { decl: FnDecl; confidence: Confidence } | undefined {
  const scopePath = scopeOf(use).path;
  let best: { decl: FnDecl; confidence: Confidence; block: number; declEnd: number } | undefined;
  for (const decl of project.lambdaBindings.get(norm(use.text)) ?? []) {
    const b = decl.binding;
    if (!b || decl.rel !== rel) continue;
    if (b.block) {
      const [start, end] = b.block;
      if (use.startIndex < start || use.endIndex > end || use.startIndex < b.declEnd) continue;
    } else if (!isPrefix(b.scope, scopePath)) {
      continue;
    }
    const block = b.block?.[0] ?? -1;
    if (best && (block < best.block || (block === best.block && b.declEnd <= best.declEnd))) continue;
    best = { decl, confidence: b.assigned ? "heuristic" : "exact", block, declEnd: b.declEnd };
  }
  return best && { decl: best.decl, confidence: best.confidence };
}

/** The function a thread or async target names, when the project defines it or a visible variable holds it. */
function resolveSpawnTarget(project: Project, rel: string, arg: SyntaxNode): { name: SyntaxNode; resolved: Resolved } | undefined {
  const name = functionNameOf(arg);
  if (!name) return undefined;
  if (name.type === "lambda_expression") {
    const decl = project.fns.get(`${rel}|${nodeKey(name)}`);
    return decl ? { name, resolved: { targets: [decl], confidence: "exact" } } : undefined;
  }
  if (name.type === "identifier" || name.type === "type_identifier") {
    const bound = boundLambda(project, rel, name);
    if (bound) return { name, resolved: { targets: [bound.decl], confidence: bound.confidence } };
  }
  const resolved = resolveName(project, stripTemplates(normName(name.text)).replace(/^::/, ""), name.type === "qualified_identifier");
  return resolved ? { name, resolved } : undefined;
}

/** An edge target for a set of candidates: one id, or `candidates` when there are several, as calls.call records them. */
function targetOf(targets: FnDecl[]): NodeId | { candidates: [NodeId, ...NodeId[]] } {
  const [first, ...rest] = [...new Set(targets.map((t) => t.id))] as [NodeId, ...NodeId[]];
  return rest.length === 0 ? first : { candidates: [first, ...rest] };
}

const sameNode = (a: SyntaxNode | null | undefined, b: SyntaxNode): boolean => a !== null && a !== undefined && nodeKey(a) === nodeKey(b);

/** The names a declarator declares: a plain identifier, or the identifiers of a structured binding. */
function declaredNamesOf(declarator: SyntaxNode | null): string[] {
  if (!declarator) return [];
  if (declarator.type === "identifier") return [declarator.text];
  if (declarator.type === "structured_binding_declarator") return declarator.namedChildren.filter((c) => c.type === "identifier").map((c) => c.text);
  const inner = declarator.childForFieldName("declarator");
  return inner ? declaredNamesOf(inner) : [];
}

/**
 * The local a call's result is bound or assigned to: `cfg` for `auto cfg = f()` or `cfg = f()`, the names of a structured
 * binding. `co_await` and parentheses are transparent. A call anywhere else binds no local.
 */
function callBinds(call: SyntaxNode): string | string[] | undefined {
  let value = call;
  let p: SyntaxNode | null = value.parent;
  while (p !== null && (p.type === "parenthesized_expression" || p.type === "co_await_expression")) {
    value = p;
    p = p.parent;
  }
  let names: string[] = [];
  if (p?.type === "init_declarator" && sameNode(p.childForFieldName("value"), value)) names = declaredNamesOf(p.childForFieldName("declarator"));
  else if (p?.type === "assignment_expression" && sameNode(p.childForFieldName("right"), value)) {
    const left = p.childForFieldName("left");
    if (left?.type === "identifier") names = [left.text];
  }
  if (names.length === 0) return undefined;
  return names.length === 1 ? names[0] : names;
}

/** True when a call is the operand of a co_await, possibly in parentheses. */
function awaitedBy(call: SyntaxNode): boolean {
  let p: SyntaxNode | null = call.parent;
  while (p?.type === "parenthesized_expression") p = p.parent;
  return p?.type === "co_await_expression";
}

/** Facts for one file, from the project pass. Files with parse errors give inferred facts and a warning. */
export function emitUnit(project: Project, rel: string): IRBatch {
  const unit = project.units.get(rel);
  if (!unit) return { file: rel, records: [] };

  const prov: Provenance = { frontend: FRONTEND_ID, confidence: unit.errors.length > 0 ? "inferred" : "exact" };
  const syncProv: Provenance = { frontend: FRONTEND_ID, confidence: "inferred" };
  const stateIndex = stateIndexOf(project);
  const ids = new Ids([...(project.fnsByFile.get(rel) ?? []).map((d) => d.id), ...(stateIndex.byRel.get(rel) ?? []).map((h) => h.id)]);
  /** State facts are syntactic guesses by design (D12). */
  const heur: Provenance = { frontend: FRONTEND_ID, confidence: "heuristic" };
  const writeInfo = new Map<string, WriteInfo>();
  const exitTests = new Set<string>();
  const emittedTests = new Set<string>();
  const armIds = new Map<string, string>();
  // A scoped lock guard variable (`std::unique_lock lk(m)`) to the lock it holds, per function: `lk.unlock()` gives up m.
  const guardMutex = new Map<string, string>();
  const shadowCache = new Map<string, Set<string>>();
  const records: IRRecord[] = [];
  const deps = new Set<string>(project.macroDeps.get(rel) ?? []);
  const node = (n: IRNode) => records.push({ node: n });
  const edge = (e: IREdge) => records.push({ edge: e });
  const coroutines = new Set<NodeId>();

  const flow = (n: SyntaxNode, tag: string, kind: string, container: NodeId, attrs: Record<string, unknown>) =>
    node({
      id: ids.take(`${rel}@${tag}:${n.startPosition.row}:${n.startPosition.column}`),
      facet: "flow",
      kind,
      parent: container,
      attrs,
      span: spanOf(rel, n),
      provenance: prov,
    });

  /** The `reads` attribute for a condition or range: the locals it names, omitted when it names none. */
  const readsAttr = (n: SyntaxNode | null | undefined): { reads?: string[] } => {
    const reads = localReads(project, rel, n);
    return reads.length > 0 ? { reads } : {};
  };

  const markCoroutine = (n: SyntaxNode, fn: FnDecl | undefined) => {
    if (!fn || coroutines.has(fn.id)) return;
    coroutines.add(fn.id);
    node({
      id: ids.take(`${fn.id}@coroutine`),
      facet: "concurrency",
      kind: "concurrency.coroutine",
      parent: fn.id,
      attrs: { name: fn.simple },
      span: spanOf(rel, n),
      provenance: prov,
    });
  };

  /**
   * A thread or task start. The spawn node is always recorded with the target text. The spawns edge
   * is added only when the target argument names a function the project defines.
   */
  const spawn = (n: SyntaxNode, container: NodeId, how: SpawnHow, api: string, target: string | undefined, targetArg: SyntaxNode | undefined) => {
    const id = ids.take(`${rel}@spawn:${n.startPosition.row}:${n.startPosition.column}`);
    node({
      id,
      facet: "concurrency",
      kind: "concurrency.spawn-thread",
      parent: container,
      attrs: { api, ...(target !== undefined ? { target: target.slice(0, 120) } : {}) },
      span: spanOf(rel, n),
      provenance: prov,
    });
    const hit = targetArg ? resolveSpawnTarget(project, rel, targetArg) : undefined;
    if (!hit) return;
    for (const t of hit.resolved.targets) if (t.rel !== rel) deps.add(t.rel);
    edge({
      from: id,
      to: targetOf(hit.resolved.targets),
      facet: "concurrency",
      kind: "concurrency.spawns",
      attrs: { how },
      span: spanOf(rel, hit.name),
      provenance: { frontend: FRONTEND_ID, confidence: hit.resolved.confidence },
    });
  };

  const handleInclude = (n: SyntaxNode) => {
    const path = n.childForFieldName("path");
    if (!path) return;
    const text = path.text.replace(/^["<]|[">]$/g, "");
    const to: UnresolvedRef = { unresolved: { scheme: "cpp.include", text } };
    edge({
      from: rel,
      to,
      facet: "packaging",
      kind: "packaging.include",
      attrs: { text, system: path.type === "system_lib_string" },
      span: spanOf(rel, n),
      provenance: prov,
    });
  };

  /** A node at a site: the kind, the facet, and an id built from the tag and the site's position. */
  const emitNode = (n: SyntaxNode, container: NodeId, facet: string, kind: string, tag: string, attrs: Record<string, unknown>, provenance: Provenance) =>
    node({
      id: ids.take(`${rel}@${tag}:${n.startPosition.row}:${n.startPosition.column}`),
      facet,
      kind,
      parent: container,
      attrs,
      span: spanOf(rel, n),
      provenance,
    });

  /** A send to or receive from a queue or channel. `guardedBy` is set only for an inferred guarded std queue. */
  const channelOp = (call: SyntaxNode, container: NodeId, side: "send" | "recv", channel: string, api: string, provenance: Provenance, guardedBy?: string) =>
    emitNode(call, container, "concurrency", side === "send" ? "concurrency.channel-send" : "concurrency.channel-recv", side, {
      channel,
      api,
      ...(guardedBy !== undefined ? { guardedBy } : {}),
    }, provenance);

  /** A call of a method on a variable whose declared type is a queue, semaphore, condition variable or atomic. */
  const memberCall = (call: SyntaxNode, fnNode: SyntaxNode, args: SyntaxNode[], container: NodeId, cls: string | undefined) => {
    const method = fnNode.childForFieldName("field")?.text;
    const ref = refOf(fnNode.childForFieldName("argument"));
    if (!method || !ref) return;
    const v = resolveVar(project, ref.name, call, cls, ref.viaThis);
    if (!v) return;
    const api = `${v.type}::${method}`;
    const lockFree = LOCKFREE_SEND_RECV[v.type];
    if (lockFree) {
      if (lockFree.send.includes(method)) channelOp(call, container, "send", v.channel, api, prov);
      else if (lockFree.recv.includes(method)) channelOp(call, container, "recv", v.channel, api, prov);
      return;
    }
    const queue = stdQueueCall(project, rel, call);
    if (queue) {
      // Only a queue inferred to be guarded emits. Its locks and the channel are the same on both sides.
      const guard = guardedQueues(project).get(queue.channel);
      if (guard !== undefined) channelOp(call, container, queue.side, queue.channel, api, syncProv, guard);
      return;
    }
    const sem = SEMAPHORE_OP(v.type, method);
    if (sem !== undefined) {
      emitNode(call, container, "sync", "sync.semaphore", "sem", { op: sem, name: v.channel, api }, prov);
      return;
    }
    const cv = CONDVAR_OP(v.type, method);
    if (cv !== undefined) {
      const attrs: Record<string, unknown> = { op: cv, name: v.channel, api };
      const lock = cv === "wait" ? waitLock(project, call, args[0], cls) : undefined;
      if (lock !== undefined) attrs.lock = lock;
      emitNode(call, container, "sync", "sync.condvar", "cv", attrs, prov);
      return;
    }
    if (isAtomicMethod(v.type, method)) {
      // Named by the resolved variable, as condvars and semaphores are: Class::member, a qualified global, or <dynamic> for a local.
      emitNode(call, container, "sync", "sync.atomic-op", "atomic", { op: "op", api, lock: v.channel }, prov);
    }
  };

  /** The POSIX semaphore and condition variable calls. A name that is not a plain name is <dynamic>. */
  const posixSync = (call: SyntaxNode, callee: string, args: SyntaxNode[], container: NodeId, cls: string | undefined) => {
    const named = (n: SyntaxNode | undefined) => {
      const text = nameText(n);
      return text === DYNAMIC ? text : lockIdentity(text, cls, project.members);
    };
    const sem = POSIX_SEM_OPS[callee];
    if (sem !== undefined) {
      emitNode(call, container, "sync", "sync.semaphore", "sem", { op: sem, name: named(args[0]), api: callee }, prov);
      return;
    }
    const cond = POSIX_COND_OPS[callee];
    if (cond !== undefined) {
      const attrs: Record<string, unknown> = { op: cond.op, name: named(args[0]), api: callee };
      if (cond.lock) {
        const lock = nameText(args[1]);
        if (lock !== DYNAMIC) attrs.lock = lockIdentity(lock, cls, project.members);
      }
      emitNode(call, container, "sync", "sync.condvar", "cv", attrs, prov);
    }
  };

  /** One row of the catalog: a spawn, or an effect with the attributes its row sets. */
  const catalogRow = (row: EffectEntry, call: SyntaxNode, callee: string, args: SyntaxNode[], container: NodeId) => {
    if (row.kind === "concurrency.spawn-process") {
      emitNode(call, container, "concurrency", row.kind, "procspawn", { api: row.api ?? callee }, prov);
      return;
    }
    const attrs: Record<string, unknown> = { api: row.api ?? callee };
    if (row.op !== undefined) attrs.op = row.op;
    if (row.syscall !== undefined) attrs.syscall = row.syscall;
    if (row.attr !== undefined) attrs[row.attr] = catalogValue(row, args);
    emitNode(call, container, "effects", row.kind, "effect", attrs, prov);
  };

  const handleCall = (call: SyntaxNode, container: NodeId, fn: FnDecl | undefined) => {
    const fnNode = call.childForFieldName("function");
    if (!fnNode) return;
    const callee = stripTemplates(normName(fnNode.text)).replace(/^::/, "");
    const args = argsOf(call);
    const cls = classAt(project, rel, call);
    // The local the call's result goes into, if any: `cfg ← loadConfig()`.
    const binds = callBinds(call);

    const spawnCall = SPAWN_CALLS.get(callee);
    if (spawnCall) {
      const targetArg =
        spawnCall.arg === -1 ? args.find((a) => !norm(a.text).startsWith("std::launch")) : args[spawnCall.arg];
      spawn(call, container, spawnCall.how, callee, targetArg?.text, targetArg);
    }

    if (fnNode.type === "field_expression") {
      // Member calls only: a name matched in the catalog is never a member, so `f.read()` emits nothing.
      if (args.length === 0) {
        const method = fnNode.childForFieldName("field")?.text;
        const recv = fnNode.childForFieldName("argument")?.text;
        if (recv !== undefined && (method === "lock" || method === "try_lock" || method === "unlock")) {
          // A guard variable (`lk` in `std::unique_lock lk(m)`) names the mutex it holds, not itself.
          const lock = guardMutex.get(`${fn?.id ?? ""}|${recv}`) ?? lockIdentity(recv, cls, project.members);
          const acquire = method !== "unlock";
          node({
            id: ids.take(`${rel}@${method}:${call.startPosition.row}:${call.startPosition.column}`),
            facet: "sync",
            kind: acquire ? "sync.lock-acquire" : "sync.lock-release",
            parent: container,
            attrs: acquire ? { lock, mode: "exclusive", api: "lock" } : { lock, api: "unlock" },
            span: spanOf(rel, call),
            provenance: syncProv,
          });
        }
      }
      memberCall(call, fnNode, args, container, cls);
    } else if (!definesCallee(project, rel, callee, cls)) {
      // A function the project defines is never a system call: a local `kill` shadows ::kill.
      for (const row of effectCatalog.get(callee) ?? []) catalogRow(row, call, callee, args, container);
      posixSync(call, callee, args, container, cls);
    }

    if (fn) {
      const resolved = resolveCallee(project, fnNode);
      if (resolved) {
        for (const t of resolved.targets) if (t.rel !== rel) deps.add(t.rel);
        const to = targetOf(resolved.targets);
        const span = spanOf(rel, fnNode);
        const provenance: Provenance = { frontend: FRONTEND_ID, confidence: resolved.confidence };
        edge({ from: fn.id, to, facet: "calls", kind: "calls.call", attrs: { callee: callee.slice(0, 200), ...(binds !== undefined ? { binds } : {}) }, span, provenance });
        // Calling a coroutine creates one. Awaited, the caller waits on it; otherwise the caller starts it and goes on.
        if (resolved.targets.every((t) => project.coroutines.has(t.id))) {
          edge({
            from: fn.id,
            to,
            facet: "concurrency",
            kind: "concurrency.dispatches",
            attrs: { how: awaitedBy(call) ? "await" : "start" },
            span,
            provenance,
          });
        }
      }
    }
  };

  /** `++x` and `x--` on a std::atomic variable: an atomic read-modify-write. */
  const atomicUpdate = (n: SyntaxNode, container: NodeId) => {
    const ref = refOf(n.childForFieldName("argument"));
    if (!ref) return;
    const v = resolveVar(project, ref.name, n, classAt(project, rel, n), ref.viaThis);
    if (v?.type !== "std::atomic") return;
    const op = n.childForFieldName("operator")?.text === "--" ? "operator--" : "operator++";
    emitNode(n, container, "sync", "sync.atomic-op", "atomic", { op: "op", api: `std::atomic::${op}`, lock: v.channel }, prov);
  };

  const handleDeclaration = (decl: SyntaxNode, container: NodeId, fn: FnDecl | undefined) => {
    const typeNode = decl.childForFieldName("type");
    const base = stripTemplates(norm(typeNode?.text ?? ""));
    const declarator = decl.childForFieldName("declarator");

    // `std::thread t(f, x)` parses as a declaration whose parameter list holds the arguments. A
    // `std::thread(f)` expression is a call, and handleCall records it.
    // Inside a function body the same text parses as an init_declarator whose value is an
    // argument_list, so both shapes are read.
    if (THREAD_TYPES.has(base)) {
      if (declarator?.type === "function_declarator") {
        // `std::thread t(worker);` parses as a function declaration whose one parameter is the name.
        const params = declarator.childForFieldName("parameters");
        const only = params?.namedChildren[0];
        const nameArg =
          only?.type === "parameter_declaration" && !only.childForFieldName("declarator") ? only.childForFieldName("type") : null;
        spawn(decl, container, "thread", base, firstArgument(params?.text), nameArg ?? undefined);
      } else if (declarator?.type === "init_declarator") {
        // `std::thread t{f, x}` holds its arguments in an initializer list. `std::thread t{}` starts nothing.
        const value = declarator.childForFieldName("value");
        if (value?.type === "argument_list" || (value?.type === "initializer_list" && namedArgs(value).length > 0)) {
          spawn(decl, container, "thread", base, firstArgument(value.text), namedArgs(value)[0]);
        }
      }
    }

    // `std::ifstream in("file")` opens a file for reading, `std::ofstream` for writing, `std::fstream` for both.
    const streams = STREAM_MODES[base];
    if (streams !== undefined && declarator !== null) {
      const [first] = declArgs(decl);
      if (first !== undefined) {
        for (const mode of streams) {
          emitNode(decl, container, "effects", mode === "read" ? "effects.fs.read" : "effects.fs.write", `stream-${mode}`, { api: base, path: stringLiteral(first) ?? DYNAMIC }, prov);
        }
      }
    }

    const mode = GUARDS[base];
    if (mode === undefined || declarator?.type !== "function_declarator") return;
    const block = blockOf(decl);
    // An out-of-line definition (void Store::put) has no class in its scope; its name carries it.
    const cls = scopeOf(decl).cls ?? fn?.cls;
    const locks = declArgs(decl).filter((p) => !NO_LOCK_ARGS.has(norm(p.text)));
    const guardName = declarator.childForFieldName("declarator")?.text;
    const firstLock = locks[0];
    if (guardName !== undefined && firstLock !== undefined) guardMutex.set(`${fn?.id ?? ""}|${guardName}`, lockIdentity(firstLock.text, cls, project.members));
    // A guard built with defer_lock or try_to_lock takes its lock later, with lk.lock() or lk.try_lock(); one built with
    // adopt_lock takes a lock already held. None of them acquires at construction, but each still releases at scope end.
    const acquiresAtDecl = !declArgs(decl).some((p) => NO_LOCK_ARGS.has(norm(p.text)));
    // The last explicit lock or unlock call on the guard in its block: an unlock with nothing after it leaves no release.
    const lastGuardOp = (text: string, guard: string): string | undefined => {
      let last: string | undefined;
      if (!/^\w+$/.test(guard)) return undefined;
      for (const m of text.matchAll(new RegExp(`\\b${guard}\\s*\\.\\s*(lock|try_lock|unlock)\\s*\\(`, "g"))) last = m[1];
      return last;
    };
    const explicitlyUnlocked = guardName !== undefined && lastGuardOp(block?.text ?? "", guardName) === "unlock";
    locks.forEach((arg, i) => {
      const lock = lockIdentity(arg.text, cls, project.members);
      // A shared_mutex taken by any guard is a read-write lock: shared for shared_lock, exclusive otherwise. It is
      // emitted as sync.rwlock-acquire alone, which extends sync.lock-acquire, so each guard is one acquire node.
      const ref = refOf(arg);
      const mutexType = ref ? resolveVar(project, ref.name, decl, cls, ref.viaThis)?.type : undefined;
      if (acquiresAtDecl && mutexType === "std::shared_mutex") {
        node({
          id: ids.take(`${rel}@rwlock:${decl.startPosition.row}:${decl.startPosition.column}:${i}`),
          facet: "sync",
          kind: "sync.rwlock-acquire",
          parent: container,
          attrs: { lock, mode, api: base },
          span: spanOf(rel, decl),
          provenance: syncProv,
        });
      } else if (acquiresAtDecl) {
        node({
          id: ids.take(`${rel}@guard:${decl.startPosition.row}:${decl.startPosition.column}:${i}`),
          facet: "sync",
          kind: "x-cpp.scoped-lock",
          parent: container,
          attrs: { lock, mode, api: base },
          span: spanOf(rel, decl),
          provenance: syncProv,
        });
      }
      if (block && !explicitlyUnlocked) {
        node({
          id: ids.take(`${rel}@release:${block.endPosition.row}:${block.endPosition.column}:${i}`),
          facet: "sync",
          kind: "sync.lock-release",
          parent: container,
          attrs: { lock, api: base },
          span: pointSpan(rel, block.endPosition),
          provenance: syncProv,
        });
      }
    });
  };


  /** The names, class and index an expression in `n` is read against. */
  const refCtx = (n: SyntaxNode): RefCtx => {
    let fnNode: SyntaxNode | undefined;
    let cls: string | undefined;
    for (let p: SyntaxNode | null = n; p; p = p.parent) {
      if (p.type !== "function_definition" && p.type !== "lambda_expression") continue;
      fnNode ??= p;
      const decl = project.fns.get(`${rel}|${nodeKey(p)}`);
      if (decl?.cls !== undefined) {
        cls = decl.cls;
        break;
      }
    }
    cls ??= scopeOf(n).cls;
    let shadow = new Set<string>();
    if (fnNode) {
      const key = nodeKey(fnNode);
      shadow = shadowCache.get(key) ?? shadowNames(fnNode);
      shadowCache.set(key, shadow);
    }
    return { index: stateIndex, ...(cls !== undefined ? { cls } : {}), shadow };
  };

  const analyzeBody = (fnNode: SyntaxNode) => {
    const body = fnNode.childForFieldName("body");
    if (!body || body.type !== "compound_statement") return;
    const a = analyze(body, rel, refCtx(body));
    for (const [k, v] of a.writes) writeInfo.set(k, v);
    for (const k of a.exits) exitTests.add(k);
  };

  const emitHolder = (h: Holder, container: NodeId, at: SyntaxNode) =>
    node({
      id: h.id,
      facet: "state",
      kind: "state.holder",
      parent: container,
      attrs: { name: h.name, domainKind: "enum", values: h.values, declaredType: h.declaredType },
      span: spanOf(rel, at),
      provenance: heur,
    });

  const emitWrite = (h: Holder, container: NodeId, at: SyntaxNode, op: "init" | "set", value: string | undefined, info?: WriteInfo) =>
    node({
      id: ids.take(`${rel}@write:${at.startPosition.row}:${at.startPosition.column}`),
      facet: "state",
      kind: "state.write",
      parent: container,
      attrs: {
        holder: h.id,
        op,
        ...(value !== undefined ? { value } : { dynamic: true }),
        receiver: "",
        ...(info?.from ? { from: info.from } : {}),
        ...(info && info.guards.length > 0 ? { guards: info.guards, guardMatch: "receiver" } : {}),
      },
      span: spanOf(rel, at),
      provenance: heur,
    });

  const emitTest = (container: NodeId, at: SyntaxNode, id: string, h: Holder, values: string[], extra: Record<string, unknown>) =>
    node({
      id,
      facet: "state",
      kind: "state.test",
      parent: container,
      attrs: { holder: h.id, values, receiver: "", ...extra },
      span: spanOf(rel, at),
      provenance: heur,
    });

  /** A comparison as a test. `thenArm` and `elseArm` are the arms of the `if` it is the condition of, when it is. */
  const emitAtomTest = (container: NodeId, a: Atom, whole: boolean, thenArm: string | undefined, elseArm: string | undefined) => {
    const key = nodeKey(a.node);
    if (emittedTests.has(key)) return;
    emittedTests.add(key);
    // `arm` is where the holder is in `values`; `elseArm` where it is not.
    const holds = a.negated ? (whole ? elseArm : undefined) : thenArm;
    const fails = a.negated ? thenArm : whole ? elseArm : undefined;
    emitTest(container, a.node, testId(rel, a.node), a.holder, [a.value], {
      ...(a.negated ? { negated: true } : {}),
      ...(holds ? { arm: holds } : {}),
      ...(fails ? { elseArm: fails } : {}),
      ...(exitTests.has(key) ? { exitGuard: true } : {}),
    });
  };

  const emitArm = (label: string, at: SyntaxNode, container: NodeId): string => {
    const id = ids.take(`${rel}@arm:${at.startPosition.row}:${at.startPosition.column}`);
    armIds.set(nodeKey(at), id);
    node({ id, facet: "flow", kind: "flow.branch-arm", parent: container, attrs: { label }, span: spanOf(rel, at), provenance: prov });
    return id;
  };

  const handleIf = (n: SyntaxNode, container: NodeId) => {
    const cons = n.childForFieldName("consequence");
    const alt = n.childForFieldName("alternative");
    const altStmt = alt?.type === "else_clause" ? alt.namedChild(0) : alt;
    const thenArm = cons ? emitArm("then", cons, container) : undefined;
    const elseArm = altStmt ? emitArm("else", altStmt, container) : undefined;
    const cond = decompose(n.childForFieldName("condition"), refCtx(n));
    for (const a of cond.atoms) emitAtomTest(container, a, cond.whole, thenArm, elseArm);
  };

  const handleSwitch = (n: SyntaxNode, container: NodeId) => {
    const cond = n.childForFieldName("condition");
    const ctx = refCtx(n);
    const disc = holderRef(cond?.type === "condition_clause" ? cond.childForFieldName("value") ?? cond.namedChildren[cond.namedChildren.length - 1] : cond, ctx);
    const arms = new Map<string, string>();
    for (const cs of (n.childForFieldName("body")?.namedChildren ?? []).filter((c) => c.type === "case_statement")) {
      const value = cs.childForFieldName("value");
      arms.set(nodeKey(cs), emitArm(value ? `case ${value.text.slice(0, 60)}` : "default", cs, container));
    }
    if (!disc) return;
    for (const g of caseGroups(n, disc, ctx)) {
      if (g.values.length === 0) continue;
      const first = g.cases[0] as SyntaxNode;
      const arm = arms.get(nodeKey(g.last));
      emitTest(container, first, testId(rel, first), disc, g.values, arm ? { arm } : {});
    }
  };

  /** A default member initialiser, a constructor initialiser, or a global's initialiser. */
  const handleInit = (h: Holder, container: NodeId, at: SyntaxNode, valueExpr: SyntaxNode | null | undefined) => {
    let v: SyntaxNode | null | undefined = valueExpr;
    if (v && (v.type === "initializer_list" || v.type === "argument_list")) v = v.namedChildren.find((c) => c.type !== "comment");
    if (!v) return;
    emitWrite(h, container, at, "init", enumerator(v, h, refCtx(at)));
  };

  const handleStateDecl = (n: SyntaxNode, container: NodeId) => {
    for (const d of n.childrenForFieldName("declarator")) {
      let nameNode: SyntaxNode = d;
      if (d.type === "init_declarator") nameNode = d.childForFieldName("declarator") ?? d;
      const h = stateIndex.byDecl.get(`${rel}|${nodeKey(d)}`);
      if (!h) continue;
      emitHolder(h, container, nameNode);
      const value = n.type === "field_declaration" ? n.childForFieldName("default_value") : d.type === "init_declarator" ? d.childForFieldName("value") : null;
      handleInit(h, container, value ?? nameNode, value);
    }
  };

  const handleAssignment = (n: SyntaxNode, container: NodeId) => {
    const w = writeOf(n, refCtx(n));
    if (!w) return;
    emitWrite(w.holder, container, n, "set", w.value, writeInfo.get(nodeKey(n)));
  };

  const handleFieldInitializer = (n: SyntaxNode, container: NodeId) => {
    if (n.parent?.type !== "field_initializer_list") return;
    const name = n.namedChild(0);
    if (name?.type !== "field_identifier") return;
    const ctx = refCtx(n);
    const h = ctx.cls !== undefined ? ctx.index.byClass.get(ctx.cls)?.get(name.text) : undefined;
    if (h) handleInit(h, container, n, n.namedChild(1));
  };

  const visit = (n: SyntaxNode, container: NodeId, fn: FnDecl | undefined): void => {
    let nextContainer = container;
    let nextFn = fn;

    switch (n.type) {
      case "preproc_include":
        handleInclude(n);
        break;
      case "namespace_definition": {
        const name = n.childForFieldName("name")?.text ?? "(anonymous)";
        const id = ids.take(`${rel}#namespace:${name}@${n.startPosition.row + 1}`);
        node({ id, facet: "structure", kind: "structure.namespace", parent: container, attrs: { name }, span: spanOf(rel, n), provenance: prov });
        nextContainer = id;
        break;
      }
      case "class_specifier":
      case "struct_specifier": {
        const nameNode = n.childForFieldName("name");
        if (nameNode && nameNode.text.trim() !== "" && n.childForFieldName("body")) {
          const qname = [...scopeOf(n).path, stripTemplates(norm(nameNode.text))].join("::");
          const id = ids.take(`${rel}#${qname}`);
          node({
            id,
            facet: "structure",
            kind: "structure.type",
            parent: container,
            attrs: { name: stripTemplates(norm(nameNode.text)), typeKind: n.type === "class_specifier" ? "class" : "struct" },
            span: spanOf(rel, n),
            provenance: prov,
          });
          nextContainer = id;
        }
        break;
      }
      case "enum_specifier": {
        const nameNode = n.childForFieldName("name");
        // Anonymous enums (and error-recovery nodes with empty text) have no usable name; skip them.
        if (nameNode && nameNode.text.trim() !== "" && n.childForFieldName("body")) {
          node({
            id: ids.take(`${rel}#enum:${[...scopeOf(n).path, nameNode.text].join("::")}`),
            facet: "structure",
            kind: "structure.type",
            parent: container,
            attrs: { name: nameNode.text, typeKind: "enum" },
            span: spanOf(rel, n),
            provenance: prov,
          });
        }
        break;
      }
      case "alias_declaration": {
        const nameNode = n.childForFieldName("name");
        if (nameNode) {
          node({
            id: ids.take(`${rel}#alias:${[...scopeOf(n).path, nameNode.text].join("::")}`),
            facet: "structure",
            kind: "structure.type",
            parent: container,
            attrs: { name: nameNode.text, typeKind: "alias" },
            span: spanOf(rel, n),
            provenance: prov,
          });
        }
        break;
      }
      case "function_definition": {
        analyzeBody(n);
        const decl = project.fns.get(`${rel}|${nodeKey(n)}`);
        if (decl) {
          node({
            id: decl.id,
            facet: "structure",
            kind: "structure.function",
            parent: container,
            attrs: { name: decl.simple, qualifiedName: decl.qname, exported: decl.exported },
            span: spanOf(rel, n),
            provenance: prov,
          });
          nextContainer = decl.id;
          nextFn = decl;
        }
        break;
      }
      case "lambda_expression": {
        analyzeBody(n);
        const decl = project.fns.get(`${rel}|${nodeKey(n)}`);
        if (decl) {
          const span = spanOf(rel, n);
          node({
            id: decl.id,
            facet: "structure",
            kind: "structure.function",
            parent: container,
            attrs: { name: decl.simple, qualifiedName: decl.qname, anonymous: true },
            span,
            provenance: prov,
          });
          // The creator reaches the closure. At module level the creator is the file.
          edge({ from: fn ? fn.id : rel, to: decl.id, facet: "calls", kind: "calls.reference", attrs: { how: "closure" }, span, provenance: prov });
          // Everything in the body belongs to the lambda: its calls, spawns, locks, and any co_await.
          nextContainer = decl.id;
          nextFn = decl;
        }
        break;
      }
      case "call_expression":
        handleCall(n, container, fn);
        break;
      case "update_expression":
        atomicUpdate(n, container);
        break;
      case "declaration":
        handleDeclaration(n, container, fn);
        handleStateDecl(n, container);
        break;
      case "field_declaration":
        handleStateDecl(n, container);
        break;
      case "field_initializer":
        handleFieldInitializer(n, container);
        break;
      case "assignment_expression":
        handleAssignment(n, container);
        break;
      case "binary_expression": {
        const a = atomOf(n, refCtx(n));
        if (a) emitAtomTest(container, a, false, undefined, undefined);
        break;
      }
      case "if_statement":
        flow(n, "if", "flow.branch", container, { condition: (n.childForFieldName("condition")?.text ?? "").slice(0, 200), ...readsAttr(n.childForFieldName("condition")) });
        handleIf(n, container);
        break;
      case "conditional_expression":
        flow(n, "cond", "flow.branch", container, { condition: (n.childForFieldName("condition")?.text ?? "").slice(0, 200), ...readsAttr(n.childForFieldName("condition")) });
        break;
      case "switch_statement": {
        const body = n.childForFieldName("body");
        const hasDefault = body?.namedChildren.some((c) => c.type === "case_statement" && !c.childForFieldName("value")) ?? false;
        flow(n, "switch", "flow.switch", container, { hasDefault });
        handleSwitch(n, container);
        break;
      }
      case "for_statement":
        flow(n, "loop", "flow.loop", container, { variant: "for", ...readsAttr(n.childForFieldName("condition")) });
        break;
      case "for_range_loop":
        // The range is what the loop reads; the loop variable is declared, not read.
        flow(n, "loop", "flow.loop", container, { variant: "for-of", ...readsAttr(n.childForFieldName("right")) });
        break;
      case "while_statement":
        flow(n, "loop", "flow.loop", container, { variant: "while", ...readsAttr(n.childForFieldName("condition")) });
        break;
      case "do_statement":
        flow(n, "loop", "flow.loop", container, { variant: "do", ...readsAttr(n.childForFieldName("condition")) });
        break;
      case "try_statement":
        flow(n, "try", "flow.try", container, { hasFinally: false });
        break;
      case "throw_statement":
        flow(n, "throw", "flow.throw", container, {});
        break;
      case "co_await_expression":
        node({
          id: ids.take(`${rel}@await:${n.startPosition.row}:${n.startPosition.column}`),
          facet: "concurrency",
          kind: "concurrency.await",
          parent: container,
          attrs: {},
          span: spanOf(rel, n),
          provenance: prov,
        });
        markCoroutine(n, fn);
        break;
      case "co_return_statement":
      case "co_yield_statement":
        markCoroutine(n, fn);
        break;
      default:
        break;
    }

    for (const child of n.namedChildren) visit(child, nextContainer, nextFn);
  };

  visit(unit.root, rel, undefined);

  // Variables and their reads and writes need the whole project's declaration index, built before any file is emitted.
  const data = emitData(project, rel, prov);
  for (const n of data.nodes) node(n);
  for (const e of data.edges) edge(e);
  // The file that declares a variable this file reads or writes is a dependency: a move or rename of the declaration re-extracts it.
  for (const e of data.edges) {
    if (typeof e.to !== "string") continue;
    const hash = e.to.indexOf("#");
    const declaring = hash > 0 ? e.to.slice(0, hash) : "";
    if (declaring !== "" && declaring !== rel && !declaring.startsWith("<")) deps.add(declaring);
  }

  if (unit.errors.length > 0) {
    const first = unit.errors[0] as SyntaxNode;
    const finding: IRFinding = {
      severity: "warning",
      message: `parse errors in ${unit.errors.length} place(s); facts from this file are inferred and may be incomplete`,
      span: spanOf(rel, first),
      provenance: { frontend: FRONTEND_ID, confidence: "exact" },
    };
    records.push({ finding });
  }

  // A guard id must name a state.test node that was emitted; drop the rest (the narrowing is still used for `from`).
  const testIds = new Set<string>();
  for (const r of records) if ("node" in r && r.node.kind === "state.test") testIds.add(r.node.id);
  for (const r of records) {
    if (!("node" in r) || r.node.kind !== "state.write") continue;
    const attrs = r.node.attrs as Record<string, unknown>;
    if (!Array.isArray(attrs.guards)) continue;
    const kept = (attrs.guards as string[]).filter((g) => testIds.has(g));
    if (kept.length === attrs.guards.length) continue;
    if (kept.length > 0) attrs.guards = kept;
    else {
      delete attrs.guards;
      delete attrs.guardMatch;
    }
  }

  return { file: rel, records, dependsOn: [...deps].sort() };
}
