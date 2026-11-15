import { isExternal, ownerOf, type Confidence, type IRView, type Lens, type LensContext, type LensFinding, type LensResult, type StateMachineView, type TableView, type ViewSpan } from "@insight/sdk";
import type { IREdge, IRNode, NodeId } from "@insight/ir";

/** Synthetic state values. They never collide with a domain value, which is JSON-quoted, numeric or `Type.Member`. */
export const INIT = "●";
export const ANY = "*";

const RANK: Record<Confidence, number> = { exact: 0, inferred: 1, heuristic: 2 };
const weaker = (a: Confidence, b: Confidence): Confidence => (RANK[a] >= RANK[b] ? a : b);
const stronger = (a: Confidence, b: Confidence): Confidence => (RANK[a] <= RANK[b] ? a : b);

export interface Site {
  span?: ViewSpan;
  fn?: string;
  guard?: string;
  event?: string;
  confidence: Confidence;
}

export interface Transition {
  id: string;
  /** A domain value, `●` or `*`. */
  from: string;
  to: string;
  label: string;
  /** As certain as the best site: one exact site proves the transition exists. */
  confidence: Confidence;
  sites: Site[];
}

export interface MachineState {
  value: string;
  id: string;
  label: string;
  kind: "initial" | "any" | "state" | "unentered";
  span?: ViewSpan;
}

export interface Machine {
  holderId: string;
  name: string;
  file?: string;
  domainKind: "enum" | "union" | "open";
  /** False when the holder node is not in the view (declared outside the scope). */
  declared: boolean;
  domain: string[];
  span?: ViewSpan;
  states: MachineState[];
  transitions: Transition[];
  unguarded: number;
  dynamic: number;
  notes: string[];
}

export interface StateModel {
  machines: Machine[];
  counts: {
    holders: number;
    holdersSkipped: number;
    unguardedWrites: number;
    dynamicWrites: number;
    testsWithoutArm: number;
    staleWrites: number;
  };
  /** Per holder, the values some write or init produces. */
  written: Map<string, Set<string>>;
}

interface Write {
  node: IRNode;
  holder: string;
  op: "init" | "set";
  value?: string;
  dynamic: boolean;
  from?: string[];
  fromEntry: boolean;
  stale: boolean;
  guardMatch?: string;
  event?: string;
  guardText?: string;
  ownerLabel?: string;
  owner?: IRNode;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
const strs = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined);

const posOf = (n: IRNode): [number, number, string] => [n.span?.start[0] ?? Number.MAX_SAFE_INTEGER, n.span?.start[1] ?? 0, n.id];
const compareNodes = (a: IRNode, b: IRNode): number => {
  const [al, ac, ai] = posOf(a);
  const [bl, bc, bi] = posOf(b);
  return (a.span?.file ?? "").localeCompare(b.span?.file ?? "") || al - bl || ac - bc || ai.localeCompare(bi);
};

/** The domain's spelling: `"idle"` -> idle, `Phase.Idle` -> Idle, numbers and `∅` as they are. */
export function displayValue(value: string): string {
  if (value === INIT) return "start";
  if (value === ANY) return "any state";
  if (value.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed === "string") return parsed;
    } catch {
      /* fall through */
    }
  }
  const m = /^[A-Za-z_$][\w$]*\.(.+)$/.exec(value);
  return m?.[1] ?? value;
}

const nameOfFn = (n: IRNode | undefined): string | undefined => {
  if (!n) return undefined;
  const name = str(n.attrs.name);
  if (name) return name;
  const hash = n.id.lastIndexOf("#");
  return hash >= 0 ? n.id.slice(hash + 1) : undefined;
};

/**
 * State machines from state facts. For each holder with in-scope writes or tests, a write becomes arcs
 * `f -> value` for each `f` in its `from`, `* -> value` when nothing bounds the entry state, and `● -> value`
 * for an init. A write with no `from` but `fromEntry` takes its entry set from the exact callers' `knownState`, or a caller's callers when the call has `knownEntry` (depth <= 2);
 * any caller without one keeps `*` in the set, and the arcs are inferred.
 *
 * Limits: a holder is the one id on `attrs.holder`; instances of a type share a machine. Dynamic writes give
 * no arc. External stubs hold no writes or tests of this scope and are skipped.
 */
