import type { SyntaxNode } from "./parser.js";
import { blockOf, baseTypeOf, declaredVariable, lockIdentity, nodeKey, norm, ownerOf, scopeOf, type Project } from "./project.js";

/** Guard types and whether they hold the lock shared. */
export const GUARDS: Record<string, "exclusive" | "shared"> = {
  "std::lock_guard": "exclusive",
  "std::unique_lock": "exclusive",
  "std::scoped_lock": "exclusive",
  "std::shared_lock": "shared",
};
/** Arguments of a guard that do not take the lock. */
export const NO_LOCK_ARGS = new Set(["std::defer_lock", "std::try_to_lock", "std::adopt_lock"]);

/** The value of a channel, lock or name that is not a literal or a plain name. */
export const DYNAMIC = "<dynamic>";

/** A lock-free queue type, and the methods that send to it and receive from it. */
const LOCKFREE_QUEUES: Record<string, { send: string[]; recv: string[] }> = {
  "boost::lockfree::queue": { send: ["push"], recv: ["pop"] },
  "boost::lockfree::spsc_queue": { send: ["push"], recv: ["pop"] },
  "moodycamel::ConcurrentQueue": { send: ["enqueue", "try_enqueue"], recv: ["try_dequeue"] },
  "folly::MPMCQueue": { send: ["write", "blockingWrite"], recv: ["read", "blockingRead"] },
  "tbb::concurrent_queue": { send: ["push"], recv: ["try_pop"] },
};
/** Standard containers that can be a guarded queue: members only, and only when a lock is seen on both sides. */
const STD_QUEUES = new Set(["std::queue", "std::deque"]);
const STD_SEND = new Set(["push", "push_back", "emplace", "emplace_back"]);
const STD_RECV = new Set(["pop", "pop_front", "front"]);

const SEMAPHORES = new Set(["std::counting_semaphore", "std::binary_semaphore"]);
const SEMAPHORE_OPS: Record<string, "acquire" | "release"> = {
  acquire: "acquire",
  try_acquire: "acquire",
  try_acquire_for: "acquire",
  try_acquire_until: "acquire",
  release: "release",
};
const CONDVARS = new Set(["std::condition_variable", "std::condition_variable_any"]);
const CONDVAR_OPS: Record<string, "wait" | "notify"> = {
  wait: "wait",
  wait_for: "wait",
  wait_until: "wait",
  notify_one: "notify",
  notify_all: "notify",
};
const ATOMIC_METHODS = new Set([
  "load",
  "store",
  "fetch_add",
  "fetch_sub",
  "fetch_and",
  "fetch_or",
  "fetch_xor",
  "exchange",
  "compare_exchange_weak",
  "compare_exchange_strong",
]);

/** The POSIX semaphore and condition variable calls, by name. */
export const POSIX_SEM_OPS: Record<string, "acquire" | "release"> = {
  sem_wait: "acquire",
  sem_trywait: "acquire",
  sem_timedwait: "acquire",
  sem_post: "release",
};
export const POSIX_COND_OPS: Record<string, { op: "wait" | "notify"; lock: boolean }> = {
  pthread_cond_wait: { op: "wait", lock: true },
  pthread_cond_timedwait: { op: "wait", lock: true },
  pthread_cond_signal: { op: "notify", lock: false },
  pthread_cond_broadcast: { op: "notify", lock: false },
};

export const LOCKFREE_SEND_RECV = LOCKFREE_QUEUES;
export const SEMAPHORE_OP = (base: string, method: string): "acquire" | "release" | undefined =>
  SEMAPHORES.has(base) ? SEMAPHORE_OPS[method] : undefined;
export const CONDVAR_OP = (base: string, method: string): "wait" | "notify" | undefined =>
  CONDVARS.has(base) ? CONDVAR_OPS[method] : undefined;
export const isAtomicMethod = (base: string, method: string): boolean => base === "std::atomic" && ATOMIC_METHODS.has(method);

/** A name the expression refers to: a variable, or a member reached through `this->`. */
export interface Ref {
  name: string;
  viaThis: boolean;
}

