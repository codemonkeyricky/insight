import type { IREdge, IRNode } from "@insight/ir";
import { edgeTargets } from "@insight/sdk";
import type { CouplingClass, FlowRole, FlowSpan } from "./types.js";

/** A mutable variable a state row touches, as the coupling pass classifies it. */
export interface StateRef {
  /** The data.variable node's id. */
  variable: string;
  /** The variable's storage kind, as the IR records it. */
  storage: string;
  exported: boolean;
  write: boolean;
  /** The module the variable belongs to. */
  owner: string | undefined;
  /** The modules that write the variable (data.write edges), each once. */
  writers: string[];
  /** A TypeScript global property (`globalThis.x`, `window.x`, `self.x`). */
  tsGlobal: boolean;
}

/** A data.variable node and the modules that write it, for every variable of a project. */
export interface StateVariable {
  node: IRNode;
  module: string | undefined;
  writers: string[];
  /**
   * Whether the variable is mutable. A variable the frontend marks `constBound` (a const bound to a container) is mutable
   * only when some function writes it, so a never-written const table is not state.
   */
  mutable: boolean;
}

/** The project's data.variable nodes by id. A state row looks its variable up here, so the variable may be in another file. */
export type StateIndex = ReadonlyMap<string, StateVariable>;

type Pos = readonly [number, number];
const cmp = (a: Pos, b: Pos) => a[0] - b[0] || a[1] - b[1];

/**
 * The name a file's top-level code shows under: "<file basename> · top level", e.g. "main.tsx · top level". The IR names the
 * module entry "(module)", which says nothing about which file runs.
 */
export function topLevelName(file: string): string {
  const base = file.slice(file.lastIndexOf("/") + 1);
  return `${base} · top level`;
}

/** The lock or channel a sync row names. */
type SyncResource = { kind: "lock" | "channel"; name: string };

/** One fact inside a function that takes part in the flow, reduced to what the chart needs. */
interface Ev {
  type: "call" | "await" | "spawn" | "effect" | "sync" | "state" | "branch" | "switch" | "arm" | "loop" | "block" | "try" | "return" | "throw" | "break" | "continue";
  start: Pos;
  end: Pos;
  /** Breaks ties between events with the same range: smaller sorts outer. */
  rank: number;
  label: string;
  detail?: string;
  span?: FlowSpan;
  target?: string;
  /** The IR node kind (`calls.call` for a call edge). Only kept for `sources` builds. */
  kind?: string;
  /** Every candidate of a call with more than one. Only kept for `sources` builds. */
  targets?: string[];
  /** A handler the code installs (`onmessage = …`): its step opens the handler even when it is a folded lambda. */
  handler?: true;
  /** A state row: the variable it reads or writes. */
  state?: StateRef;
  /** A synchronisation or channel operation: the lock it names, and whether it takes (`acquire`) or gives (`release`) it. */
  lock?: string;
  lockOp?: "acquire" | "release";
  /** An acquire that is a C++ RAII guard: scope-bound, so its frame runs to the end of the list when it has no release. */
  scoped?: true;
  /** Footprint text of a sync row, without the emoji (`lock queue_mu`, `send jobs`). */
  text?: string;
  /** The lock or channel a sync row names, for peers. Undefined for an unnamed or dynamic one. */
  resource?: SyncResource;
  /** A call: the local(s) its result is bound or assigned to (`calls.call.attrs.binds`). */
  binds?: string | string[];
  /** A branch or loop: the local names its condition reads (`flow.branch.attrs.reads`, `flow.loop.attrs.reads`). */
  reads?: string[];
  children: Ev[];
}

