export * from "./generated/core.js";
export * from "./generated/kind-definition.js";
export type * from "./generated/structure.js";
export type * from "./generated/flow.js";
export type * from "./generated/packaging.js";
export type * from "./generated/calls.js";
export type * from "./generated/concurrency.js";
export type * from "./generated/sync.js";
export type * from "./generated/effects.js";
export { CORE_FACETS, isCoreFacet, isFacetId, type CoreFacet } from "./facets.js";
export { KindRegistry, KindRegistryError, createIRAjv, type RegisteredKind } from "./registry.js";
export { validateIR, parseNdjson, type Diagnostic, type IRDocument, type ValidationReport, type ValidateOptions } from "./validate.js";
export { loadCoreKindDefinitions, loadFacetSchemas, loadCoreSchema, SCHEMA_DIR, CORE_SCHEMA_ID } from "./schemas.js";

import { KindRegistry } from "./registry.js";
import { loadCoreKindDefinitions } from "./schemas.js";

/** A registry holding the core kinds. Plugins add their own on top of a clone of this. */
export function createCoreRegistry(): KindRegistry {
  const registry = new KindRegistry();
  registry.add(loadCoreKindDefinitions(), "core", { core: true });
  return registry;
}
