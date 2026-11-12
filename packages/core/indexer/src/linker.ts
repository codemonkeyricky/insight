import type { IRDocument, IREdge, IRFinding, IRNode, IRRecord, NodeId, Provenance } from "@insight/ir";
import type { ProjectRoot, ResolveAnswer, Resolver, ResolveContext } from "@insight/sdk";
import { compareStrings } from "./util.js";

export interface LinkShard {
  frontend: string;
  file: string;
  records: IRRecord[];
}

export interface LinkResolver {
  /** The plugin id, recorded in provenance.resolvedBy. */
  id: string;
  resolver: Resolver;
}

export interface LinkInput {
  root: ProjectRoot;
  /** Every project file, relative and sorted. Each gets a core structure.file node. */
  files: string[];
  /** Shards in run order: plugins in load order, then files sorted. Earlier wins on duplicate ids. */
  shards: LinkShard[];
  /** Resolvers in priority order, highest first. */
  resolvers: LinkResolver[];
}

export interface LinkResult {
  doc: IRDocument;
  resolved: number;
  unresolved: number;
}

type Confidence = Provenance["confidence"];
const RANK: Record<Confidence, number> = { exact: 0, inferred: 1, heuristic: 2 };
const weaker = (a: Confidence, b: Confidence) => (RANK[a] >= RANK[b] ? a : b);

/**
 * Merges shards into one graph, then settles open references with resolvers. Resolution runs
 * on the whole graph every time, so an answer never depends on which files were re-extracted.
 */
export async function link(input: LinkInput): Promise<LinkResult> {
  const fileSet = new Set(input.files);
  const failedFiles = new Set<string>();
  for (const shard of input.shards) {
    if (shard.records.some((r) => "finding" in r && r.finding.severity === "error")) failedFiles.add(shard.file);
  }

  const nodes = new Map<NodeId, IRNode>();
  const findings: IRFinding[] = [];
  const edges: { edge: IREdge; file: string }[] = [];

  for (const file of input.files) {
    nodes.set(file, {
      id: file,
      facet: "structure",
      kind: "structure.file",
      attrs: { path: file, parseStatus: failedFiles.has(file) ? "error" : "ok" },
      span: { file, start: [0, 0], end: [0, 0] },
      provenance: { frontend: "core", confidence: "exact" },
    });
  }

  for (const shard of input.shards) {
    for (const record of shard.records) {
      if ("node" in record) {
        const node = record.node;
        if (nodes.has(node.id)) {
          findings.push({
            severity: "warning",
            message: `node "${node.id}" from ${shard.frontend} duplicates an earlier node and is ignored`,
            ...(node.span ? { span: node.span } : {}),
          });
          continue;
        }
        nodes.set(node.id, node);
      } else if ("edge" in record) {
        edges.push({ edge: record.edge, file: shard.file });
      } else {
        findings.push(record.finding);
      }
    }
  }

  let resolved = 0;
  let unresolved = 0;
  const byScheme = new Map<string, LinkResolver[]>();
  for (const r of [...input.resolvers].sort((a, b) => b.resolver.priority - a.resolver.priority)) {
    const list = byScheme.get(r.resolver.scheme) ?? [];
    list.push(r);
    byScheme.set(r.resolver.scheme, list);
  }

  const extra: { edge: IREdge; file: string }[] = [];
  for (const { edge, file } of edges) {
    const to = edge.to;
    if (typeof to === "string" || "candidates" in to) continue;
    const ref = to.unresolved;
    const ctx: ResolveContext = {
      root: input.root,
      fromFile: file,
      hasFile: (p) => fileSet.has(p),
      hasNode: (n) => nodes.has(n),
      listFiles: () => input.files,
    };
    const answers: { id: string; answer: ResolveAnswer }[] = [];
    for (const { id, resolver } of byScheme.get(ref.scheme) ?? []) {
      let answer: ResolveAnswer | null;
      try {
        answer = await resolver.resolve(ref, ctx);
      } catch (err) {
        findings.push({ severity: "warning", message: `resolver ${id} failed on "${ref.text}": ${(err as Error).message}` });
        continue;
      }
      if (!answer || answer.targets.length === 0) continue;
      if (!answer.targets.every((t) => nodes.has(t))) continue;
      answers.push({ id, answer });
    }

    // A heuristic answer only counts when no strong answer exists. Strong answers that agree are
    // adopted together. Strong answers that disagree keep every target, each on its own edge.
    const strong = answers.filter((a) => a.answer.confidence !== "heuristic");
    const pool = strong.length > 0 ? strong : answers;
    if (pool.length === 0) {
      unresolved++;
      continue;
    }
    const groups = new Map<string, { targets: NodeId[]; by: string[]; confidence: Confidence }>();
    for (const { id, answer } of pool) {
      const key = [...answer.targets].sort(compareStrings).join("\0");
      const group = groups.get(key) ?? { targets: answer.targets, by: [], confidence: answer.confidence };
      group.by.push(id);
      group.confidence = weaker(group.confidence, answer.confidence);
      groups.set(key, group);
    }

    const settleEdge = (target: { targets: NodeId[]; by: string[]; confidence: Confidence }, into: IREdge) => {
      const [first, ...rest] = target.targets as [NodeId, ...NodeId[]];
      into.to = rest.length === 0 ? first : { candidates: [first, ...rest] };
      into.provenance = {
        ...into.provenance,
        resolvedBy: target.by.join("+"),
        confidence: weaker(into.provenance.confidence, target.confidence),
      };
    };

    const [firstGroup, ...otherGroups] = [...groups.values()];
    if (firstGroup === undefined) {
      unresolved++;
      continue;
    }
    settleEdge(firstGroup, edge);
    if (otherGroups.length > 0) {
      const described = [firstGroup, ...otherGroups].map((g) => `${g.targets.join(", ")} (by ${g.by.join("+")})`);
      findings.push({
        severity: "warning",
        message: `"${ref.text}" resolves to ${described.length} different targets: ${described.join("; ")}. Every target is kept.`,
        ...(edge.span ? { span: edge.span } : {}),
      });
      for (const group of otherGroups) {
        const copy: IREdge = { ...edge, provenance: { ...edge.provenance } };
        settleEdge(group, copy);
        extra.push({ edge: copy, file });
      }
    }
    resolved++;
  }
  edges.push(...extra);

  const doc: IRDocument = {
    nodes: [...nodes.values()].sort((a, b) => compareStrings(a.id, b.id)),
    edges: edges.map((e) => e.edge),
    findings,
  };
  return { doc, resolved, unresolved };
}
