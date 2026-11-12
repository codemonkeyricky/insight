// The Pipeline view's model: the processing stages of one scope, derived from interface-dispatch call sites. A host
// component calls an interface whose implementers sit in several components. Those implementers either feed the host
// (the first extension point, a source) or receive from it (every later point, a sink). The host's exact calls to other
// components make up the middle column. Pure: the same model and scope always give the same output.
import type { NodeId, Span, IREdge } from "@insight/ir";
import { isNoisePath } from "@insight/flow";
import type { ProjectModel, Rel } from "./model.js";
import { normalizeScope, ROOT_SCOPE } from "./scope.js";
import { componentOf, packageRoots, systemModel, type Site, type SystemComponent, type SystemOptions } from "./system.js";
import { scopeView } from "./view.js";

export type PipelineOptions = SystemOptions;

export interface PipelinePoint {
  id: string;
  host: string;
  label: string; // the receiver, capitalised and pluralised: "Frontends", "Lenses"
  members: string[]; // sorted unique member names of the call sites
  receiver: string; // the callee text before its last "."
  components: string[]; // implementer components, sorted
  sites: Site[]; // up to 20 sites
  count: number; // every site of the point
  order: number; // position in the pipeline, 0 = first
  role: "source" | "sink";
}

export interface PipelineEdge {
  id: string;
  from: string;
  to: string;
  verb: "produces" | "feeds" | "calls";
  label: string;
  count: number;
  sites: Site[];
  confidence: "exact" | "inferred";
}

export interface PipelineModel {
  scope: string; // "" = project root
  host?: string;
  driver?: { id: string; name: string };
  points: PipelinePoint[];
  columns: string[][]; // component ids per column, left → right
  components: SystemComponent[]; // only those drawn in a column
  edges: PipelineEdge[];
  omitted: number; // in-scope components that are not drawn
  dropped: number; // extension points of other hosts, not drawn
  reason?: string;
}

/** Edge `how` values that mark an interface-dispatch call site. */
const INTERFACE_HOW = new Set(["interface", "abstract"]);
/** Sites kept per point and per edge. The count still covers every site. */
const SITE_CAP = 20;
const NO_POINTS = "no extension points in this scope";

interface RawSite {
  site: Site;
  callee: string;
  receiver: string;
  members: string[];
  fn?: NodeId;
  line: number;
}

interface RawPoint {
  host: string;
  targets: string[];
  sites: RawSite[];
}

/**
 * The Pipeline model of one scope. Components are the System view's components for the scope (same ownership, same noise
 * rule). Points are extension points: interface call sites whose targets span two or more components.
 */
