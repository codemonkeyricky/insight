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

const RANK: Record<Provenance["confidence"], number> = { exact: 0, inferred: 1, heuristic: 2 };
const weaker = (a: Provenance["confidence"], b: Provenance["confidence"]) => (RANK[a] >= RANK[b] ? a : b);

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

  for (const { edge, file } of edges) {
    const to = edge.to;
    if (typeof to === "string" || "candidates" in to) continue;
    const ref = to.unresolved;
    let settled = false;
    for (const { id, resolver } of byScheme.get(ref.scheme) ?? []) {
      const ctx: ResolveContext = {
        root: input.root,
        fromFile: file,
        hasFile: (p) => fileSet.has(p),
        hasNode: (n) => nodes.has(n),
        listFiles: () => input.files,
      };
      let answer: ResolveAnswer | null;
      try {
        answer = await resolver.resolve(ref, ctx);
      } catch (err) {
        findings.push({ severity: "warning", message: `resolver ${id} failed on "${ref.text}": ${(err as Error).message}` });
        continue;
      }
      if (!answer || answer.targets.length === 0) continue;
      if (!answer.targets.every((t) => nodes.has(t))) continue;
      const [first, ...rest] = answer.targets as [NodeId, ...NodeId[]];
      edge.to = rest.length === 0 ? first : { candidates: [first, ...rest] };
      edge.provenance = {
        ...edge.provenance,
        resolvedBy: id,
        confidence: weaker(edge.provenance.confidence, answer.confidence),
      };
      settled = true;
      break;
    }
    if (settled) resolved++;
    else unresolved++;
  }

  const doc: IRDocument = {
    nodes: [...nodes.values()].sort((a, b) => compareStrings(a.id, b.id)),
    edges: edges.map((e) => e.edge),
    findings,
  };
  return { doc, resolved, unresolved };
}