/** The chart before layout: a tree of what runs in order. */
export type Item =
  | {
      t: "step";
      role: FlowRole;
      label: string;
      title?: string;
      span?: FlowSpan;
      target?: string;
      handler?: true;
      /** IR kind of the row (`sources` builds only). */
      kind?: string;
      /** All candidate targets of a multi-candidate call (`sources` builds only). */
      targets?: string[];
      /** A state row: the variable it reads or writes (coupling view only). */
      state?: StateRef;
      /** A call row: the local(s) its result is bound or assigned to. */
      binds?: string | string[];
      /** Coupling pass: the row's class. */
      coupling?: CouplingClass;
      /** Coupling pass: the classes and labels a local call hoists. */
      hoisted?: string;
      /** Coupling pass: a `⋯ n local` fold row holds the items it stands for. */
      fold?: Item[];
      foldId?: string;
      /** A sync row: the lock it names and whether it takes or gives it (lock frames are built from these). */
      lock?: string;
      lockOp?: "acquire" | "release";
      /** A sync row that is a C++ RAII guard (scope-bound). */
      scoped?: true;
      /** A sync row: its footprint text, without the emoji. */
      text?: string;
      /** A sync row: the lock or channel it names, for peers. */
      resource?: SyncResource;
      /** Coupling pass: an open fold's header row (`▾ n local`), before the rows it folds. */
      open?: boolean;
      /** Coupling pass: a state row that writes its variable. */
      write?: true;
      /** Coupling pass: a state row on module-private state the surface reaches (`◆`). */
      hidden?: true;
      /** Coupling pass: a state row on global state. */
      global?: true;
      /** Coupling pass: a write of a variable written from two or more threads with no lock held in common. */
      unguarded?: true;
    }
  | { t: "term"; role: "return" | "throw" | "break" | "continue"; label: string; span?: FlowSpan; coupling?: CouplingClass }
  | { t: "fork"; role: "branch" | "switch" | "try" | "lock"; label: string; title?: string; span?: FlowSpan; arms: Arm[]; complete: boolean; lock?: string; text?: string; resource?: SyncResource; coupling?: CouplingClass; reads?: string[] }
  | { t: "loop"; label: string; title?: string; span?: FlowSpan; body: Item[]; coupling?: CouplingClass; reads?: string[] };

export interface Arm {
  label: string;
  /** "exception" draws the arm as an error path. */
  kind: "true" | "false" | "case" | "next" | "exception";
  body: Item[];
}

const RANK: Record<Ev["type"], number> = {
  arm: 0,
  block: 0,
  branch: 1,
  switch: 1,
  loop: 1,
  try: 1,
  return: 2,
  throw: 2,
  break: 2,
  continue: 2,
  await: 3,
  spawn: 3.1,
  effect: 3.2,
  sync: 3.2,
  state: 3.4,
  call: 4,
};

const STRUCTURAL = new Set<Ev["type"]>(["branch", "switch", "arm", "loop", "block", "try"]);

const spanOf = (n: { span?: IRNode["span"] }): FlowSpan | undefined => (n.span ? { file: n.span.file, start: [...n.span.start], end: [...n.span.end] } : undefined);

function clip(text: string, max: number): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/** Text for an effect step: the short kind, then the most telling attribute. */
function effectLabel(n: IRNode): string {
  const short = n.kind.replace(/^effects\./, "");
  for (const key of ["command", "path", "url", "name", "api"]) {
    const v = n.attrs[key];
    if (typeof v === "string" && v !== "") return `${short} · ${v}`;
  }
  return short;
}

/** Text for a channel: a `<dynamic>` queue is shown as `⟨dynamic⟩`. */
const channelName = (v: unknown): string => {
  const s = typeof v === "string" ? v : "";
  return s === "" || s === "<dynamic>" ? "⟨dynamic⟩" : s;
};