export function pipelineModel(model: ProjectModel, scopePath: string, opts: PipelineOptions = {}): PipelineModel {
  const scope = normalizeScope(scopePath);
  const empty = (): PipelineModel => ({ scope, points: [], columns: [], components: [], edges: [], omitted: 0, dropped: 0, reason: NO_POINTS });

  // The System view's own scope: a single code folder is descended into, exactly as systemModel does.
  const sys = systemModel(model, scope, opts);
  if (sys.components.length === 0) return empty();
  const inner = sys.via === undefined ? scope : scope === ROOT_SCOPE ? sys.via : `${scope}/${sys.via}`;
  const tests = opts.tests === true || isNoisePath(scope) || isNoisePath(`${scope}/x`);
  const view = scopeView(model, inner);
  const packages = packageRoots(model.files);
  const sysById = new Map(sys.components.map((c) => [c.id, c] as const));

  // Ownership of each in-scope, non-noise file: its System component (files of dropped components have none).
  const compOfFile = new Map<string, string>();
  for (const file of view.files()) {
    if (!tests && isNoisePath(file)) continue;
    const id = componentOf(file, inner, packages, view.kind === "file").id;
    if (sysById.has(id)) compOfFile.set(file, id);
  }
  const compOf = (file: string | undefined): string | undefined => (file === undefined ? undefined : compOfFile.get(file));

  // Interface relations grouped by their shared edge: one group is one call site with its candidates.
  const groups = new Map<IREdge, Rel[]>();
  for (const rel of model.relations) {
    if (rel.how === undefined || !INTERFACE_HOW.has(rel.how)) continue;
    const list = groups.get(rel.edge);
    if (list) list.push(rel);
    else groups.set(rel.edge, [rel]);
  }

  const rawPoints = new Map<string, RawPoint>();
  for (const rels of groups.values()) {
    const first = rels[0] as Rel;
    const hostFile = model.fileOf(first.from);
    const host = compOf(hostFile);
    if (hostFile === undefined || host === undefined) continue;
    const targets = new Set<string>();
    for (const rel of rels) {
      const c = compOf(model.fileOf(rel.to));
      if (c !== undefined && c !== host) targets.add(c);
    }
    if (targets.size < 2) continue;
    const targetList = [...targets].sort();

    const span: Span | undefined = first.edge.span;
    const callee = typeof first.edge.attrs?.callee === "string" ? first.edge.attrs.callee : "";
    const dot = callee.lastIndexOf(".");
    const receiver = dot >= 0 ? callee.slice(0, dot) : "";
    const calleeMember = dot >= 0 ? callee.slice(dot + 1) : callee;
    const members = calleeMember !== "" ? [calleeMember] : [...new Set(rels.map((r) => targetMember(r.to)))].sort();
    const fn = enclosingFn(model, first.from);
    const raw: RawSite = {
      site: { file: span?.file ?? hostFile, line: span ? span.start[0] + 1 : 0, ...(fn !== undefined ? { fn } : {}) },
      callee,
      receiver,
      members,
      ...(fn !== undefined ? { fn } : {}),
      line: span ? span.start[0] + 1 : 0,
    };

    const key = `${host}\0${targetList.join("\0")}`;
    const point = rawPoints.get(key) ?? { host, targets: targetList, sites: [] };
    point.sites.push(raw);
    rawPoints.set(key, point);
  }
  if (rawPoints.size === 0) return empty();

  // Host choice: the host with the most extension points (then the most sites, then the id). Other hosts are dropped.
  const byHost = new Map<string, RawPoint[]>();
  for (const p of rawPoints.values()) byHost.set(p.host, [...(byHost.get(p.host) ?? []), p]);
  const hostOrder = [...byHost.entries()]
    .map(([host, list]) => ({ host, points: list.length, sites: list.reduce((n, p) => n + p.sites.length, 0) }))
    .sort((a, b) => b.points - a.points || b.sites - a.sites || cmp(a.host, b.host));
  const host = (hostOrder[0] as { host: string }).host;
  const chosen = (byHost.get(host) ?? []).map((p) => ({ ...p, sites: sortRaw(p.sites) }));
  const dropped = rawPoints.size - chosen.length;

  // Driver: the host function that reaches the most extension points through calls inside the host (a point is reached when
  // one of its sites is). Ties go to the smallest distance to the sites it reaches (the deepest such function), then the id.
  const callsInHost = (id: NodeId) => (model.out.get(id) ?? []).filter((r) => r.kind === "call" && compOf(model.fileOf(r.to)) === host);
  const reach = (start: NodeId) => {
    const dist = new Map<NodeId, number>([[start, 0]]);
    const firstLine = new Map<NodeId, number>();
    const queue: NodeId[] = [start];
    for (let i = 0; i < queue.length; i++) {
      const cur = queue[i] as NodeId;
      for (const r of callsInHost(cur)) {
        if (dist.has(r.to)) continue;
        dist.set(r.to, (dist.get(cur) as number) + 1);
        firstLine.set(r.to, cur === start ? (r.edge.span ? r.edge.span.start[0] + 1 : 0) : (firstLine.get(cur) as number));
        queue.push(r.to);
      }
    }
    return { dist, firstLine };
  };
  const hostFns = model.functions.filter((f) => compOf(f.file) === host).map((f) => f.id).sort(cmp);
  let driver: { id: NodeId; reach: ReturnType<typeof reach>; span: number; points: number } | undefined;
  for (const id of hostFns) {
    const r = reach(id);
    let span = 0;
    let points = 0;
    for (const p of chosen) {
      let hit = false;
      for (const s of p.sites) {
        const d = s.fn === undefined ? undefined : r.dist.get(s.fn);
        if (d === undefined) continue;
        hit = true;
        span = Math.max(span, d);
      }
      if (hit) points++;
    }
    if (points === 0) continue;
    if (driver === undefined || points > driver.points || (points === driver.points && span < driver.span)) driver = { id, reach: r, span, points };
  }

  // Order: with a driver, a point's key is the driver's first call on the way to one of its sites (its own line when the driver
  // holds the site). A point the driver does not reach goes last. Ties, and every point without a driver, go by the first site.
  const firstSiteOrder = (a: RawPoint, b: RawPoint): number => {
    const sa = a.sites[0] as RawSite;
    const sb = b.sites[0] as RawSite;
    return cmp(sa.site.file, sb.site.file) || sa.line - sb.line || cmp(a.targets.join(","), b.targets.join(","));
  };
  const keyed = chosen.map((p) => {
    let key = Number.POSITIVE_INFINITY;
    if (driver !== undefined) {
      for (const s of p.sites) {
        const line = s.fn === driver.id ? s.line : driver.reach.firstLine.get(s.fn as NodeId);
        if (line !== undefined && line < key) key = line;
      }
    }
    return { p, key };
  });
  keyed.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0) || firstSiteOrder(a.p, b.p));

  const points: PipelinePoint[] = keyed.map(({ p }, order) => {
    const members = [...new Set(p.sites.flatMap((s) => s.members))].sort(cmp);
    const receiver = mostCommon(p.sites.map((s) => s.receiver));
    const sites = dedupeSites(p.sites.map((s) => s.site));
    return {
      id: `${p.host}>${p.targets.join("+")}`,
      host: p.host,
      label: pluralLabel(receiver),
      members,
      receiver,
      components: p.targets,
      sites: sites.slice(0, SITE_CAP),
      count: p.sites.length,
      order,
      role: order === 0 ? "source" : "sink",
    };
  });

  // Columns: the source's implementers, then the host with the components it calls exactly, then each sink's implementers.
  // A component goes in the first column it qualifies for.
  const pointComps = new Set(points.flatMap((p) => p.components));
  const owner = new Map<string, PipelinePoint>();
  const columns: string[][] = [];
  const takeColumn = (point: PipelinePoint): void => {
    const col = point.components.filter((c) => !owner.has(c)).sort((a, b) => cmp(sysById.get(a)?.label ?? a, sysById.get(b)?.label ?? b) || cmp(a, b));
    for (const c of col) owner.set(c, point);
    if (col.length > 0) columns.push(col); // a point whose implementers all sit in earlier columns draws nothing
  };

  const sourcePoints = points.filter((p) => p.role === "source");
  for (const p of sourcePoints) takeColumn(p);

  // The host's exact calls to other in-scope components, excluding every implementer.
  const calls = new Map<string, Rel[]>();
  for (const rel of model.relations) {
    if (rel.kind !== "call" || rel.candidate) continue;
    if (compOf(model.fileOf(rel.from)) !== host) continue;
    const to = compOf(model.fileOf(rel.to));
    if (to === undefined || to === host || pointComps.has(to)) continue;
    calls.set(to, [...(calls.get(to) ?? []), rel]);
  }
  const middle = [host, ...[...calls.keys()].sort(cmp)];
  columns.push(middle);

  for (const p of points.filter((q) => q.role === "sink")) takeColumn(p);

  const drawn = new Set(columns.flat());
  const components = sys.components.filter((c) => drawn.has(c.id));

  // Edges: a source's implementers produce into the host, a sink receives from it, and the host calls its middle components.
  const edges: PipelineEdge[] = [];
  for (const p of points) {
    for (const c of p.components) {
      if (owner.get(c) !== p) continue;
      edges.push(
        p.role === "source"
          ? edgeOf(c, host, "produces", p.members.join(", "), p.count, p.sites, "inferred")
          : edgeOf(host, c, "feeds", p.members.join(", "), p.count, p.sites, "inferred"),
      );
    }
  }
  for (const c of [...calls.keys()].sort(cmp)) {
    const rels = calls.get(c) as Rel[];
    const sites = dedupeSites(rels.map((r) => siteOfRel(model, r)));
    const n = rels.length;
    edges.push(edgeOf(host, c, "calls", n > 1 ? `calls ×${n}` : "calls", n, sites.slice(0, SITE_CAP), "exact"));
  }
  edges.sort((x, y) => cmp(x.from, y.from) || cmp(x.to, y.to) || cmp(x.verb, y.verb) || cmp(x.id, y.id));

  return {
    scope,
    host,
    ...(driver !== undefined ? { driver: { id: driver.id, name: model.functionById.get(driver.id)?.name ?? driver.id } } : {}),
    points,
    columns,
    components,
    edges,
    omitted: sys.components.length - drawn.size,
    dropped,
  };
}

