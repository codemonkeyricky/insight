import type { IREdge, IRNode, NodeId, Provenance } from "@insight/ir";

export interface ShardEdge {
  edge: IREdge;
  /** The shard file the edge came from. Used as the caller file when the caller has no file ancestor. */
  file: string;
}

/** What one frontend's build graph can link for a caller: its targets' dependency closure. */
interface Reach {
  targets: Set<NodeId>;
  /** A target in the closure has an unresolved dependency, so the closure is incomplete and gives no "not linked". */
  open: boolean;
}

/** C and C++ header-like files. Their code is compiled into each includer, so the includer's link closure decides. */
const HEADER_RE = /\.(?:h|hh|hpp|hxx|h\+\+|inc|inl|ipp|tcc|cuh)$/i;

/** Template argument lists removed, nested ones too: `Foo<T>::bar` becomes `Foo::bar`. Unclosed `<` drops the rest. */
// A copy of stripTemplates in packages/frontend/cpp/src/project.ts. Keep the two in step.
const ANGLE_OPERATOR_SYMBOLS = ["<=>", "<<=", ">>=", "<<", ">>", "<=", ">=", "<", ">"];

function angleOperatorAt(s: string, i: number): { text: string; end: number } | undefined {
  if (!s.startsWith("operator", i) || (i > 0 && /[\w$]/.test(s[i - 1] ?? ""))) return undefined;
  let j = i + "operator".length;
  if (/[\w$]/.test(s[j] ?? "")) return undefined;
  while (j < s.length && /\s/.test(s[j] ?? "")) j++;
  const sym = ANGLE_OPERATOR_SYMBOLS.find((x) => s.startsWith(x, j));
  return sym ? { text: `operator${sym}`, end: j + sym.length } : undefined;
}

function stripTemplateArgs(s: string): string {
  const out: string[] = [];
  let depth = 0;
  let parens = 0;
  let i = 0;
  while (i < s.length) {
    if (depth === 0) {
      const op = angleOperatorAt(s, i);
      if (op) {
        out.push(op.text);
        i = op.end;
        continue;
      }
    }
    const ch = s[i];
    let len = 1;
    let bracket = false;
    if (s.startsWith("<=>", i)) len = 3;
    else if (s.startsWith("<=", i) || s.startsWith(">=", i) || s.startsWith("<<", i)) len = 2;
    else if (s.startsWith(">>", i)) {
      len = 2;
      if (parens === 0 && depth > 0) {
        depth = Math.max(0, depth - 2);
        bracket = true;
      }
    } else if (ch === "<") {
      if (parens === 0) {
        depth++;
        bracket = true;
      }
    } else if (ch === ">") {
      if (parens === 0 && depth > 0) {
        depth--;
        bracket = true;
      }
    } else if (ch === "(") parens++;
    else if (ch === ")") parens = Math.max(0, parens - 1);
    if (!bracket && depth === 0) out.push(s.slice(i, i + len));
    i += len;
  }
  return out.join("");
}

/**
 * How a candidate fared. `linked`: a shared frontend's build graph says one of its owners is in the caller's reach,
 * or the reach is open. `kept`: kept without build-graph evidence (a method, no file, or no shared frontend). `dropped`:
 * a shared frontend says not linked and none says linked.
 */
type Verdict = "linked" | "kept" | "dropped";

/**
 * Narrows ambiguous `calls.call` candidates with the build graph, per build system (the frontend that owns each
 * target). For each frontend that owns both the caller's file and the candidate's file: the candidate is linked when
 * one of its owners is in the caller's dependency closure, or when that closure is open. A candidate is dropped only
 * when some shared frontend says not linked and none says linked. A candidate with no shared frontend (or in no
 * target) is kept. Methods (see `isMethod`) are always kept, so narrowing only drops free functions.
 *
 * A call from a C/C++ header (see `HEADER_RE`) is never narrowed: header code is compiled into each includer, so
 * the includer's link closure decides, and this pass only knows the header owner's closure.
 *
 * An edge narrowed to one target is promoted from "heuristic" to "inferred" only when that target was `linked`.
 * A survivor kept for any other reason (a method, no file, no shared frontend) keeps its confidence.
 *
 * Edits edges in place and returns how many changed. Never adds edges.
 */
