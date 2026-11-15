import type { IREdge, NodeId } from "@insight/ir";
import type { Lens, LensFinding, TableView } from "@insight/sdk";

type View = Parameters<Lens["run"]>[0];

/** Switches for the build-graph rules. Each rule is on unless its switch is set to false. */
export interface BuildGraphConfig {
  undeclared?: boolean;
  unused?: boolean;
  visibility?: boolean;
}

export interface BuildGraphRun {
  findings: LensFinding[];
  table: TableView;
  metrics: { undeclaredDependencies: number; unusedDependencies: number; visibilityViolations: number };
}

const LENS = "lens-dependencies";
const BUILD_TARGET = "packaging.build-target";
const EXTERNAL = "packaging.external";
const PACKAGE = "structure.package";
const FILE = "structure.file";
/** Header files, by extension. A target that owns one can be used through includes. */
const HEADER_FILE = /\.(h|hh|hpp|hxx|inc|ipp)$/i;

/** A target's dependency closure: the targets and externals it reaches, and whether a dependency is unresolved. */
interface Reach {
  targets: Set<NodeId>;
  externals: Set<NodeId>;
  open: boolean;
}

function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function addTo<K, V>(map: Map<K, Set<V>>, key: K, value: V): void {
  const set = map.get(key);
  if (set) set.add(value);
  else map.set(key, new Set([value]));
}

/** "allowed" when an entry admits the package, "denied" when none does, "unknown" when an entry can't be read. */
function visibleTo(entries: unknown[], pkg: string): "allowed" | "denied" | "unknown" {
  let unknown = false;
  for (const entry of entries) {
    if (typeof entry !== "string") {
      unknown = true;
      continue;
    }
    if (entry === "//visibility:public") return "allowed";
    if (entry === "//visibility:private") continue;
    // Another repository's package (@repo//pkg:__pkg__ or __subpackages__) admits no package of this one.
    if (/^@[^/]+\/\/[^:]*:(__pkg__|__subpackages__)$/.test(entry)) continue;
    const m = /^(\/\/[^:]*):(__pkg__|__subpackages__)$/.exec(entry);
    if (!m) {
      unknown = true;
      continue;
    }
    const p = m[1] ?? "";
    const admits = m[2] === "__pkg__" ? pkg === p : p === "//" || pkg === p || pkg.startsWith(`${p}/`);
    if (admits) return "allowed";
  }
  return unknown ? "unknown" : "denied";
}

/**
 * The build-graph rules (undeclared include, unused dependency, visibility violation). They read the packaging facts
 * a build-system frontend emits. Each frontend's graph is checked on its own, so a file owned by targets of two build
 * systems gets one verdict per build system. Returns undefined when the project has no build targets, so a project
 * without them gets no extra metrics or view.
 */