/** The chart label, the footprint text (no emoji), and the lock a sync node names, for a synchronisation or channel node. */
function syncInfo(n: IRNode): { label: string; text: string; lock?: string; lockOp?: "acquire" | "release"; scoped?: true } | undefined {
  const a = n.attrs;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const trim = (s: string) => s.replace(/\s+/g, " ").trim();
  switch (n.kind) {
    case "sync.lock-acquire":
    case "sync.rwlock-acquire":
    case "x-cpp.scoped-lock": {
      const lock = str(a.lock);
      const shared = a.mode === "shared" ? " (shared)" : "";
      // An unnamed or <dynamic> lock is a plain row: no lock, so it never frames or pairs with another one.
      if (lock === "") return { label: `🔒 (unnamed)${shared}`, text: `lock (unnamed)${shared}` };
      if (lock === "<dynamic>") return { label: `🔒 ${lock}${shared}`, text: `lock ${lock}${shared}` };
      const scoped = n.kind === "x-cpp.scoped-lock" || n.kind === "sync.rwlock-acquire";
      return { label: `🔒 ${lock}${shared}`, text: `lock ${lock}${shared}`, lock, lockOp: "acquire", ...(scoped ? { scoped: true as const } : {}) };
    }
    case "sync.lock-release": {
      const lock = str(a.lock);
      if (lock === "") return { label: "🔓 (unnamed)", text: "unlock (unnamed)" };
      if (lock === "<dynamic>") return { label: "🔓 <dynamic>", text: "unlock <dynamic>" };
      return { label: `🔓 ${lock}`, text: `unlock ${lock}`, lock, lockOp: "release" };
    }
    case "sync.condvar": {
      const name = str(a.name) || str(a.api);
      const lock = str(a.lock);
      if (a.op === "wait") {
        const withLock = lock === "" ? "" : ` (${lock})`;
        return { label: trim(`⏸ wait ${name}${withLock}`), text: trim(`wait ${name}`) };
      }
      if (a.op === "notify") return { label: trim(`↻ notify ${name}`), text: trim(`notify ${name}`) };
      return { label: trim(`${str(a.op)} ${name}`), text: trim(`${str(a.op)} ${name}`) };
    }
    case "sync.semaphore": {
      const name = str(a.name) || str(a.api);
      return { label: trim(`⇅ ${str(a.op)} ${name}`), text: trim(`${str(a.op)} ${name}`) };
    }
    case "sync.atomic-op": {
      const what = str(a.api) || str(a.op);
      return { label: `⚛ ${what}`, text: `atomic ${what}` };
    }
    case "concurrency.channel-send":
      return { label: `▶ send ${channelName(a.channel)}`, text: `send ${channelName(a.channel)}` };
    case "concurrency.channel-recv":
      return { label: `◀ recv ${channelName(a.channel)}`, text: `recv ${channelName(a.channel)}` };
    default:
      return undefined;
  }
}

/** The lock or channel a sync node names, when it has a name the model can match (not empty and not `<dynamic>`). */
function syncResourceOf(n: IRNode): SyncResource | undefined {
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  switch (n.kind) {
    case "sync.lock-acquire":
    case "sync.rwlock-acquire":
    case "x-cpp.scoped-lock":
    case "sync.lock-release": {
      const lock = str(n.attrs.lock);
      return lock === "" || lock === "<dynamic>" ? undefined : { kind: "lock", name: lock };
    }
    case "concurrency.channel-send":
    case "concurrency.channel-recv": {
      const channel = str(n.attrs.channel);
      return channel === "" || channel === "<dynamic>" ? undefined : { kind: "channel", name: channel };
    }
    default:
      return undefined;
  }
}

/** The local names a branch or loop condition reads, when the record carries them. */
function readsOf(attrs: Record<string, unknown>): string[] | undefined {
  const raw = attrs.reads;
  if (!Array.isArray(raw)) return undefined;
  const reads = raw.filter((r): r is string => typeof r === "string" && r !== "");
  return reads.length > 0 ? reads : undefined;
}

/** The local(s) a call's result is bound or assigned to: one name or several. */
function bindsOf(attrs: Record<string, unknown>): string | string[] | undefined {
  const raw = attrs.binds;
  if (typeof raw === "string") return raw === "" ? undefined : raw;
  if (!Array.isArray(raw)) return undefined;
  const names = raw.filter((b): b is string => typeof b === "string" && b !== "");
  if (names.length === 0) return undefined;
  return names;
}

