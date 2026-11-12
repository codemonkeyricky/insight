// Node-only entry: reads the IR's JSON Schemas and kind definitions from disk. Browser code must use `@insight/ir`.
import { createIRAjv, KindRegistry, type IRSchemaSet } from "./registry.js";
import { loadCoreKindDefinitions, loadCoreSchema, loadFacetSchemas, loadKindDefinitionSchema } from "./schemas.js";

export { loadCoreKindDefinitions, loadFacetSchemas, loadCoreSchema, loadKindDefinitionSchema, schemaDir } from "./schemas.js";

/** Every IR schema, read from the package's schema directory. */
export function loadIRSchemas(): IRSchemaSet {
  return { core: loadCoreSchema(), kindDefinition: loadKindDefinitionSchema(), facets: loadFacetSchemas() };
}

/** A registry holding the core kinds. Plugins add their own on top of a clone of this. */
export function createCoreRegistry(): KindRegistry {
  const registry = new KindRegistry(createIRAjv(loadIRSchemas()));
  registry.add(loadCoreKindDefinitions(), "core", { core: true });
  return registry;
}
