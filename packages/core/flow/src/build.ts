import type { IREdge, IRNode } from "@insight/ir";
import { edgeTargets } from "@insight/sdk";
import type { CouplingClass, FlowRole, FlowSpan } from "./types.js";

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

/** One fact inside a function that takes part in the flow, reduced to what the chart needs. */
interface Ev {
  type: "call" | "await" | "spawn" | "effect" | "sync" | "branch" | "switch" | "arm" | "loop" | "block" | "try" | "return" | "throw" | "break" | "continue";
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
  /** A synchronisation or channel operation: the lock it names, and whether it takes (`acquire`) or gives (`release`) it. */
  lock?: string;
  lockOp?: "acquire" | "release";
  /** Footprint text of a sync row, without the emoji (`lock queue_mu`, `send jobs`). */
  text?: string;
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
      /** A sync row: its footprint text, without the emoji. */
      text?: string;
    }
  | { t: "term"; role: "return" | "throw" | "break" | "continue"; label: string; span?: FlowSpan; coupling?: CouplingClass }
  | { t: "fork"; role: "branch" | "switch" | "try" | "lock"; label: string; title?: string; span?: FlowSpan; arms: Arm[]; complete: boolean; lock?: string; coupling?: CouplingClass }
  | { t: "loop"; label: string; title?: string; span?: FlowSpan; body: Item[] };

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
function syncInfo(n: IRNode): { label: string; text: string; lock?: string; lockOp?: "acquire" | "release" } | undefined {
  const a = n.attrs;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const trim = (s: string) => s.replace(/\s+/g, " ").trim();
  switch (n.kind) {
    case "sync.lock-acquire":
    case "sync.rwlock-acquire":
    case "x-cpp.scoped-lock": {
      const lock = str(a.lock);
      const shared = a.mode === "shared" ? " (shared)" : "";
      return { label: `🔒 ${lock}${shared}`, text: `lock ${lock}${shared}`, lock, lockOp: "acquire" };
    }
    case "sync.lock-release": {
      const lock = str(a.lock);
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

function toEvent(n: IRNode): Ev | undefined {
  if (!n.span) return undefined;
  const base = { start: n.span.start as Pos, end: n.span.end as Pos, span: spanOf(n), children: [] as Ev[], kind: n.kind };
  const a = n.attrs;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  switch (n.kind) {
    case "flow.branch":
      return { ...base, type: "branch", rank: RANK.branch, label: clip(str(a.condition) || "condition", 60) };
    case "flow.switch":
      return { ...base, type: "switch", rank: RANK.switch, label: "switch" };
    case "flow.branch-arm":
      return { ...base, type: "arm", rank: RANK.arm, label: str(a.label) };
    case "flow.loop":
      return { ...base, type: "loop", rank: RANK.loop, label: clip(`${str(a.variant)} ${str(a.condition)}`.trim(), 60) };
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
      return { ...base, type: "sync", rank: RANK.sync, label: info.label, text: info.text, ...(info.lock !== undefined ? { lock: info.lock } : {}), ...(info.lockOp !== undefined ? { lockOp: info.lockOp } : {}) };
    }
    case "concurrency.spawn-process":
      return { ...base, type: "spawn", rank: RANK.spawn, label: `spawn process · ${str(a.target) || str(a.api)}` };
    case "concurrency.spawn-thread":
      return { ...base, type: "spawn", rank: RANK.spawn, label: `spawn thread · ${str(a.target) || str(a.api)}` };
    default:
      if (n.facet === "effects") return { ...base, type: "effect", rank: RANK.effect, label: effectLabel(n) };
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
      return [
        {
          ...step("sync", ev, ev.label, sources),
          ...(ev.lock !== undefined ? { lock: ev.lock } : {}),
          ...(ev.lockOp !== undefined ? { lockOp: ev.lockOp } : {}),
          ...(ev.text !== undefined ? { text: ev.text } : {}),
        },
      ];
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
      const wrap = { ...(wrapped?.target ? { target: wrapped.target } : {}), ...(wrapped?.targets ? { targets: wrapped.targets } : {}) };
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
      };
      return [...convertAll(head, sources), fork];
    }
    case "loop": {
      const body = ev.children.filter((c) => c.type === "block" && c.label === "body");
      const head = ev.children.filter((c) => !body.includes(c));
      const loop: Item = { t: "loop", label: ev.label, title: ev.label, ...(ev.span ? { span: ev.span } : {}), body: convertAll(body.flatMap((b) => b.children), sources) };
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
 * Lock frames. In each list, a lock acquire (or a C++ RAII guard) and the items after it, up to and including the next release
 * of the same lock in that list, become one `lock` fork: its head is the acquire, its body the rows held under the lock. With
 * no release later in the list, the frame runs to the end of the list. An acquire with nothing after it stays a plain row.
 * Nested blocks are framed first, so frames nest when locks nest.
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
  const out: Item[] = [];
  for (let i = 0; i < list.length; i++) {
    const item = list[i] as Item;
    if (item.t !== "step" || item.role !== "sync" || item.lockOp !== "acquire" || item.lock === undefined) {
      out.push(item);
      continue;
    }
    const lock = item.lock;
    let release = -1;
    for (let j = i + 1; j < list.length; j++) {
      const x = list[j];
      if (x !== undefined && x.t === "step" && x.role === "sync" && x.lockOp === "release" && x.lock === lock) {
        release = j;
        break;
      }
    }
    const end = release < 0 ? list.length : release + 1;
    if (end === i + 1) {
      out.push(item);
      continue;
    }
    const body = frameList(list.slice(i + 1, end));
    out.push({
      t: "fork",
      role: "lock",
      label: item.label,
      title: item.title ?? item.label,
      ...(item.span ? { span: item.span } : {}),
      lock,
      arms: [{ label: "", kind: "next", body }],
      complete: true,
    });
    i = end - 1;
  }
  return out;
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
export function factsForFile(file: string, nodes: Iterable<IRNode>, edges: Iterable<IREdge>, opts: { sources?: boolean } = {}): FunctionFacts[] {
  const sources = opts.sources === true;
  const allNodes = [...nodes];
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
  for (const e of edges) {
    if (e.kind !== "calls.call" || e.span?.file !== file || (!functions.has(e.from) && e.from !== file)) continue;
    const callee = typeof e.attrs?.callee === "string" ? e.attrs.callee : "call";
    const targets = edgeTargets(e);
    const target = targets.nodes[0];
    // A multi-candidate call has no resolved node: its candidates are the targets.
    const all = targets.nodes.length > 0 ? targets.nodes : targets.candidates;
    add(e.from, {
      type: "call",
      start: e.span.start as Pos,
      end: e.span.end as Pos,
      rank: RANK.call,
      label: `${callee}()`,
      span: spanOf(e),
      ...(target !== undefined ? { target } : {}),
      kind: "calls.call",
      ...(sources && all.length > 1 ? { targets: [...all] } : {}),
      children: [],
    });
  }

  const out: FunctionFacts[] = [];
  for (const fn of functions.values()) {
    fn.items = frameLocks(convertAll(nest(events.get(fn.id) ?? []), sources));
    out.push(fn);
  }
  // Statements outside every function run when the module loads.
  const top = events.get(file);
  if (top && top.length > 0) {
    out.push({ id: file, name: topLevelName(file), async: false, items: frameLocks(convertAll(nest(top), sources)) });
  }
  return out.sort((a, b) => (a.span ? a.span.start[0] : 0) - (b.span ? b.span.start[0] : 0) || a.name.localeCompare(b.name));
}