function toEvent(n: IRNode): Ev | undefined {
  if (!n.span) return undefined;
  const base = { start: n.span.start as Pos, end: n.span.end as Pos, span: spanOf(n), children: [] as Ev[], kind: n.kind };
  const a = n.attrs;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  switch (n.kind) {
    case "flow.branch": {
      const reads = readsOf(a);
      return { ...base, type: "branch", rank: RANK.branch, label: clip(str(a.condition) || "condition", 60), ...(reads !== undefined ? { reads } : {}) };
    }
    case "flow.switch":
      return { ...base, type: "switch", rank: RANK.switch, label: "switch" };
    case "flow.branch-arm":
      return { ...base, type: "arm", rank: RANK.arm, label: str(a.label) };
    case "flow.loop": {
      const reads = readsOf(a);
      return { ...base, type: "loop", rank: RANK.loop, label: clip(`${str(a.variant)} ${str(a.condition)}`.trim(), 60), ...(reads !== undefined ? { reads } : {}) };
    }
    case "flow.block":
      return { ...base, type: "block", rank: RANK.block, label: str(a.label) };
    case "flow.try":
      return { ...base, type: "try", rank: RANK.try, label: "try" };
    case "flow.return":
      return { ...base, type: "return", rank: RANK.return, label: "return" };
    case "flow.handler":
      // A handler the code installs: a call step that opens the handler's chart.
      return { ...base, type: "call", rank: RANK.call, label: str(a.label) || "on ▸", ...(str(a.target) ? { target: str(a.target), handler: true as const } : {}) };
    case "flow.throw":
      return { ...base, type: "throw", rank: RANK.throw, label: "throw" };
    case "flow.jump":
      return { ...base, type: a.variant === "continue" ? "continue" : "break", rank: RANK.break, label: str(a.variant) || "break" };
    case "concurrency.await":
      return { ...base, type: "await", rank: RANK.await, label: "await" };
    case "sync.lock-acquire":
    case "sync.rwlock-acquire":
    case "x-cpp.scoped-lock":
    case "sync.lock-release":
    case "sync.condvar":
    case "sync.semaphore":
    case "sync.atomic-op":
    case "concurrency.channel-send":
    case "concurrency.channel-recv": {
      const info = syncInfo(n);
      if (!info) return undefined;
      const resource = syncResourceOf(n);
      return { ...base, type: "sync", rank: RANK.sync, label: info.label, text: info.text, ...(info.lock !== undefined ? { lock: info.lock } : {}), ...(info.lockOp !== undefined ? { lockOp: info.lockOp } : {}), ...(info.scoped ? { scoped: true as const } : {}), ...(resource !== undefined ? { resource } : {}) };
    }
    case "concurrency.spawn-process":
      return { ...base, type: "spawn", rank: RANK.spawn, label: `spawn process · ${str(a.target) || str(a.api)}` };
    case "concurrency.spawn-thread":
      return { ...base, type: "spawn", rank: RANK.spawn, label: `spawn thread · ${str(a.target) || str(a.api)}` };
    default:
      if (n.facet === "effects") {
        const binds = bindsOf(a);
        return { ...base, type: "effect", rank: RANK.effect, label: effectLabel(n), ...(binds !== undefined ? { binds } : {}) };
      }
      return undefined;
  }
}

/** Arrange events into a forest: each event sits under the innermost event whose range holds it. */
function nest(events: Ev[]): Ev[] {
  events.sort((x, y) => cmp(x.start, y.start) || cmp(y.end, x.end) || x.rank - y.rank);
  const roots: Ev[] = [];
  const stack: Ev[] = [];
  for (const ev of events) {
    while (stack.length > 0) {
      const top = stack[stack.length - 1] as Ev;
      if (cmp(top.start, ev.start) <= 0 && cmp(ev.end, top.end) <= 0) break;
      stack.pop();
    }
    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(ev);
    else roots.push(ev);
    stack.push(ev);
  }
  return roots;
}