function edgeOf(from: string, to: string, verb: PipelineEdge["verb"], label: string, count: number, sites: Site[], confidence: PipelineEdge["confidence"]): PipelineEdge {
  return { id: `${from}>${verb}>${to}`, from, to, verb, label, count, sites, confidence };
}

/** The function an owner node belongs to: its nearest named parent (anonymous functions count as their owner). */
function enclosingFn(model: ProjectModel, id: NodeId): NodeId | undefined {
  let cur = id;
  for (let depth = 0; depth < 1000; depth++) {
    const node = model.byId.get(cur);
    if (!node || node.kind !== "structure.function" || node.attrs.anonymous !== true || node.parent === undefined) break;
    cur = node.parent;
  }
  return model.functionById.has(cur) ? cur : undefined;
}

function siteOfRel(model: ProjectModel, rel: Rel): Site {
  const file = model.fileOf(rel.from) as string;
  const fn = enclosingFn(model, rel.from);
  return { file: rel.edge.span?.file ?? file, line: rel.edge.span ? rel.edge.span.start[0] + 1 : 0, ...(fn !== undefined ? { fn } : {}) };
}

/** The member name a target contributes: the function name after '#', or the id's tail. */
function targetMember(id: NodeId): string {
  const hash = id.indexOf("#");
  const tail = hash >= 0 ? id.slice(hash + 1) : id;
  return tail.slice(tail.lastIndexOf(".") + 1);
}

