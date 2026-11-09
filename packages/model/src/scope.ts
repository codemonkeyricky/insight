import type { IRDocument, IREdge, IRFinding, IRNode, NodeId } from "@insight/ir";

/**
 * A scope is a project-relative path: a file ("src/a.ts"), a folder ("src") or "" for the whole
 * project. Folders are not nodes in the IR; a folder scope holds every node whose file lies under it.
 */
export const ROOT_SCOPE = "";

/** A scope string that cannot name a place in the project. Core maps it to its InputError. */
export class ScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScopeError";
  }
}

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
  if (raw.startsWith("/")) throw new ScopeError(`scope must be relative to the project: ${scope}`);
  const parts = raw.split("/").filter((p) => p !== "" && p !== ".");
  if (parts.includes("..")) throw new ScopeError(`scope must not leave the project: ${scope}`);
  return parts.join("/");
}

/**
 * The project file a node belongs to, from its own fields alone. A node with a span belongs to the
 * span's file; a structure.file node belongs to its own path. Other nodes return undefined here,
 * and the model then looks at their parent.
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

/** The file of a node, looking up the parent chain when the node has no file of its own. Memoized per resolver. */
export function fileResolver(byId: ReadonlyMap<NodeId, IRNode>): (id: NodeId) => string | undefined {
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

/** The stub for a node outside a scope: same id, facet, kind and attrs, marked external, with no span or parent. */
export function stubFor(node: IRNode): IRNode {
  return {
    id: node.id,
    facet: node.facet,
    kind: node.kind,
    attrs: { ...node.attrs, external: true },
    provenance: { frontend: "scope", confidence: "exact" },
  };
}

/** True when a finding is kept by a scope: its span's file is in the scope, or (no span) one of its nodes is local. */
export function findingInScope(finding: IRFinding, scope: string, local: ReadonlySet<NodeId>): boolean {
  if (finding.span) return inScope(finding.span.file, scope);
  return (finding.nodes ?? []).some((id) => local.has(id));
}