export function stateMachines(view: IRView): StateModel {
  const holderNodes = new Map<string, IRNode>();
  for (const n of view.nodes({ facet: "state", kind: "state.holder" })) if (!isExternal(n)) holderNodes.set(n.id, n);

  const writes: Write[] = [];
  for (const n of view.nodes({ facet: "state", kind: "state.write" })) {
    if (isExternal(n)) continue;
    const holder = str(n.attrs.holder);
    if (!holder) continue;
    const dynamic = n.attrs.dynamic === true;
    const value = str(n.attrs.value);
    const op = n.attrs.op === "init" ? "init" : "set";
    const from = strs(n.attrs.from);
    const w: Write = {
      node: n,
      holder,
      op,
      dynamic: dynamic || value === undefined,
      fromEntry: n.attrs.fromEntry === true,
      stale: n.attrs.stale === true,
      owner: ownerOf(view, n.id),
    };
    if (value !== undefined && !dynamic) w.value = value;
    if (from && from.length > 0) w.from = from;
    const gm = str(n.attrs.guardMatch);
    if (gm) w.guardMatch = gm;
    const ev = str(n.attrs.event);
    if (ev) w.event = ev;
    const ol = str(n.attrs.ownerLabel);
    if (ol) w.ownerLabel = ol;
    const gt = str(n.attrs.guardText);
    if (gt) w.guardText = gt;
    writes.push(w);
  }
  writes.sort((a, b) => compareNodes(a.node, b.node));

  const tests: IRNode[] = view
    .nodes({ facet: "state", kind: "state.test" })
    .filter((n) => !isExternal(n) && str(n.attrs.holder) !== undefined)
    .sort(compareNodes);

  // ---- cross-call entry sets -------------------------------------------------------------
  interface Entry {
    vals: Set<string>;
    star: boolean;
    any: boolean;
  }
  /** `knownEntry` names the holders a call's caller knows the entry state of. Two forms are read: a sorted list of holder ids (what the frontend emits) or a map keyed by holder id. */
  const hasKnownEntry = (e: IREdge, holder: string): boolean => {
    const ke = (e as IREdge & { attrs?: Record<string, unknown> }).attrs?.knownEntry;
    if (Array.isArray(ke)) return ke.includes(holder);
    if (ke && typeof ke === "object") return Boolean((ke as Record<string, unknown>)[holder]);
    return false;
  };
  const hasCalls = view.hasFacet("calls");
  const entryCache = new Map<string, Entry>();
  const entryOf = (fn: NodeId, holder: string, depth: number, visiting: Set<NodeId>): Entry => {
    const key = `${fn}\0${holder}\0${depth}`;
    const cached = entryCache.get(key);
    if (cached) return cached;
    const out: Entry = { vals: new Set(), star: false, any: false };
    const callers = hasCalls ? view.in(fn, { facet: "calls" }).filter((e) => e.kind !== "calls.contains-call") : [];
    if (callers.length === 0) out.star = true;
    const next = new Set(visiting).add(fn);
    for (const e of callers) {
      const exact = e.kind === "calls.call" && typeof e.to === "string" && e.provenance.confidence === "exact";
      const ks = (e as IREdge & { attrs?: Record<string, unknown> }).attrs?.knownState;
      const known = ks && typeof ks === "object" ? strs((ks as Record<string, unknown>)[holder]) : undefined;
      if (exact && known && known.length > 0) {
        for (const v of known) out.vals.add(v);
        out.any = true;
      } else if (exact && depth < 1 && !next.has(e.from) && hasKnownEntry(e, holder)) {
        const sub = entryOf(e.from, holder, depth + 1, next);
        for (const v of sub.vals) out.vals.add(v);
        if (sub.star) out.star = true;
        if (sub.any) out.any = true;
      } else {
        out.star = true;
      }
    }
    entryCache.set(key, out);
    return out;
  };

  // ---- per-holder facts ------------------------------------------------------------------
  const holderIds = new Set<string>([...holderNodes.keys(), ...writes.map((w) => w.holder), ...tests.map((t) => t.attrs.holder as string)]);
  const writesBy = new Map<string, Write[]>();
  for (const w of writes) writesBy.set(w.holder, [...(writesBy.get(w.holder) ?? []), w]);
  const testsBy = new Map<string, IRNode[]>();
  for (const t of tests) testsBy.set(t.attrs.holder as string, [...(testsBy.get(t.attrs.holder as string) ?? []), t]);

  const written = new Map<string, Set<string>>();
  const machines: Machine[] = [];
  let holdersSkipped = 0;
  let unguardedWrites = 0;
  let dynamicWrites = 0;
  let staleWrites = 0;
  let testsWithoutArm = 0;
  for (const t of tests) if (str(t.attrs.arm) === undefined && str(t.attrs.elseArm) === undefined && t.attrs.exitGuard !== true) testsWithoutArm++;
  for (const w of writes) {
    if (w.stale) staleWrites++;
    if (w.dynamic) dynamicWrites++;
    else if (w.op === "set" && !w.from) unguardedWrites++;
  }

  for (const holderId of [...holderIds].sort()) {
    const hw = writesBy.get(holderId) ?? [];
    const ht = testsBy.get(holderId) ?? [];
    const node = holderNodes.get(holderId);
    const writtenValues = new Set<string>();
    for (const w of hw) if (w.value !== undefined) writtenValues.add(w.value);
    written.set(holderId, writtenValues);
    // A7: at least two distinct written values (init included) and at least one `set` write.
    if (writtenValues.size < 2 || !hw.some((w) => w.op === "set")) {
      holdersSkipped++;
      continue;
    }

    const hash = holderId.indexOf("#");
    const domainKind = node ? (str(node.attrs.domainKind) as Machine["domainKind"] | undefined) ?? "open" : "open";
    const domain = node ? strs(node.attrs.values) ?? [] : [];
    const trans = new Map<string, Transition>();
    const addArc = (from: string, to: string, label: string, site: Site) => {
      const key = `${from}\0${to}\0${label}`;
      const t = trans.get(key);
      if (t) {
        t.sites.push(site);
        t.confidence = stronger(t.confidence, site.confidence);
      } else {
        trans.set(key, { id: `${holderId}|${from}>${to}#${label}`, from, to, label, confidence: site.confidence, sites: [site] });
      }
    };

    let unguarded = 0;
    let dynamic = 0;
    for (const w of hw) {
      if (w.dynamic || w.value === undefined) {
        dynamic++;
        continue;
      }
      const ownerName = nameOfFn(w.owner);
      const isFn = w.owner?.kind === "structure.function" || w.owner?.kind.startsWith("structure.function") === true;
      const label = w.event ?? (isFn ? w.ownerLabel ?? ownerName : undefined) ?? (w.op === "init" ? "init" : ownerName ?? "write");
      let base: Confidence = w.node.provenance.confidence;
      if (w.guardMatch === "holder") base = weaker(base, "inferred");
      if (w.stale) base = weaker(base, "inferred");
      const site = (confidence: Confidence): Site => ({
        ...(w.node.span ? { span: w.node.span } : {}),
        ...(ownerName ? { fn: ownerName } : {}),
        ...(w.guardText ? { guard: w.guardText } : {}),
        ...(w.event ? { event: w.event } : {}),
        confidence,
      });
      if (w.op === "init") {
        addArc(INIT, w.value, label, site(base));
        continue;
      }
      if (w.from) {
        for (const f of [...new Set(w.from)].sort()) addArc(f, w.value, label, site(base));
        continue;
      }
      unguarded++;
      const entry = w.fromEntry && w.owner && w.owner.kind === "structure.function" ? entryOf(w.owner.id, holderId, 0, new Set()) : undefined;
      if (entry?.any) {
        const conf = weaker(base, "inferred");
        for (const v of [...entry.vals].sort()) addArc(v, w.value, label, site(conf));
        if (entry.star) addArc(ANY, w.value, label, site(conf));
      } else {
        addArc(ANY, w.value, label, site(base));
      }
    }

    // States: synthetic, then declared domain order, then any other written or tested value.
    const entered = new Set<string>();
    let usesInit = false;
    let usesAny = false;
    const sources = new Set<string>();
    for (const t of trans.values()) {
      entered.add(t.to);
      sources.add(t.from);
      sources.add(t.to);
      if (t.from === INIT) usesInit = true;
      if (t.from === ANY) usesAny = true;
    }
    const known = new Set(domain);
    const extras = new Set<string>();
    for (const v of sources) if (v !== INIT && v !== ANY && !known.has(v)) extras.add(v);
    for (const t of ht) for (const v of strs(t.attrs.values) ?? []) if (!known.has(v)) extras.add(v);
    const order = [...(usesInit ? [INIT] : []), ...(usesAny ? [ANY] : []), ...domain, ...[...extras].sort()];
    const firstEntering = new Map<string, ViewSpan>();
    for (const t of trans.values()) for (const s of t.sites) if (s.span && !firstEntering.has(t.to)) firstEntering.set(t.to, s.span);
    const states: MachineState[] = order.map((value) => {
      const kind: MachineState["kind"] = value === INIT ? "initial" : value === ANY ? "any" : known.has(value) && !entered.has(value) ? "unentered" : "state";
      const span = firstEntering.get(value) ?? node?.span;
      return { value, id: `${holderId}|${value}`, label: displayValue(value), kind, ...(span && value !== INIT && value !== ANY ? { span } : {}) };
    });
    const idx = new Map(order.map((v, i) => [v, i]));
    const transitions = [...trans.values()].sort(
      (a, b) => (idx.get(a.from) ?? 0) - (idx.get(b.from) ?? 0) || (idx.get(a.to) ?? 0) - (idx.get(b.to) ?? 0) || a.label.localeCompare(b.label),
    );

    const notes: string[] = [];
    if (!node) notes.push("Holder declared outside this scope: domain unknown");
    else if (domainKind === "open") notes.push("Domain unknown");
    if (dynamic > 0) notes.push(`${dynamic} dynamic write${dynamic === 1 ? "" : "s"} not drawn`);

    machines.push({
      holderId,
      name: node ? str(node.attrs.name) ?? holderId : hash >= 0 ? holderId.slice(hash + 1) : holderId,
      ...(node?.span ? { file: node.span.file } : hash > 0 ? { file: holderId.slice(0, hash) } : {}),
      domainKind,
      declared: node !== undefined,
      domain,
      ...(node?.span ? { span: node.span } : {}),
      states,
      transitions,
      unguarded,
      dynamic,
      notes,
    });
  }

  machines.sort((a, b) => b.transitions.length - a.transitions.length || a.holderId.localeCompare(b.holderId));
  return {
    machines,
    counts: { holders: holderIds.size, holdersSkipped, unguardedWrites, dynamicWrites, testsWithoutArm, staleWrites },
    written,
  };
}

