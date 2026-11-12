import type { IREdge, IRNode, IRRecord, NodeId } from "@insight/ir";
import type { AnalysisFile } from "./analyze.js";
import { canonicalJson } from "./util.js";

/** One snapshot as the diff sees it: its IR records and its lens results, when the lenses ran. */
export interface SnapshotInput {
  records: IRRecord[];
  analysis?: AnalysisFile;
}

export interface DiffNode {
  id: NodeId;
  kind: string;
  facet: string;
  name?: string;
  parent?: NodeId;
  file?: string;
  line?: number;
}

export interface DiffEdge {
  from: NodeId;
  to: unknown;
  kind: string;
  facet: string;
  /** How many copies were added or removed. Edges can repeat, so the diff counts them. */
  count: number;
}

/** A lens finding with its stable key, `<lens>#<id>`. The review checklist uses the same key. */
export interface DiffFinding {
  key: string;
  lens: string;
  id: string;
  severity: string;
  message: string;
  file?: string;
  line?: number;
}

export interface LensDiff {
  id: string;
  /** False when the lens did not run ok on both sides, so its added and removed lists are not meaningful. */
  comparable: boolean;
  base: string;
  head: string;
  added: DiffFinding[];
  removed: DiffFinding[];
  unchanged: number;
}

export interface SnapshotDiff {
  ir: {
    nodes: { added: DiffNode[]; removed: DiffNode[]; changed: DiffNode[] };
    edges: { added: DiffEdge[]; removed: DiffEdge[] };
    findings: { added: string[]; removed: string[] };
  };
  lenses: LensDiff[];
  /** Plain sentences for the reviewer, most important first. */
  summary: string[];
}

/** Facets whose additions a reviewer needs to see by name, not as a count. */
const NAMED_FACETS = new Set(["effects", "sync", "concurrency"]);

function nodeOf(node: IRNode): DiffNode {
  const name = typeof node.attrs.name === "string" ? node.attrs.name : undefined;
  return {
    id: node.id,
    kind: node.kind,
    facet: node.facet,
    ...(name !== undefined ? { name } : {}),
    ...(node.parent !== undefined ? { parent: node.parent } : {}),
    ...(node.span ? { file: node.span.file, line: node.span.start[0] + 1 } : {}),
  };
}

function indexNodes(records: IRRecord[]): Map<NodeId, IRNode> {
  const nodes = new Map<NodeId, IRNode>();
  for (const r of records) if ("node" in r) nodes.set(r.node.id, r.node);
  return nodes;
}

function edgeKey(e: IREdge): string {
  return canonicalJson({ from: e.from, to: e.to, kind: e.kind, facet: e.facet });
}

/** Counts per key, keeping one representative edge per key. */
function countEdges(edges: IREdge[]): Map<string, { edge: IREdge; count: number }> {
  const out = new Map<string, { edge: IREdge; count: number }>();
  for (const e of edges) {
    const key = edgeKey(e);
    const hit = out.get(key);
    if (hit) hit.count += 1;
    else out.set(key, { edge: e, count: 1 });
  }
  return out;
}

/** The function (or else the file) a node sits in, for a sentence like "adds a lock acquire in f". */
function whereOf(node: IRNode, nodes: Map<NodeId, IRNode>): string {
  let current: IRNode | undefined = node;
  while (current) {
    if (current.kind === "structure.function" && typeof current.attrs.name === "string") return current.attrs.name;
    if (current.kind === "structure.file") return current.id;
    current = current.parent !== undefined ? nodes.get(current.parent) : undefined;
  }
  return node.span?.file ?? node.id;
}

function targetText(to: unknown): string {
  if (typeof to === "string") return to;
  if (to && typeof to === "object" && "unresolved" in to) {
    const u = (to as { unresolved: { text: string } }).unresolved;
    return `unresolved ${u.text}`;
  }
  return JSON.stringify(to);
}

