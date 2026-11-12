import type { IRDocument } from "@insight/ir";
import { isExternal } from "@insight/sdk";
import {
  buildProjectModel,
  normalizeScope as modelNormalizeScope,
  ScopeError,
  scopeView,
  type ScopedDocument,
  type ScopeOptions,
} from "@insight/model";
import { compareStrings, InputError } from "./util.js";

export { ROOT_SCOPE, inScope, scopeOfNode, type ScopedDocument, type ScopeOptions, type ScopeStats } from "@insight/model";

/** True for a stub that scopeDoc added for a node outside the scope. The same test the lenses use (from @insight/sdk). */
export { isExternal };

/**
 * Checks a scope string from a caller and returns its canonical form: forward slashes, no "." or
 * empty segments, no trailing slash. A scope must stay inside the project. A bad scope is an
 * InputError (the server maps it to 400).
 */
export function normalizeScope(scope: string): string {
  try {
    return modelNormalizeScope(scope);
  } catch (err) {
    if (err instanceof ScopeError) throw new InputError(err.message);
    throw err;
  }
}

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
 * Cuts an IR document down to one scope: a view of the document's project model (see
 * @insight/model and docs/scoped-ir.md). The root scope "" returns the whole document, unchanged.
 * Ids are never rewritten, so an id means the same node in every scope.
 */
export function scopeDoc(doc: IRDocument, scope: string, opts: ScopeOptions = {}): ScopedDocument {
  return scopeView(buildProjectModel(doc), normalizeScope(scope)).toDoc(opts);
}