const lineOf = (span: ViewSpan | undefined): number | null => (span ? span.start[0] + 1 : null);

function findingsFor(view: IRView, model: StateModel): LensFinding[] {
  const out: LensFinding[] = [];
  const holders = new Map<string, IRNode>();
  for (const n of view.nodes({ facet: "state", kind: "state.holder" })) if (!isExternal(n)) holders.set(n.id, n);
  const writeCount = new Map<string, number>();
  for (const w of view.nodes({ facet: "state", kind: "state.write" })) {
    if (isExternal(w)) continue;
    const h = str(w.attrs.holder);
    if (h) writeCount.set(h, (writeCount.get(h) ?? 0) + 1);
  }
  const testsBy = new Map<string, IRNode[]>();
  for (const t of view.nodes({ facet: "state", kind: "state.test" })) {
    const h = str(t.attrs.holder);
    if (isExternal(t) || !h) continue;
    testsBy.set(h, [...(testsBy.get(h) ?? []), t]);
  }
  const dynamicHolders = new Set<string>();
  for (const w of view.nodes({ facet: "state", kind: "state.write" })) {
    const h = str(w.attrs.holder);
    if (!isExternal(w) && h && (w.attrs.dynamic === true || str(w.attrs.value) === undefined)) dynamicHolders.add(h);
  }
  // Only holders drawn as machines (A7) can have value-coverage findings.
  const drawn = new Set(model.machines.map((m) => m.holderId));
  for (const [holderId, holder] of holders) {
    if (!drawn.has(holderId)) continue;
    if (dynamicHolders.has(holderId)) continue;
    if (holder.attrs.domainKind === "open" || (writeCount.get(holderId) ?? 0) === 0) continue;
    const writtenValues = model.written.get(holderId) ?? new Set<string>();
    // A4: a narrowed use of a shared enum is not a bug, so ask for at least three distinct written values.
    if (writtenValues.size >= 3) {
      for (const v of strs(holder.attrs.values) ?? []) {
        if (writtenValues.has(v)) continue;
        out.push({
          lens: "lens-states",
          id: `unentered:${holderId}|${v}`,
          severity: "warning",
          message: `${str(holder.attrs.name) ?? holderId} is never set to ${displayValue(v)}`,
          nodes: [holderId],
          ...(holder.span ? { span: holder.span } : {}),
        });
      }
    }
    for (const t of testsBy.get(holderId) ?? []) {
      const dead = (strs(t.attrs.values) ?? []).filter((v) => !writtenValues.has(v));
      if (dead.length === 0) continue;
      out.push({
        lens: "lens-states",
        id: `dead-test:${t.id}`,
        severity: "info",
        message: `${str(holder.attrs.name) ?? holderId} is tested for ${dead.map(displayValue).join(", ")}, but nothing sets it`,
        nodes: [t.id],
        ...(t.span ? { span: t.span } : {}),
      });
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export const lensStates: Lens = {
  id: "lens-states",
  title: "States",
  requires: ["structure", "state"],
  optional: ["flow", "calls"],

  async run(view: IRView, ctx: LensContext): Promise<LensResult> {
    const model = stateMachines(view);
    const projectPass = ctx.scope === undefined || ctx.scope === "";
    const findings = projectPass ? findingsFor(view, model) : [];

    const views: LensResult["views"] = [];
    if (model.machines.length > 0) {
      for (const m of model.machines) {
        const v: StateMachineView = {
          type: "state-machine",
          id: `machine:${m.holderId}`,
          title: m.name,
          holder: { id: m.holderId, name: m.name, ...(m.file ? { file: m.file } : {}), domainKind: m.domainKind, ...(m.span ? { span: m.span } : {}) },
          states: m.states.map((s) => ({ id: s.id, label: s.label, kind: s.kind, ...(s.span ? { span: s.span } : {}) })),
          transitions: m.transitions.map((t) => ({
            id: t.id,
            from: `${m.holderId}|${t.from}`,
            to: `${m.holderId}|${t.to}`,
            label: t.label,
            confidence: t.confidence,
            sites: t.sites.map((s) => ({ ...(s.span ? { span: s.span } : {}), ...(s.fn ? { fn: s.fn } : {}), ...(s.guard ? { guard: s.guard } : {}), confidence: s.confidence })),
          })),
          ...(m.notes.length > 0 ? { notes: m.notes } : {}),
        };
        views.push(v);
      }
      const count = (m: Machine, c: Confidence) => m.transitions.filter((t) => t.confidence === c).length;
      const machinesTable: TableView = {
        type: "table",
        id: "machines",
        title: "State machines",
        columns: ["Holder", "File", "Domain", "States", "Transitions", "Exact", "Inferred", "Unguarded", "Dynamic"],
        rows: model.machines.map((m) => [
          m.name,
          m.file ?? "",
          m.domainKind === "open" ? "unknown" : m.domain.map(displayValue).join(", "),
          m.states.length,
          m.transitions.length,
          count(m, "exact"),
          count(m, "inferred") + count(m, "heuristic"),
          m.unguarded,
          m.dynamic,
        ]),
        spans: model.machines.map((m) => m.span ?? null),
      };
      const rows: TableView["rows"] = [];
      const spans: (ViewSpan | null)[] = [];
      for (const m of model.machines) {
        for (const t of m.transitions) {
          for (const s of t.sites) {
            rows.push([m.name, displayValue(t.from), displayValue(t.to), s.event ?? "", s.guard ?? "", s.confidence, s.fn ?? "", lineOf(s.span)]);
            spans.push(s.span ?? null);
          }
        }
      }
      views.push(machinesTable, { type: "table", id: "transitions", title: "Transitions", columns: ["Holder", "From", "To", "Event", "Guard", "Confidence", "Function", "Line"], rows, spans });
    }

    const arcs = model.machines.flatMap((m) => m.transitions);
    return {
      findings,
      views,
      metrics: {
        holders: model.counts.holders,
        machines: model.machines.length,
        states: model.machines.reduce((n, m) => n + m.states.length, 0),
        transitions: arcs.length,
        exact: arcs.filter((t) => t.confidence === "exact").length,
        inferred: arcs.filter((t) => t.confidence === "inferred").length,
        heuristic: arcs.filter((t) => t.confidence === "heuristic").length,
        unguardedWrites: model.counts.unguardedWrites,
        dynamicWrites: model.counts.dynamicWrites,
        holdersSkipped: model.counts.holdersSkipped,
        testsWithoutArm: model.counts.testsWithoutArm,
        staleWrites: model.counts.staleWrites,
      },
    };
  },
};

export default lensStates;