const sameRange = (a: Ev, b: Ev) => cmp(a.start, b.start) === 0 && cmp(a.end, b.end) === 0;

/** Turn the children of one event into items in source order. */
function convertAll(evs: Ev[], sources: boolean): Item[] {
  return evs.flatMap((ev) => convert(ev, sources));
}

function step(role: FlowRole, ev: Ev, label: string, sources: boolean): Extract<Item, { t: "step" }> {
  return {
    t: "step",
    role,
    label: clip(label, 30),
    title: label,
    ...(ev.span ? { span: ev.span } : {}),
    ...(ev.target ? { target: ev.target } : {}),
    ...(ev.handler ? { handler: true as const } : {}),
    ...(ev.binds !== undefined ? { binds: ev.binds } : {}),
    ...(sources && ev.kind !== undefined ? { kind: ev.kind } : {}),
    ...(sources && ev.targets !== undefined ? { targets: ev.targets } : {}),
  };
}

function convert(ev: Ev, sources: boolean): Item[] {
  switch (ev.type) {
    case "call":
      return [...convertAll(ev.children, sources), step("call", ev, ev.label, sources)];
    case "sync":
      // One row: a lock, condvar, semaphore, atomic or channel operation. A lock frame is built from the lock it names.
      // Calls inside the operation's arguments run first, so they are drawn before the operation's row.
      return [
        ...convertAll(ev.children, sources),
        {
          ...step("sync", ev, ev.label, sources),
          ...(ev.lock !== undefined ? { lock: ev.lock } : {}),
          ...(ev.lockOp !== undefined ? { lockOp: ev.lockOp } : {}),
          ...(ev.scoped ? { scoped: true as const } : {}),
          ...(ev.text !== undefined ? { text: ev.text } : {}),
          ...(ev.resource !== undefined ? { resource: ev.resource } : {}),
        },
      ];
    case "state":
      return [{ ...step("state", ev, ev.label, sources), ...(ev.state !== undefined ? { state: ev.state } : {}) }];
    case "await":
    case "spawn":
    case "effect": {
      // The call this step wraps is the same piece of code, so it is shown as one step.
      // The call and callee spans of a resolved call cover only the callee, so an await wraps its first call child.
      // Running a command is both a spawn and a proc.exec effect on one call; the spawn step stands for both.
      const kids = ev.children.flatMap((c) => (ev.type === "spawn" && c.type === "effect" && sameRange(c, ev) ? c.children : [c]));
      const wrapped = kids.find((c) => c.type === "call" && (ev.type === "await" || cmp(c.start, ev.start) === 0));
      const rest = kids.filter((c) => c !== wrapped);
      const inner = wrapped?.label ?? "";
      const items = convertAll(rest, sources);
      if (wrapped?.type === "call") items.push(...convertAll(wrapped.children, sources));
      const wrap = {
        ...(wrapped?.target ? { target: wrapped.target } : {}),
        ...(wrapped?.targets ? { targets: wrapped.targets } : {}),
        ...(wrapped?.binds !== undefined ? { binds: wrapped.binds } : {}),
      };
      if (ev.type === "await") return [...items, step("await", { ...ev, ...wrap }, inner ? `await ${inner}` : "await", sources)];
      // Effects keep their own label; a resolved call inside only adds the link to its target.
      return [...items, step(ev.type, { ...ev, ...wrap }, ev.label, sources)];
    }
    case "return":
    case "throw":
    case "break":
    case "continue":
      return [...convertAll(ev.children, sources), { t: "term", role: ev.type, label: ev.label, ...(ev.span ? { span: ev.span } : {}) }];
    case "branch":
    case "switch": {
      const arms = ev.children.filter((c) => c.type === "arm");
      const head = ev.children.filter((c) => c.type !== "arm");
      const isSwitch = ev.type === "switch";
      const out: Arm[] = arms.map((a) => ({
        label: a.label,
        kind: isSwitch ? "case" : a.label === "then" ? "true" : "false",
        body: convertAll(a.children, sources),
      }));
      let complete = true;
      if (isSwitch) {
        if (!out.some((a) => a.label === "default")) {
          out.push({ label: "no match", kind: "case", body: [] });
          complete = false;
        }
      } else if (!out.some((a) => a.label === "else")) {
        out.push({ label: "else", kind: "false", body: [] });
        complete = false;
      }
      const fork: Item = {
        t: "fork",
        role: ev.type,
        label: ev.label,
        title: ev.label,
        ...(ev.span ? { span: ev.span } : {}),
        arms: out,
        complete,
        ...(ev.reads !== undefined ? { reads: ev.reads } : {}),
      };
      return [...convertAll(head, sources), fork];
    }
    case "loop": {
      const body = ev.children.filter((c) => c.type === "block" && c.label === "body");
      const head = ev.children.filter((c) => !body.includes(c));
      const loop: Item = { t: "loop", label: ev.label, title: ev.label, ...(ev.span ? { span: ev.span } : {}), body: convertAll(body.flatMap((b) => b.children), sources), ...(ev.reads !== undefined ? { reads: ev.reads } : {}) };
      return [...convertAll(head, sources), loop];
    }
    case "try": {
      const part = (label: string) => ev.children.find((c) => c.type === "block" && c.label === label);
      const tryBlock = part("try");
      const catchBlock = part("catch");
      const finallyBlock = part("finally");
      const arms: Arm[] = [{ label: "try", kind: "next", body: convertAll(tryBlock?.children ?? [], sources) }];
      if (catchBlock) arms.push({ label: "catch", kind: "exception", body: convertAll(catchBlock.children, sources) });
      const fork: Item = { t: "fork", role: "try", label: "try", ...(ev.span ? { span: ev.span } : {}), arms, complete: true };
      const out: Item[] = [fork];
      if (finallyBlock) {
        out.push({ t: "step", role: "marker", label: "finally", ...(finallyBlock.span ? { span: finallyBlock.span } : {}) }, ...convertAll(finallyBlock.children, sources));
      }
      return out;
    }
    case "arm":
    case "block":
      // A region that is not under a branch, loop or try (for example an arm of a conditional inside a call) runs inline.
      return convertAll(ev.children, sources);
  }
}