export function buildGraphRules(view: View, config: BuildGraphConfig): BuildGraphRun | undefined {
  const targetNodes = view.nodes({ kind: BUILD_TARGET });
  if (targetNodes.length === 0) return undefined;
  const targetIds = new Set(targetNodes.map((n) => n.id));
  const labelOf = (id: NodeId): string => {
    const label = view.node(id)?.attrs.label;
    return typeof label === "string" ? label : id;
  };

  // Ownership and dependencies, from the packaging facts.
  const filesOf = new Map<NodeId, Set<NodeId>>();
  const ownersOf = new Map<NodeId, Set<NodeId>>();
  for (const e of view.edges({ kind: "packaging.target-contains" })) {
    if (!targetIds.has(e.from) || typeof e.to !== "string") continue;
    addTo(filesOf, e.from, e.to);
    addTo(ownersOf, e.to, e.from);
  }
  const deps = new Map<NodeId, NodeId[]>();
  const externalDeps = new Map<NodeId, Set<NodeId>>();
  const openTargets = new Set<NodeId>();
  for (const e of view.edges({ kind: "packaging.dep-edge" })) {
    if (!targetIds.has(e.from)) continue;
    if (typeof e.to === "string") {
      if (targetIds.has(e.to)) pushTo(deps, e.from, e.to);
      else if (view.node(e.to)?.kind === EXTERNAL) addTo(externalDeps, e.from, e.to);
    } else if ("unresolved" in e.to) {
      openTargets.add(e.from);
    }
  }

  // Includes, grouped by the file they start in.
  const includes: IREdge[] = [];
  const includesByFile = new Map<NodeId, NodeId[]>();
  const mappableExternals = new Set<NodeId>();
  for (const e of view.edges({ kind: "packaging.include" })) {
    if (typeof e.to !== "string") continue;
    includes.push(e);
    pushTo(includesByFile, e.from, e.to);
    if (view.node(e.to)?.kind === EXTERNAL) mappableExternals.add(e.to);
  }

  // Each target's closure is computed once. A file's closure per frontend is the union over its owners.
  const closures = new Map<NodeId, Reach>();
  const closureOf = (start: NodeId): Reach => {
    const cached = closures.get(start);
    if (cached) return cached;
    const targets = new Set<NodeId>([start]);
    const externals = new Set<NodeId>();
    let open = false;
    const stack = [start];
    while (stack.length > 0) {
      const t = stack.pop() as NodeId;
      if (openTargets.has(t)) open = true;
      for (const x of externalDeps.get(t) ?? []) externals.add(x);
      for (const d of deps.get(t) ?? []) {
        if (!targets.has(d)) {
          targets.add(d);
          stack.push(d);
        }
      }
    }
    const reach: Reach = { targets, externals, open };
    closures.set(start, reach);
    return reach;
  };

  const groupCache = new Map<NodeId, Map<string, NodeId[]>>();
  /** The owners of a file, grouped by the frontend that owns them (the target node's provenance). */
  const ownerGroups = (file: NodeId): Map<string, NodeId[]> => {
    const cached = groupCache.get(file);
    if (cached) return cached;
    const groups = new Map<string, NodeId[]>();
    for (const t of [...(ownersOf.get(file) ?? [])].sort()) {
      pushTo(groups, view.node(t)?.provenance.frontend ?? "", t);
    }
    groupCache.set(file, groups);
    return groups;
  };

  const reachCache = new Map<string, Reach>();
  const reachOfFile = (file: NodeId, frontend: string): Reach => {
    const key = `${file}\0${frontend}`;
    const cached = reachCache.get(key);
    if (cached) return cached;
    const union: Reach = { targets: new Set(), externals: new Set(), open: false };
    for (const t of ownerGroups(file).get(frontend) ?? []) {
      const c = closureOf(t);
      for (const x of c.targets) union.targets.add(x);
      for (const x of c.externals) union.externals.add(x);
      if (c.open) union.open = true;
    }
    reachCache.set(key, union);
    return union;
  };

  const findings: LensFinding[] = [];
  const rows: TableView["rows"] = [];
  const counts = { undeclared: 0, unused: 0, visibility: 0 };
  const seen = new Set<string>();
  const emit = (
    rule: keyof typeof counts,
    f: { id: string; severity: LensFinding["severity"]; message: string; nodes: NodeId[]; span?: IREdge["span"] },
    from: string,
    to: string,
    detail: string,
  ): void => {
    if (seen.has(f.id)) return;
    seen.add(f.id);
    counts[rule]++;
    findings.push({
      lens: LENS,
      id: f.id,
      severity: f.severity,
      message: f.message,
      nodes: f.nodes,
      ...(f.span ? { span: f.span } : {}),
    });
    rows.push([rule === "undeclared" ? "undeclared" : rule === "unused" ? "unused" : "visibility", from, to, detail]);
  };

  // Undeclared: an include whose target is not in the closure of the includer's owners, in a frontend that owns both.
  if (config.undeclared !== false) {
    for (const e of includes) {
      const a = e.from;
      const b = e.to as NodeId;
      const bNode = view.node(b);
      const external = bNode?.kind === EXTERNAL;
      if (!external && bNode?.kind !== FILE) continue;
      const groupsA = ownerGroups(a);
      if (groupsA.size === 0) continue;
      const groupsB = external ? undefined : ownerGroups(b);
      let evidence: string | undefined;
      let declared = false;
      for (const f of [...groupsA.keys()].sort()) {
        if (external ? bNode?.provenance.frontend !== f : !groupsB?.has(f)) continue;
        const reach = reachOfFile(a, f);
        const linked = external
          ? reach.externals.has(b)
          : (groupsB?.get(f) ?? []).some((t) => reach.targets.has(t));
        if (linked) {
          declared = true;
          break;
        }
        if (!reach.open) evidence ??= f;
      }
      if (declared || evidence === undefined) continue;
      const ownerA = groupsA.get(evidence)?.[0] as NodeId;
      const ownerB = external ? b : (groupsB?.get(evidence)?.[0] as NodeId);
      emit(
        "undeclared",
        {
          id: `undeclared:${a}>${b}`,
          severity: "warning",
          message: `${a} includes ${b}, but ${labelOf(ownerA)} does not depend on ${external ? b : labelOf(ownerB)}`,
          nodes: [ownerA, ownerB],
          ...(e.span ? { span: e.span } : {}),
        },
        a,
        b,
        `${labelOf(ownerA)} has no dependency path to it`,
      );
    }
  }

  if (config.unused !== false || config.visibility !== false) {
    // Function-level call graph, for the unused rule's "reaches" check.
    const callees = new Map<NodeId, NodeId[]>();
    if (config.unused !== false) {
      for (const e of view.edges({ kind: "calls.call" })) {
        const to = e.to;
        const list = typeof to === "string" ? [to] : "candidates" in to ? [...to.candidates] : [];
        for (const c of list) pushTo(callees, e.from, c);
      }
    }

    if (config.unused !== false) {
      const fileMemo = new Map<NodeId, NodeId | undefined>();
      const fileOf = (id: NodeId): NodeId | undefined => {
        if (fileMemo.has(id)) return fileMemo.get(id);
        let cur: NodeId | undefined = id;
        let result: NodeId | undefined;
        for (let i = 0; cur !== undefined && i < 64; i++) {
          const n = view.node(cur);
          if (!n) break;
          if (n.kind === FILE) {
            result = n.id;
            break;
          }
          cur = n.parent;
        }
        fileMemo.set(id, result);
        return result;
      };
      const callersByFile = new Map<NodeId, NodeId[]>();
      for (const caller of callees.keys()) {
        const f = fileOf(caller);
        if (f !== undefined) pushTo(callersByFile, f, caller);
      }
      const reachedMemo = new Map<NodeId, Set<NodeId>>();
      /** The files of every function a function in the target's files reaches through calls. */
      const reachedFiles = (t: NodeId): Set<NodeId> => {
        const cached = reachedMemo.get(t);
        if (cached) return cached;
        const visited = new Set<NodeId>();
        const stack: NodeId[] = [];
        for (const f of filesOf.get(t) ?? []) {
          for (const caller of callersByFile.get(f) ?? []) {
            for (const c of callees.get(caller) ?? []) {
              if (!visited.has(c)) {
                visited.add(c);
                stack.push(c);
              }
            }
          }
        }
        while (stack.length > 0) {
          const n = stack.pop() as NodeId;
          for (const c of callees.get(n) ?? []) {
            if (!visited.has(c)) {
              visited.add(c);
              stack.push(c);
            }
          }
        }
        const files = new Set<NodeId>();
        for (const n of visited) {
          const f = fileOf(n);
          if (f !== undefined) files.add(f);
        }
        reachedMemo.set(t, files);
        return files;
      };

      // Files that define main(). A target linked for its entry point is used by no call, so it is not unused.
      const mainFiles = new Set<NodeId>();
      for (const n of view.nodes({ kind: "structure.function" })) {
        if (n.attrs.name !== "main") continue;
        const f = fileOf(n.id);
        if (f !== undefined) mainFiles.add(f);
      }

      for (const t of [...targetIds].sort()) {
        const tFiles = filesOf.get(t);
        if (!tFiles || tFiles.size === 0) continue;
        const includeTo = new Set<NodeId>();
        for (const f of tFiles) for (const x of includesByFile.get(f) ?? []) includeTo.add(x);
        const definesMain = [...tFiles].some((f) => mainFiles.has(f));

        for (const u of [...new Set(deps.get(t) ?? [])].sort()) {
          if (u === t) continue;
          const uFiles = filesOf.get(u);
          if (!uFiles || uFiles.size === 0) continue;
          if ([...uFiles].some((f) => includeTo.has(f))) continue;
          if (!definesMain && [...uFiles].some((f) => mainFiles.has(f))) continue;
          // A provider with no header is used only by linking (a main() from a macro, static registration), which
          // includes and calls cannot show.
          if (![...uFiles].some((f) => HEADER_FILE.test(f))) continue;
          const reached = reachedFiles(t);
          if ([...uFiles].some((f) => reached.has(f))) continue;
          emit(
            "unused",
            {
              id: `unused:${t}>${u}`,
              severity: "info",
              message: `${labelOf(t)} depends on ${labelOf(u)}, but no include or call from its files reaches ${labelOf(u)}`,
              nodes: [t, u],
              ...(view.node(t)?.span ? { span: view.node(t)?.span } : {}),
            },
            t,
            u,
            "no include or call from its files reaches it",
          );
        }

        for (const x of [...(externalDeps.get(t) ?? [])].sort()) {
          if (!mappableExternals.has(x) || includeTo.has(x)) continue;
          emit(
            "unused",
            {
              id: `unused:${t}>${x}`,
              severity: "info",
              message: `${labelOf(t)} depends on external ${x}, but no include from its files resolves to it`,
              nodes: [t, x],
              ...(view.node(t)?.span ? { span: view.node(t)?.span } : {}),
            },
            t,
            x,
            "no include from its files resolves to it",
          );
        }
      }
    }
  }

  // Visibility: a dependency on a target with visibility, from another package that no entry admits.
  if (config.visibility !== false) {
    const packageOf = (id: NodeId): string | undefined => {
      const parent = view.node(id)?.parent;
      if (parent === undefined) return undefined;
      const p = view.node(parent);
      if (p?.kind !== PACKAGE) return undefined;
      const name = p.attrs.name;
      return typeof name === "string" ? name : undefined;
    };
    for (const e of view.edges({ kind: "packaging.dep-edge" })) {
      if (!targetIds.has(e.from) || typeof e.to !== "string" || !targetIds.has(e.to)) continue;
      const vis = view.node(e.to)?.attrs.visibility;
      if (!Array.isArray(vis)) continue;
      const pT = packageOf(e.from);
      const pU = packageOf(e.to);
      if (pT === undefined || pU === undefined || pT === pU) continue;
      if (visibleTo(vis, pT) !== "denied") continue;
      const shown = vis.length > 0 ? vis.map(String).join(", ") : "nothing";
      emit(
        "visibility",
        {
          id: `visibility:${e.from}>${e.to}`,
          severity: "error",
          message: `${labelOf(e.from)} depends on ${labelOf(e.to)}, which is visible to ${shown} only`,
          nodes: [e.from, e.to],
          ...(view.node(e.from)?.span ? { span: view.node(e.from)?.span } : {}),
        },
        e.from,
        e.to,
        `package ${pT} is not admitted`,
      );
    }
  }

  return {
    findings,
    table: {
      type: "table",
      id: "build-graph",
      title: "Build-graph dependency rules",
      columns: ["Rule", "From", "To", "Detail"],
      rows,
    },
    metrics: {
      undeclaredDependencies: counts.undeclared,
      unusedDependencies: counts.unused,
      visibilityViolations: counts.visibility,
    },
  };
}
