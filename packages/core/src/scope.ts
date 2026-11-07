import type { IRDocument, IREdge, IRFinding, IRNode, NodeId } from "@insight/ir";
import { edgeTargets, isExternal } from "@insight/sdk";
import { compareStrings, InputError } from "./util.js";

/**
 * A scope is a project-relative path: a file ("src/a.ts"), a folder ("src") or "" for the whole
 * project. Folders are not nodes in the IR; a folder scope holds every node whose file lies under it.
 */
export const ROOT_SCOPE = "";

export interface ScopeStats {
  /** Nodes that belong to the scope. External stubs are not counted here. */
  nodes: number;
  edges: number;
  findings: number;
  /** External stubs: nodes outside the scope that an in-scope edge points at or comes from. */
  external: number;
}

export interface ScopedDocument {
  /** The scoped IR. Its nodes include the external stubs, so `doc.nodes.length` is `stats.nodes + stats.external`. */
  doc: IRDocument;
  stats: ScopeStats;
}

export interface ScopeOptions {
  /**
   * Keep edges that leave the scope, with a stub for the far end (the default). When false, such
   * edges are dropped and candidate sets keep only their in-scope members.
   */
  externalStubs?: boolean;
}

/**
 * Checks a scope string from a caller and returns its canonical form: forward slashes, no "." or
 * empty segments, no trailing slash. A scope must stay inside the project.
 */
export function normalizeScope(scope: string): string {
  const raw = scope.replace(/\\/g, "/");
  if (raw.startsWith("/")) throw new InputError(`scope must be relative to the project: ${scope}`);
  const parts = raw.split("/").filter((p) => p !== "" && p !== ".");
  if (parts.includes("..")) throw new InputError(`scope must not leave the project: ${scope}`);
  return parts.join("/");
}

/**
 * The project file a node belongs to, from its own fields alone. A node with a span belongs to the
 * span's file; a structure.file node belongs to its own path. Other nodes return undefined here,
 * and scopeDoc then looks at their parent.
 */
export function scopeOfNode(node: IRNode): string | undefined {
  if (node.span) return node.span.file;
  if (node.kind === "structure.file") {
    const path = node.attrs.path;
    return typeof path === "string" ? path : node.id;
  }
  return undefined;
}

/**
 * True when a project-relative path is the scope or lies under it. Matching is by whole path
 * segments, so the folder "src" holds "src/a.ts" but not "src2/a.ts". The scope must already be
 * normalized (see normalizeScope).
 */
export function inScope(path: string, scope: string): boolean {
  if (scope === ROOT_SCOPE) return true;
  return path === scope || path.startsWith(`${scope}/`);
}

/** True for a stub that scopeDoc added for a node outside the scope. The same test the lenses use (from @insight/sdk). */
export { isExternal };

/**
 * The facets a scope has facts in. Stubs do not count: a facet is present only when the scope
 * holds a node of it or an edge that touches the scope.
 */
export function scopeFacets(doc: IRDocument): string[] {
  const facets = new Set<string>();
  for (const node of doc.nodes) if (!isExternal(node)) facets.add(node.facet);
  for (const edge of doc.edges) facets.add(edge.facet);
  return [...facets].sort(compareStrings);
}

/**
 * Cuts an IR document down to one scope.
 *
 * - The root scope "" returns the whole document, unchanged.
 * - A node is kept when its file is in the scope (see scopeOfNode, and the parent chain for nodes
 *   without a span). A parent link to a node that was dropped is removed.
 * - An edge is kept when either end is in the scope. The far end, when it is a node of the
 *   document, becomes an external stub: same id, facet, kind and attrs with `external: true`, and
 *   no span or parent. Candidate sets keep every member and stub the ones outside.
 * - A finding is kept when its span's file is in the scope. A finding without a span is kept when
 *   one of its nodes is in the scope.
 *
 * Ids are never rewritten, so an id means the same node in every scope.
 */
export function scopeDoc(doc: IRDocument, scope: string, opts: ScopeOptions = {}): ScopedDocument {
  const s = normalizeScope(scope);
  if (s === ROOT_SCOPE) {
    return {
      doc: { nodes: [...doc.nodes], edges: [...doc.edges], findings: [...doc.findings] },
      stats: { nodes: doc.nodes.length, edges: doc.edges.length, findings: doc.findings.length, external: 0 },
    };
  }
  const stubs = opts.externalStubs !== false;
  const byId = new Map<NodeId, IRNode>(doc.nodes.map((n) => [n.id, n]));
  const fileOf = fileResolver(byId);
  const local = new Set<NodeId>();
  for (const node of doc.nodes) {
    const file = fileOf(node.id);
    if (file !== undefined && inScope(file, s)) local.add(node.id);
  }

  const nodes: IRNode[] = [];
  for (const node of doc.nodes) {
    if (!local.has(node.id)) continue;
    if (node.parent !== undefined && !local.has(node.parent)) {
      const detached: IRNode = { ...node };
      delete detached.parent;
      nodes.push(detached);
    } else {
      nodes.push(node);
    }
  }

  const external = new Set<NodeId>();
  const edges: IREdge[] = [];
  for (const edge of doc.edges) {
    const targets = edgeTargets(edge);
    const fromLocal = local.has(edge.from);
    const touches = [...targets.nodes, ...targets.candidates].some((id) => local.has(id));
    if (!fromLocal && !touches) continue;
    if (!stubs) {
      if (!fromLocal || targets.nodes.some((id) => !local.has(id))) continue;
      if (targets.candidates.length > 0) {
        const kept = targets.candidates.filter((id) => local.has(id));
        if (kept.length === 0) continue;
        edges.push({ ...edge, to: { candidates: kept as [NodeId, ...NodeId[]] } });
        continue;
      }
      edges.push(edge);
      continue;
    }
    for (const id of [edge.from, ...targets.nodes, ...targets.candidates]) {
      if (!local.has(id) && byId.has(id)) external.add(id);
    }
    edges.push(edge);
  }

  const stubNodes: IRNode[] = [];
  for (const id of [...external].sort(compareStrings)) {
    const original = byId.get(id);
    if (original) stubNodes.push(stubFor(original));
  }

  const findings = doc.findings.filter((f) => findingInScope(f, s, local));
  return {
    doc: { nodes: [...nodes, ...stubNodes], edges, findings },
    stats: { nodes: nodes.length, edges: edges.length, findings: findings.length, external: stubNodes.length },
  };
}

/** The file of a node, looking up the parent chain when the node has no file of its own. */
function fileResolver(byId: Map<NodeId, IRNode>): (id: NodeId) => string | undefined {
  const memo = new Map<NodeId, string | undefined>();
  const resolve = (id: NodeId, seen: Set<NodeId>): string | undefined => {
    if (memo.has(id)) return memo.get(id);
    const node = byId.get(id);
    if (!node || seen.has(id)) return undefined;
    seen.add(id);
    const file = scopeOfNode(node) ?? (node.parent !== undefined ? resolve(node.parent, seen) : undefined);
    memo.set(id, file);
    return file;
  };
  return (id) => resolve(id, new Set());
}

function stubFor(node: IRNode): IRNode {
  return {
    id: node.id,
    facet: node.facet,
    kind: node.kind,
    attrs: { ...node.attrs, external: true },
    provenance: { frontend: "scope", confidence: "exact" },
  };
}

function findingInScope(finding: IRFinding, scope: string, local: Set<NodeId>): boolean {
  if (finding.span) return inScope(finding.span.file, scope);
  return (finding.nodes ?? []).some((id) => local.has(id));
}