/**
 * Lock frames. In each list, a lock acquire and the items after it, up to and including the release that closes it, become
 * one `lock` fork: its head is the acquire, its body the rows held under the lock. An acquire frames only when it has a
 * release later in the list, or when it is a C++ RAII guard (scope-bound), which then runs to the end of the list. Any other
 * acquire with no release (a Web Lock, held only inside its callback) stays a plain row. Two frames that cross (they overlap
 * without one holding the other) are not framed: both stay plain rows in source order. Nested blocks are framed first, so
 * frames nest when locks nest.
 */
export function frameLocks(items: Item[]): Item[] {
  const framed = items.map((item): Item => {
    if (item.t === "fork") return { ...item, arms: item.arms.map((a) => ({ ...a, body: frameLocks(a.body) })) };
    if (item.t === "loop") return { ...item, body: frameLocks(item.body) };
    return item;
  });
  return frameList(framed);
}

function frameList(list: Item[]): Item[] {
  // Pair each acquire with the release that closes it: per lock name, a release closes the most recent open acquire.
  const release = new Map<number, number>();
  const open = new Map<string, number[]>();
  list.forEach((x, j) => {
    if (x.t !== "step" || x.role !== "sync" || x.lock === undefined) return;
    if (x.lockOp === "acquire") {
      const stack = open.get(x.lock);
      if (stack) stack.push(j);
      else open.set(x.lock, [j]);
    } else if (x.lockOp === "release") {
      const i = open.get(x.lock)?.pop();
      if (i !== undefined) release.set(i, j);
    }
  });
  // A frame head is an acquire with a matched release, or a C++ RAII guard, which runs to the end of the list.
  const isHead = (i: number): boolean => {
    const item = list[i];
    return isAcquire(item) && (release.has(i) || item.scoped === true);
  };
  const endOf = (i: number): number => (release.has(i) ? (release.get(i) as number) + 1 : list.length);
  const heads = list.flatMap((_, i) => (isHead(i) ? [i] : []));
  // A frame that crosses another frame (they overlap, and neither holds the other) is not framed.
  const crosses = (i: number): boolean => {
    const e = endOf(i);
    return heads.some((k) => {
      if (k === i) return false;
      const ek = endOf(k);
      return (i < k && k < e && e < ek) || (k < i && i < ek && ek < e);
    });
  };
  const out: Item[] = [];
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    const e = endOf(i);
    if (!isAcquire(item) || !isHead(i) || e === i + 1 || crosses(i)) {
      out.push(item as Item);
      continue;
    }
    const body = frameList(list.slice(i + 1, e));
    out.push({
      t: "fork",
      role: "lock",
      label: item.label,
      title: item.title ?? item.label,
      ...(item.span ? { span: item.span } : {}),
      lock: item.lock,
      ...(item.text !== undefined ? { text: item.text } : {}),
      ...(item.resource !== undefined ? { resource: item.resource } : {}),
      arms: [{ label: "", kind: "next", body }],
      complete: true,
    });
    i = e - 1;
  }
  return out;
}