/** The variable an expression names, past `&`, `*` and parentheses. Other expressions name nothing. */
export function refOf(n: SyntaxNode | null | undefined): Ref | undefined {
  let x = n;
  while (x && (x.type === "pointer_expression" || x.type === "parenthesized_expression" || x.type === "parameter_declaration")) {
    // A guard's argument in a function body parses as a parameter whose type is the name: `std::lock_guard g(mu_);`.
    if (x.type === "parameter_declaration") x = x.childForFieldName("type");
    else x = x.type === "parenthesized_expression" ? x.namedChild(0) : x.childForFieldName("argument");
  }
  if (!x) return undefined;
  if (x.type === "identifier" || x.type === "type_identifier") return { name: x.text, viaThis: false };
  if (x.type === "field_expression" && x.childForFieldName("argument")?.type === "this") {
    const field = x.childForFieldName("field");
    return field ? { name: field.text, viaThis: true } : undefined;
  }
  return undefined;
}

/** A simple name in an argument, as a POSIX call names its semaphore or condition variable, or <dynamic> when it is not one. */
export function nameText(n: SyntaxNode | undefined): string {
  if (!n) return DYNAMIC;
  const text = norm(n.text).replace(/^&/, "");
  return /^[A-Za-z_]\w*(?:(?:\.|->|::)[A-Za-z_]\w*)*$/.test(text) ? text : DYNAMIC;
}

/** The arguments a declaration passes to its object, in either spelling: `T v(a, b)` or `T v{a, b}`. */
export function declArgs(decl: SyntaxNode): SyntaxNode[] {
  const declarator = decl.childForFieldName("declarator");
  const list = (n: SyntaxNode | null | undefined) => (n?.namedChildren ?? []).filter((c) => c.type !== "comment");
  if (declarator?.type === "function_declarator") return list(declarator.childForFieldName("parameters"));
  if (declarator?.type === "init_declarator") {
    const value = declarator.childForFieldName("value");
    if (value?.type === "argument_list" || value?.type === "initializer_list") return list(value);
  }
  return [];
}

/** The innermost function or lambda body a node sits in. */
export function enclosingFunction(n: SyntaxNode): SyntaxNode | undefined {
  for (let p = n.parent; p; p = p.parent) if (p.type === "function_definition" || p.type === "lambda_expression") return p;
  return undefined;
}

/** Node identity. web-tree-sitter wraps a node afresh on each access, so objects are compared by position and type. */
const sameNode = (a: SyntaxNode | undefined, b: SyntaxNode | undefined): boolean => a !== undefined && b !== undefined && nodeKey(a) === nodeKey(b);

/** The class a node's code belongs to: its enclosing class, or the class of the out-of-line function it is in. */
export function classAt(project: Project, rel: string, n: SyntaxNode): string | undefined {
  return scopeOf(n).cls ?? ownerOf(n, project.fns, rel)?.cls;
}

/** A variable a name refers to. A local has the declaration that introduces it. */
export interface Var {
  type: string;
  /** The identity used for a queue, semaphore or condition variable: "Class::member", a qualified global, or <dynamic>. */
  channel: string;
  scope: "local" | "member" | "global";
  decl?: SyntaxNode;
}

/** The declaration of a local or parameter that the name refers to at this use, if any. The last one before the use wins. */
function localDecl(name: string, use: SyntaxNode): SyntaxNode | undefined {
  const fn = enclosingFunction(use);
  if (!fn) return undefined;
  let best: SyntaxNode | undefined;
  for (const d of fn.descendantsOfType(["declaration", "parameter_declaration"])) {
    if (d.startIndex >= use.startIndex || declaredVariable(d) !== name) continue;
    if (!best || d.startIndex > best.startIndex) best = d;
  }
  return best;
}

/**
 * The declared type of a name at a use. Locals shadow members and members shadow globals, as in C++ lookup.
 * A `this->` name skips locals and globals. A global is found in the use's namespaces, innermost first.
 */
export function resolveVar(project: Project, name: string, use: SyntaxNode, cls: string | undefined, viaThis = false): Var | undefined {
  if (!viaThis) {
    const decl = localDecl(name, use);
    if (decl) return { type: baseTypeOf(decl), channel: DYNAMIC, scope: "local", decl };
  }
  const member = cls !== undefined ? project.fieldTypes.get(cls)?.get(name) : undefined;
  if (member !== undefined && cls !== undefined) return { type: member, channel: `${cls}::${name}`, scope: "member" };
  if (viaThis) return undefined;
  const path = scopeOf(use).path;
  for (let i = path.length; i >= 0; i--) {
    const qualified = [...path.slice(0, i), name].join("::");
    const type = project.globals.get(qualified);
    if (type !== undefined) return { type, channel: qualified, scope: "global" };
  }
  return undefined;
}