/** Findings keyed by `<lens>#<id>`. A repeated id gets `~2`, `~3`, ... so no finding is lost. */
export function keyFindings(findings: { lens: string; id: string }[]): Map<string, number> {
  const seen = new Map<string, number>();
  const keys = new Map<string, number>();
  findings.forEach((f, i) => {
    const base = `${f.lens}#${f.id}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    keys.set(n === 1 ? base : `${base}~${n}`, i);
  });
  return keys;
}

/**
 * The keyed lens findings of one snapshot, in the same keys the diff and the review checklist use. Index
 * findings (parse errors and the like) are not included: they have no stable id, only a position.
 */
export function keyedFindings(analysis: AnalysisFile | undefined): DiffFinding[] {
  const out: DiffFinding[] = [];
  for (const lens of analysis?.lenses ?? []) {
    if (lens.status !== "ok") continue;
    const list = (lens.result?.findings ?? []).map((f) => ({ ...f, lens: lens.id }));
    for (const [key, i] of keyFindings(list)) out.push(toDiffFinding(key, list[i]!));
  }
  return out;
}

function lensFindings(analysis: AnalysisFile | undefined, lensId: string) {
  const lens = analysis?.lenses.find((l) => l.id === lensId);
  if (!lens || lens.status !== "ok") return undefined;
  return lens.result?.findings ?? [];
}

function toDiffFinding(key: string, f: { lens: string; id: string; severity: string; message: string; span?: { file: string; start: [number, number] } }): DiffFinding {
  return {
    key,
    lens: f.lens,
    id: f.id,
    severity: f.severity,
    message: f.message,
    ...(f.span ? { file: f.span.file, line: f.span.start[0] + 1 } : {}),
  };
}

/**
 * Semantic diff between two snapshots. Node and edge identity is the stable node id and the edge's
 * endpoints, kind and facet, so a line moving inside a function is not a change. Lens findings are compared
 * by their stable key.
 */
export function diffSnapshots(base: SnapshotInput, head: SnapshotInput): SnapshotDiff {
  const baseNodes = indexNodes(base.records);
  const headNodes = indexNodes(head.records);

  const nodesAdded: DiffNode[] = [];
  const nodesRemoved: DiffNode[] = [];
  const nodesChanged: DiffNode[] = [];
  for (const [id, node] of headNodes) {
    const before = baseNodes.get(id);
    if (!before) nodesAdded.push(nodeOf(node));
    else if (canonicalJson({ kind: before.kind, parent: before.parent, attrs: before.attrs }) !== canonicalJson({ kind: node.kind, parent: node.parent, attrs: node.attrs })) {
      nodesChanged.push(nodeOf(node));
    }
  }
  for (const [id, node] of baseNodes) if (!headNodes.has(id)) nodesRemoved.push(nodeOf(node));

  const baseEdges = countEdges(base.records.flatMap((r) => ("edge" in r ? [r.edge] : [])));
  const headEdges = countEdges(head.records.flatMap((r) => ("edge" in r ? [r.edge] : [])));
  const edgesAdded: DiffEdge[] = [];
  const edgesRemoved: DiffEdge[] = [];
  const toEdge = (e: IREdge, count: number): DiffEdge => ({ from: e.from, to: e.to, kind: e.kind, facet: e.facet, count });
  for (const [key, h] of headEdges) {
    const b = baseEdges.get(key)?.count ?? 0;
    if (h.count > b) edgesAdded.push(toEdge(h.edge, h.count - b));
  }
  for (const [key, b] of baseEdges) {
    const h = headEdges.get(key)?.count ?? 0;
    if (b.count > h) edgesRemoved.push(toEdge(b.edge, b.count - h));
  }

  const findingText = (records: IRRecord[]) =>
    records.flatMap((r) => ("finding" in r ? [`${r.finding.severity}: ${r.finding.message}`] : []));
  const baseIrFindings = findingText(base.records);
  const headIrFindings = findingText(head.records);
  const removeOne = (list: string[], item: string) => {
    const i = list.indexOf(item);
    if (i >= 0) list.splice(i, 1);
  };
  const irFindingsAdded = [...headIrFindings];
  for (const f of baseIrFindings) removeOne(irFindingsAdded, f);
  const irFindingsRemoved = [...baseIrFindings];
  for (const f of headIrFindings) removeOne(irFindingsRemoved, f);

  // Lens findings: the union of lens ids that ran on either side.
  const lensIds = new Set<string>([...(base.analysis?.lenses ?? []), ...(head.analysis?.lenses ?? [])].map((l) => l.id));
  const lenses: LensDiff[] = [];
  for (const id of [...lensIds].sort()) {
    const b = lensFindings(base.analysis, id);
    const h = lensFindings(head.analysis, id);
    const comparable = b !== undefined && h !== undefined;
    const baseFindings = (b ?? []).map((f) => ({ ...f, lens: id }));
    const headFindings = (h ?? []).map((f) => ({ ...f, lens: id }));
    const bKeys = keyFindings(baseFindings);
    const hKeys = keyFindings(headFindings);
    const added: DiffFinding[] = [];
    const removed: DiffFinding[] = [];
    let unchanged = 0;
    if (comparable) {
      for (const [key, i] of hKeys) if (!bKeys.has(key)) added.push(toDiffFinding(key, headFindings[i]!));
      for (const [key, i] of bKeys) if (!hKeys.has(key)) removed.push(toDiffFinding(key, baseFindings[i]!));
      unchanged = [...hKeys.keys()].filter((k) => bKeys.has(k)).length;
    }
    lenses.push({
      id,
      comparable,
      base: base.analysis?.lenses.find((l) => l.id === id)?.status ?? "not run",
      head: head.analysis?.lenses.find((l) => l.id === id)?.status ?? "not run",
      added,
      removed,
      unchanged,
    });
  }

  const summary: string[] = [];
  for (const lens of lenses) {
    if (!lens.comparable) {
      summary.push(`${lens.id} did not run ok on both sides (base ${lens.base}, head ${lens.head}), so its findings are not compared.`);
      continue;
    }
    for (const f of lens.added) summary.push(`New ${f.lens} finding (${f.severity}): ${f.message}`);
    for (const f of lens.removed) summary.push(`Resolved ${f.lens} finding: ${f.message}`);
  }
  const describeNode = (n: DiffNode, nodes: Map<NodeId, IRNode>, verb: string) => {
    const node = nodes.get(n.id);
    const where = node ? whereOf(node, nodes) : (n.file ?? n.id);
    return `${verb} ${n.kind}${n.name ? ` ${n.name}` : ""} in ${where}`;
  };
  for (const n of nodesAdded) if (NAMED_FACETS.has(n.facet)) summary.push(describeNode(n, headNodes, "Adds"));
  for (const n of nodesRemoved) if (NAMED_FACETS.has(n.facet)) summary.push(describeNode(n, baseNodes, "Removes"));
  for (const e of edgesAdded) if (e.kind === "packaging.dep-edge") summary.push(`Adds build dependency ${e.from} -> ${targetText(e.to)}`);
  for (const e of edgesRemoved) if (e.kind === "packaging.dep-edge") summary.push(`Removes build dependency ${e.from} -> ${targetText(e.to)}`);
  const count = (list: unknown[], what: string) => (list.length > 0 ? [`${list.length} ${what}`] : []);
  const counts = [
    ...count(nodesAdded.filter((n) => !NAMED_FACETS.has(n.facet)), "nodes added"),
    ...count(nodesRemoved.filter((n) => !NAMED_FACETS.has(n.facet)), "nodes removed"),
    ...count(nodesChanged, "nodes changed"),
    ...count(edgesAdded, "edges added"),
    ...count(edgesRemoved, "edges removed"),
  ];
  if (counts.length > 0) summary.push(`IR: ${counts.join(", ")}.`);

  return {
    ir: {
      nodes: { added: nodesAdded, removed: nodesRemoved, changed: nodesChanged },
      edges: { added: edgesAdded, removed: edgesRemoved },
      findings: { added: irFindingsAdded, removed: irFindingsRemoved },
    },
    lenses,
    summary,
  };
}