/**
 * Merges each run of consecutive reads of one variable within a list into the first read's row. Nested lists are merged too.
 * A row of any other kind between two reads keeps them apart.
 */
export function mergeStateReads(items: Item[]): Item[] {
  const out: Item[] = [];
  for (const item of items) {
    const prev = out[out.length - 1];
    if (
      item.t === "step" && item.role === "state" && item.state !== undefined && !item.state.write &&
      prev?.t === "step" && prev.role === "state" && prev.state !== undefined && !prev.state.write && prev.target === item.target
    ) continue;
    if (item.t === "fork") out.push({ ...item, arms: item.arms.map((a) => ({ ...a, body: mergeStateReads(a.body) })) });
    else if (item.t === "loop") out.push({ ...item, body: mergeStateReads(item.body) });
    else out.push(item);
  }
  return out;
}

/** A lock acquire, or a C++ RAII guard, that names its lock: the head of a lock frame. */
function isAcquire(item: Item | undefined): item is Item & { t: "step"; role: "sync"; lockOp: "acquire"; lock: string } {
  return item !== undefined && item.t === "step" && item.role === "sync" && item.lockOp === "acquire" && item.lock !== undefined;
}

export interface FunctionFacts {
  id: string;
  name: string;
  async: boolean;
  span?: FlowSpan;
  items: Item[];
}

/**
 * Group a file's IR records by the function that owns them and rebuild each function's flow.
 * `nodes` and `edges` may hold more than the file; records from other files are ignored.
 */
