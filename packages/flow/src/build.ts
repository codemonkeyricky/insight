import type { IREdge, IRNode } from "@insight/ir";
import { edgeTargets } from "@insight/sdk";
import type { FlowRole, FlowSpan } from "./types.js";

type Pos = readonly [number, number];
const cmp = (a: Pos, b: Pos) => a[0] - b[0] || a[1] - b[1];

/** One fact inside a function that takes part in the flow, reduced to what the chart needs. */
interface Ev {
  type: "call" | "await" | "spawn" | "effect" | "branch" | "switch" | "arm" | "loop" | "block" | "try" | "return" | "throw" | "break" | "continue";
  start: Pos;
  end: Pos;
  /** Breaks ties between events with the same range: smaller sorts outer. */
  rank: number;
  label: string;
  detail?: string;
  span?: FlowSpan;
  target?: string;
  children: Ev[];
}

/** The chart before layout: a tree of what runs in order. */
export type Item =
  | { t: "step"; role: FlowRole; label: string; title?: string; span?: FlowSpan; target?: string }
  | { t: "term"; role: "return" | "throw" | "break" | "continue"; label: string; span?: FlowSpan }
  | { t: "fork"; role: "branch" | "switch" | "try"; label: string; title?: string; span?: FlowSpan; arms: Arm[]; complete: boolean }
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

function toEvent(n: IRNode): Ev | undefined {
  if (!n.span) return undefined;
  const base = { start: n.span.start as Pos, end: n.span.end as Pos, span: spanOf(n), children: [] as Ev[] };
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
    case "flow.throw":
      return { ...base, type: "throw", rank: RANK.throw, label: "throw" };
    case "flow.jump":
      return { ...base, type: a.variant === "continue" ? "continue" : "break", rank: RANK.break, label: str(a.variant) || "break" };
    case "concurrency.await":
      return { ...base, type: "await", rank: RANK.await, label: "await" };
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
function convertAll(evs: Ev[]): Item[] {
  return evs.flatMap(convert);
}

function step(role: FlowRole, ev: Ev, label: string): Item {
  return { t: "step", role, label: clip(label, 30), title: label, ...(ev.span ? { span: ev.span } : {}), ...(ev.target ? { target: ev.target } : {}) };
}

function convert(ev: Ev): Item[] {
  switch (ev.type) {
    case "call":
      return [...convertAll(ev.children), step("call", ev, ev.label)];
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
      const items = convertAll(rest);
      if (wrapped?.type === "call") items.push(...convertAll(wrapped.children));
      if (ev.type === "await") return [...items, step("await", { ...ev, ...(wrapped?.target ? { target: wrapped.target } : {}) }, inner ? `await ${inner}` : "await")];
      // Effects keep their own label; a resolved call inside only adds the link to its target.
      return [...items, step(ev.type, { ...ev, ...(wrapped?.target ? { target: wrapped.target } : {}) }, ev.label)];
    }
    case "return":
    case "throw":
    case "break":
    case "continue":
      return [...convertAll(ev.children), { t: "term", role: ev.type, label: ev.label, ...(ev.span ? { span: ev.span } : {}) }];
    case "branch":
    case "switch": {
      const arms = ev.children.filter((c) => c.type === "arm");
      const head = ev.children.filter((c) => c.type !== "arm");
      const isSwitch = ev.type === "switch";
      const out: Arm[] = arms.map((a) => ({
        label: a.label,
        kind: isSwitch ? "case" : a.label === "then" ? "true" : "false",
        body: convertAll(a.children),
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
      return [...convertAll(head), fork];
    }
    case "loop": {
      const body = ev.children.filter((c) => c.type === "block" && c.label === "body");
      const head = ev.children.filter((c) => !body.includes(c));
      const loop: Item = { t: "loop", label: ev.label, title: ev.label, ...(ev.span ? { span: ev.span } : {}), body: convertAll(body.flatMap((b) => b.children)) };
      return [...convertAll(head), loop];
    }
    case "try": {
      const part = (label: string) => ev.children.find((c) => c.type === "block" && c.label === label);
      const tryBlock = part("try");
      const catchBlock = part("catch");
      const finallyBlock = part("finally");
      const arms: Arm[] = [{ label: "try", kind: "next", body: convertAll(tryBlock?.children ?? []) }];
      if (catchBlock) arms.push({ label: "catch", kind: "exception", body: convertAll(catchBlock.children) });
      const fork: Item = { t: "fork", role: "try", label: "try", ...(ev.span ? { span: ev.span } : {}), arms, complete: true };
      const out: Item[] = [fork];
      if (finallyBlock) {
        out.push({ t: "step", role: "marker", label: "finally", ...(finallyBlock.span ? { span: finallyBlock.span } : {}) }, ...convertAll(finallyBlock.children));
      }
      return out;
    }
    case "arm":
    case "block":
      // A region that is not under a branch, loop or try (for example an arm of a conditional inside a call) runs inline.
      return convertAll(ev.children);
  }
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
export function factsForFile(file: string, nodes: Iterable<IRNode>, edges: Iterable<IREdge>): FunctionFacts[] {
  const allNodes = [...nodes];
  const functions = new Map<string, FunctionFacts>();
  const events = new Map<string, Ev[]>();

  for (const n of allNodes) {
    if (n.kind === "structure.function" && n.span?.file === file) {
      functions.set(n.id, { id: n.id, name: String(n.attrs.qualifiedName ?? n.attrs.name ?? n.id), async: n.attrs.async === true, span: spanOf(n), items: [] });
    }
  }
  const add = (parent: string, ev: Ev) => {
    const list = events.get(parent);
    if (list) list.push(ev);
    else events.set(parent, [ev]);
  };
  for (const n of allNodes) {
    if (n.span?.file !== file || n.parent === undefined) continue;
    if (n.facet !== "flow" && n.facet !== "concurrency" && n.facet !== "effects") continue;
    const ev = toEvent(n);
    if (ev) add(n.parent, ev);
  }
  for (const e of edges) {
    if (e.kind !== "calls.call" || e.span?.file !== file || (!functions.has(e.from) && e.from !== file)) continue;
    const callee = typeof e.attrs?.callee === "string" ? e.attrs.callee : "call";
    const target = edgeTargets(e).nodes[0];
    add(e.from, {
      type: "call",
      start: e.span.start as Pos,
      end: e.span.end as Pos,
      rank: RANK.call,
      label: `${callee}()`,
      span: spanOf(e),
      ...(target !== undefined ? { target } : {}),
      children: [],
    });
  }

  const out: FunctionFacts[] = [];
  for (const fn of functions.values()) {
    fn.items = convertAll(nest(events.get(fn.id) ?? []));
    out.push(fn);
  }
  // Statements outside every function run when the module loads.
  const top = events.get(file);
  if (top && top.length > 0) {
    out.push({ id: file, name: "(module)", async: false, items: convertAll(nest(top)) });
  }
  return out.sort((a, b) => (a.span ? a.span.start[0] : 0) - (b.span ? b.span.start[0] : 0) || a.name.localeCompare(b.name));
}