export function narrowByBuildGraph(nodes: ReadonlyMap<NodeId, IRNode>, edges: ShardEdge[]): number {
  const owners = new Map<NodeId, Set<NodeId>>();
  const deps = new Map<NodeId, NodeId[]>();
  const openTargets = new Set<NodeId>();
  for (const { edge } of edges) {
    if (edge.kind === "packaging.target-contains" && typeof edge.to === "string") {
      if (nodes.get(edge.from)?.kind !== "packaging.build-target") continue;
      const set = owners.get(edge.to) ?? new Set<NodeId>();
      set.add(edge.from);
      owners.set(edge.to, set);
    } else if (edge.kind === "packaging.dep-edge") {
      if (nodes.get(edge.from)?.kind !== "packaging.build-target") continue;
      if (typeof edge.to === "string") {
        if (nodes.get(edge.to)?.kind !== "packaging.build-target") continue;
        const list = deps.get(edge.from) ?? [];
        list.push(edge.to);
        deps.set(edge.from, list);
      } else if ("unresolved" in edge.to) {
        openTargets.add(edge.from);
      }
    }
  }

  const fileOf = (id: NodeId): NodeId | undefined => {
    let current: NodeId | undefined = id;
    const seen = new Set<NodeId>();
    while (current !== undefined && !seen.has(current)) {
      seen.add(current);
      const node = nodes.get(current);
      if (!node) return undefined;
      if (node.kind === "structure.file") return node.id;
      current = node.parent;
    }
    return undefined;
  };

  const frontendOf = (target: NodeId): string => nodes.get(target)?.provenance.frontend ?? "";

  /** The owners of a file, grouped by the frontend that owns them. */
  const ownersByFrontend = (file: NodeId): Map<string, Set<NodeId>> => {
    const grouped = new Map<string, Set<NodeId>>();
    for (const t of owners.get(file) ?? []) {
      const f = frontendOf(t);
      const set = grouped.get(f) ?? new Set<NodeId>();
      set.add(t);
      grouped.set(f, set);
    }
    return grouped;
  };

  /** Names (simple and qualified) of every structure.type in the IR, built once. */
  const typeNames = new Set<string>();
  for (const n of nodes.values()) {
    if (n.kind !== "structure.type") continue;
    const name = n.attrs?.name;
    if (typeof name === "string") typeNames.add(name);
    const qn = n.attrs?.qualifiedName;
    if (typeof qn === "string") typeNames.add(qn);
  }

  /**
   * A method: (a) its parent chain reaches a structure.type before the structure.file, or (b) its qualified name
   * is `<prefix>::<name>` where the last segment of `<prefix>` names a structure.type. (b) covers out-of-line
   * definitions, which the C++ frontend parents to the file rather than to the type.
   */
  const isMethod = (id: NodeId): boolean => {
    const seen = new Set<NodeId>();
    let cur = nodes.get(id)?.parent;
    while (cur !== undefined && !seen.has(cur)) {
      seen.add(cur);
      const n = nodes.get(cur);
      if (!n) break;
      if (n.kind === "structure.type") return true;
      if (n.kind === "structure.file") break;
      cur = n.parent;
    }
    const node = nodes.get(id);
    const raw = node?.attrs?.qualifiedName ?? node?.attrs?.name;
    if (typeof raw !== "string") return false;
    const name = stripTemplateArgs(raw);
    const sep = name.lastIndexOf("::");
    if (sep <= 0) return false;
    const prefixLast = name.slice(0, sep).split("::").pop() ?? "";
    return typeNames.has(prefixLast) || typeNames.has(name.slice(0, sep));
  };

  const closures = new Map<NodeId, Reach>();
  const closureOf = (target: NodeId): Reach => {
    const cached = closures.get(target);
    if (cached) return cached;
    const out = new Set<NodeId>([target]);
    const stack = [target];
    let open = false;
    while (stack.length > 0) {
      const next = stack.pop() as NodeId;
      if (openTargets.has(next)) open = true;
      for (const d of deps.get(next) ?? []) {
        if (!out.has(d)) {
          out.add(d);
          stack.push(d);
        }
      }
    }
    const reach = { targets: out, open };
    closures.set(target, reach);
    return reach;
  };

  let narrowed = 0;
  for (const entry of edges) {
    const { edge } = entry;
    if (edge.kind !== "calls.call") continue;
    const to = edge.to;
    if (typeof to !== "object" || !("candidates" in to)) continue;

    const callerFile = fileOf(edge.from) ?? entry.file;
    if (HEADER_RE.test(callerFile)) continue;
    const callerByFrontend = ownersByFrontend(callerFile);
    if (callerByFrontend.size === 0) continue;

    const reachByFrontend = new Map<string, Reach>();
    for (const [f, targets] of callerByFrontend) {
      const reach: Reach = { targets: new Set<NodeId>(), open: false };
      for (const t of targets) {
        const c = closureOf(t);
        for (const x of c.targets) reach.targets.add(x);
        if (c.open) reach.open = true;
      }
      reachByFrontend.set(f, reach);
    }

    /**
     * Dropped only when some shared frontend says not linked and none says linked. Methods are never dropped: virtual
     * dispatch can reach any override, including a sibling implementation the caller's binary links.
     */
    const verdictOf = (candidate: NodeId): Verdict => {
      if (isMethod(candidate)) return "kept";
      const file = fileOf(candidate);
      if (file === undefined) return "kept";
      const candidateByFrontend = ownersByFrontend(file);
      let shared = 0;
      for (const [f, reach] of reachByFrontend) {
        const candidateOwners = candidateByFrontend.get(f);
        if (!candidateOwners) continue;
        shared++;
        if (reach.open) return "linked";
        for (const t of candidateOwners) if (reach.targets.has(t)) return "linked";
      }
      return shared === 0 ? "kept" : "dropped";
    };

    const candidates = to.candidates;
    const verdicts = candidates.map((c) => ({ id: c, verdict: verdictOf(c) }));
    const survivors = verdicts.filter((v) => v.verdict !== "dropped");
    if (survivors.length === 0 || survivors.length === candidates.length) continue;

    const [first, ...rest] = survivors.map((v) => v.id) as [NodeId, ...NodeId[]];
    edge.to = rest.length === 0 ? first : { candidates: [first, ...rest] };
    const provenance: Provenance = {
      ...edge.provenance,
      resolvedBy: edge.provenance.resolvedBy ? `${edge.provenance.resolvedBy}+build-graph` : "build-graph",
    };
    const lone = survivors.length === 1 ? survivors[0] : undefined;
    if (lone?.verdict === "linked" && edge.provenance.confidence === "heuristic") provenance.confidence = "inferred";
    edge.provenance = provenance;
    narrowed++;
  }
  return narrowed;
}