export function factsForFile(file: string, nodes: Iterable<IRNode>, edges: Iterable<IREdge>, opts: { sources?: boolean; state?: StateIndex } = {}): FunctionFacts[] {
  const sources = opts.sources === true;
  const allNodes = [...nodes];
  const allEdges = [...edges];
  const functions = new Map<string, FunctionFacts>();
  const events = new Map<string, Ev[]>();

  for (const n of allNodes) {
    if (n.kind === "structure.function" && n.span?.file === file) {
      // A module entry is named by its file, "<basename> · top level", not by the IR's "(module)".
      const name = n.attrs.module === true ? topLevelName(file) : String(n.attrs.qualifiedName ?? n.attrs.name ?? n.id);
      functions.set(n.id, { id: n.id, name, async: n.attrs.async === true, span: spanOf(n), items: [] });
    }
  }
  // An anonymous handler is named by what it handles, "<basename> · on message", not by its "λ16:17".
  for (const n of allNodes) {
    if (n.kind !== "flow.handler" || n.span?.file !== file) continue;
    const f = functions.get(String(n.attrs.target ?? ""));
    const event = String(n.attrs.event ?? "");
    if (f !== undefined && event !== "" && /(^|\.)λ[^.]*$/.test(f.name)) f.name = `${file.slice(file.lastIndexOf("/") + 1)} · on ${event}`;
  }
  const add = (parent: string, ev: Ev) => {
    const list = events.get(parent);
    if (list) list.push(ev);
    else events.set(parent, [ev]);
  };
  for (const n of allNodes) {
    if (n.span?.file !== file || n.parent === undefined) continue;
    if (n.facet !== "flow" && n.facet !== "concurrency" && n.facet !== "effects" && n.facet !== "sync") continue;
    const ev = toEvent(n);
    if (ev) add(n.parent, ev);
  }
  for (const e of allEdges) {
    if (e.kind !== "calls.call" || e.span?.file !== file || (!functions.has(e.from) && e.from !== file)) continue;
    const callee = typeof e.attrs?.callee === "string" ? e.attrs.callee : "call";
    const targets = edgeTargets(e);
    const target = targets.nodes[0];
    // A multi-candidate call has no resolved node: its candidates are the targets.
    const all = targets.nodes.length > 0 ? targets.nodes : targets.candidates;
    const binds = bindsOf(e.attrs ?? {});
    add(e.from, {
      type: "call",
      start: e.span.start as Pos,
      end: e.span.end as Pos,
      rank: RANK.call,
      label: `${callee}()`,
      span: spanOf(e),
      ...(target !== undefined ? { target } : {}),
      kind: "calls.call",
      ...(binds !== undefined ? { binds } : {}),
      ...(sources && all.length > 1 ? { targets: [...all] } : {}),
      children: [],
    });
  }

  // State rows: a read or write of a mutable variable. Immutable variables get no row. Module-level code is keyed by its file.
  const state = opts.state;
  for (const e of allEdges) {
    if ((e.kind !== "data.read" && e.kind !== "data.write") || e.span?.file !== file || state === undefined) continue;
    const varId = typeof e.to === "string" ? e.to : undefined;
    const sv = varId === undefined ? undefined : state.get(varId);
    if (varId === undefined || sv === undefined || !sv.mutable) continue;
    // The edge's own `from` is the owner. The module entry `<file>#(module)` is a real function node, so it stays; the
    // bare file id is kept only for a module with no entry node (C++ top-level code, or a file with no module entry).
    const parent = functions.has(e.from) || e.from !== `${file}#(module)` ? e.from : file;
    if (!functions.has(parent) && parent !== file) continue;
    const write = e.kind === "data.write";
    const name = String(sv.node.attrs.qualifiedName ?? sv.node.attrs.name ?? varId);
    const ref: StateRef = {
      variable: varId,
      storage: String(sv.node.attrs.storage ?? ""),
      exported: sv.node.attrs.exported === true,
      write,
      owner: sv.module,
      writers: [...sv.writers],
      tsGlobal: /^(globalThis|window|self)\./.test(name),
    };
    add(parent, {
      type: "state",
      start: e.span.start as Pos,
      end: e.span.end as Pos,
      rank: RANK.state,
      label: `${write ? "▲" : "▽"} ${name}`,
      span: spanOf(e),
      target: varId,
      kind: e.kind,
      state: ref,
      children: [],
    });
  }

  const out: FunctionFacts[] = [];
  for (const fn of functions.values()) {
    fn.items = mergeStateReads(frameLocks(convertAll(nest(events.get(fn.id) ?? []), sources)));
    out.push(fn);
  }
  // Statements outside every function run when the module loads.
  const top = events.get(file);
  if (top && top.length > 0) {
    out.push({ id: file, name: topLevelName(file), async: false, items: mergeStateReads(frameLocks(convertAll(nest(top), sources))) });
  }
  return out.sort((a, b) => (a.span ? a.span.start[0] : 0) - (b.span ? b.span.start[0] : 0) || a.name.localeCompare(b.name));
}