/**
 * The locks a function holds at a site: a guard whose block contains the site, and a lock() with no unlock()
 * of the same lock between it and the site. Locks from other functions (lambdas inside) do not count.
 */
export function locksHeldAt(site: SyntaxNode, cls: string | undefined, members: Project["members"]): Set<string> {
  const held = new Set<string>();
  const fn = enclosingFunction(site);
  if (!fn) return held;
  const same = (n: SyntaxNode) => sameNode(enclosingFunction(n), fn);
  for (const decl of fn.descendantsOfType("declaration")) {
    if (decl.startIndex > site.startIndex || !same(decl)) continue;
    const mode = GUARDS[baseTypeOf(decl)];
    const block = blockOf(decl);
    if (mode === undefined || !block || site.endIndex > block.endIndex) continue;
    for (const arg of declArgs(decl)) if (!NO_LOCK_ARGS.has(norm(arg.text))) held.add(lockIdentity(arg.text, cls, members));
  }
  const events = fn.descendantsOfType("call_expression").filter((c) => {
    const f = c.childForFieldName("function");
    return c.startIndex < site.startIndex && f?.type === "field_expression" && (c.childForFieldName("arguments")?.namedChildCount ?? 0) === 0 && same(c);
  });
  events.sort((a, b) => a.startIndex - b.startIndex);
  for (const c of events) {
    const f = c.childForFieldName("function");
    const method = f?.childForFieldName("field")?.text;
    const recv = f?.childForFieldName("argument")?.text;
    if (recv === undefined || (method !== "lock" && method !== "unlock")) continue;
    const lock = lockIdentity(recv, cls, members);
    if (method === "lock") held.add(lock);
    else held.delete(lock);
  }
  return held;
}

/** A call of a std queue member, as a send or a receive, with the channel it works on. */
export function stdQueueCall(project: Project, rel: string, call: SyntaxNode): { channel: string; side: "send" | "recv" } | undefined {
  const f = call.childForFieldName("function");
  if (f?.type !== "field_expression") return undefined;
  const method = f.childForFieldName("field")?.text ?? "";
  const side = STD_SEND.has(method) ? "send" : STD_RECV.has(method) ? "recv" : undefined;
  const ref = refOf(f.childForFieldName("argument"));
  if (!side || !ref) return undefined;
  const v = resolveVar(project, ref.name, call, classAt(project, rel, call), ref.viaThis);
  if (!v || v.scope !== "member" || !STD_QUEUES.has(v.type)) return undefined;
  return { channel: v.channel, side };
}

const guardedCache = new WeakMap<Project, Map<string, string>>();

/**
 * Std queue members inferred to be guarded: a lock held at a push or emplace in some function, and the same lock
 * held at a pop or front in some function. Maps the channel to the lock (the first one both sides share, sorted).
 * Computed once per project, because the two sides can sit in different files.
 */
export function guardedQueues(project: Project): Map<string, string> {
  const cached = guardedCache.get(project);
  if (cached) return cached;
  const sends = new Map<string, Set<string>>();
  const recvs = new Map<string, Set<string>>();
  for (const [rel, unit] of project.units) {
    for (const call of unit.root.descendantsOfType("call_expression")) {
      const q = stdQueueCall(project, rel, call);
      if (!q) continue;
      const side = q.side === "send" ? sends : recvs;
      const set = side.get(q.channel) ?? new Set<string>();
      for (const lock of locksHeldAt(call, classAt(project, rel, call), project.members)) set.add(lock);
      side.set(q.channel, set);
    }
  }
  const out = new Map<string, string>();
  for (const [channel, held] of sends) {
    const recv = recvs.get(channel);
    if (!recv) continue;
    const common = [...held].filter((l) => recv.has(l)).sort();
    if (common.length > 0) out.set(channel, common[0] as string);
  }
  guardedCache.set(project, out);
  return out;
}

/** The lock a condition variable wait is given: the mutex behind the unique_lock passed as its first argument. */
export function waitLock(project: Project, call: SyntaxNode, arg: SyntaxNode | undefined, cls: string | undefined): string | undefined {
  const ref = refOf(arg);
  if (!ref || ref.viaThis) return undefined;
  const v = resolveVar(project, ref.name, call, cls);
  const lockArg = v?.decl ? declArgs(v.decl)[0] : undefined;
  return lockArg ? lockIdentity(lockArg.text, cls, project.members) : undefined;
}