/** "frontend" → "Frontends", "lens" → "Lenses" (a word ending in "s" takes "es"). */
function pluralLabel(receiver: string): string {
  if (receiver === "") return "Implementers";
  const word = receiver.charAt(0).toUpperCase() + receiver.slice(1);
  return word.endsWith("s") ? `${word}es` : `${word}s`;
}

/** The most frequent value; ties go to the smaller text. */
function mostCommon(values: string[]): string {
  const count = new Map<string, number>();
  for (const v of values) count.set(v, (count.get(v) ?? 0) + 1);
  let best = "";
  let bestN = -1;
  for (const [v, n] of count) if (n > bestN || (n === bestN && cmp(v, best) < 0)) [best, bestN] = [v, n];
  return best;
}

function sortRaw(sites: RawSite[]): RawSite[] {
  return [...sites].sort((x, y) => cmp(x.site.file, y.site.file) || x.line - y.line || cmp(x.site.fn ?? "", y.site.fn ?? ""));
}

/** Sites sorted by file and line, without duplicates. */
function dedupeSites(sites: Site[]): Site[] {
  const seen = new Set<string>();
  const out: Site[] = [];
  for (const s of [...sites].sort((x, y) => cmp(x.file, y.file) || x.line - y.line || cmp(x.fn ?? "", y.fn ?? ""))) {
    const key = `${s.file}\0${s.line}\0${s.fn ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
