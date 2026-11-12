import type { IREdge, IRNode, NodeId } from "@insight/ir";
import { edgeTargets } from "@insight/sdk";
import type { FunctionEntity, ProjectModel, Rel } from "./model.js";
import { findingInScope, inScope, normalizeScope, ROOT_SCOPE, stubFor, type ScopedDocument, type ScopeOptions } from "./scope.js";

export type ScopeKindName = "project" | "folder" | "file";

/** A relation seen from a view. `inScope` says whether the far end (the other node of the relation) is in the view. */
export interface ScopeRel extends Rel {
  inScope: boolean;
}

/**
 * A scope as a view of one project model. The model holds the whole project; the view answers
 * which nodes are in the scope, and how the scope's functions relate to the rest of the project.
 */
export interface ScopeView {
  /** The whole-project model the view reads. */
  model: ProjectModel;
  /** The canonical scope path ("" for the project). */
  scope: string;
  kind: ScopeKindName;
  /** True when the node is in the scope. The root holds every node of the document. */
  has(id: NodeId): boolean;
  /** Project-relative paths of the files in the scope, sorted. */
  files(): string[];
  /** The functions in the scope, in the model's order (file, line, id). */
  functions(): FunctionEntity[];
  /** Relations into `id` from anywhere in the project. `inScope` tells whether the caller is in the view. */
  callers(id: NodeId): ScopeRel[];
  /** Relations out of `id` to anywhere in the project. `inScope` tells whether the callee is in the view. */
  callees(id: NodeId): ScopeRel[];
  /** The scoped IR document, with the same rules as the old scopeDoc (see docs/scoped-ir.md). */
  toDoc(opts?: ScopeOptions): ScopedDocument;
}

/** Makes the view of one scope. The scope is checked by normalizeScope and throws a ScopeError when it leaves the project. */
export function scopeView(model: ProjectModel, scope: string): ScopeView {
  const s = normalizeScope(scope);
  const fileSet = new Set(model.files);
  const kind: ScopeKindName = s === ROOT_SCOPE ? "project" : fileSet.has(s) ? "file" : "folder";

  let local: Set<NodeId> | undefined;
  const localNodes = (): Set<NodeId> => {
    if (local) return local;
    local = new Set<NodeId>();
    for (const node of model.doc.nodes) {
      const file = model.fileOf(node.id);
      if (file !== undefined && inScope(file, s)) local.add(node.id);
    }
    return local;
  };
  const has = (id: NodeId): boolean => (s === ROOT_SCOPE ? model.byId.has(id) : localNodes().has(id));

  return {
    model,
    scope: s,
    kind,
    has,
    files: () => model.files.filter((f) => inScope(f, s)),
    functions: () => model.functions.filter((f) => has(f.id)),
    callers: (id) => (model.in.get(id) ?? []).map((r) => ({ ...r, inScope: has(r.from) })),
    callees: (id) => (model.out.get(id) ?? []).map((r) => ({ ...r, inScope: has(r.to) })),
    toDoc: (opts) => cutDoc(model, s, s === ROOT_SCOPE ? undefined : localNodes(), opts ?? {}),
  };
}

/**
 * Cuts the model's document down to one scope. `local` is the scope's node set (undefined at the root,
 * which returns the whole document).
 *
 * - The root scope "" returns the whole document, unchanged.
 * - A node is kept when its file is in the scope (see fileOf). A parent link to a node that was dropped is removed.
 * - An edge is kept when either end is in the scope. The far end, when it is a node of the
 *   document, becomes an external stub. Candidate sets keep every member and stub the ones outside.
 * - A finding is kept when its span's file is in the scope. A finding without a span is kept when
 *   one of its nodes is in the scope.
 *
 * Ids are never rewritten, so an id means the same node in every scope.
 */
function cutDoc(model: ProjectModel, s: string, local: Set<NodeId> | undefined, opts: ScopeOptions): ScopedDocument {
  const { doc, byId } = model;
  if (local === undefined) {
    return {
      doc: { nodes: [...doc.nodes], edges: [...doc.edges], findings: [...doc.findings] },
      stats: { nodes: doc.nodes.length, edges: doc.edges.length, findings: doc.findings.length, external: 0 },
    };
  }
  const stubs = opts.externalStubs !== false;

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
  for (const id of [...external].sort(cmp)) {
    const original = byId.get(id);
    if (original) stubNodes.push(stubFor(original));
  }

  const findings = doc.findings.filter((f) => findingInScope(f, s, local));
  return {
    doc: { nodes: [...nodes, ...stubNodes], edges, findings },
    stats: { nodes: nodes.length, edges: edges.length, findings: findings.length, external: stubNodes.length },
  };
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
