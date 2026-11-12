import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export { CORE_SCHEMA_ID, KIND_DEFINITION_SCHEMA_ID } from "./ids.js";

/**
 * Directory holding the JSON Schema sources. Works from both src/ and dist/. It is worked out on first use, not when
 * the module loads: the web app bundles this package through @insight/sdk, and a browser has no fileURLToPath.
 */
export function schemaDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "schema");
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

export function loadCoreSchema(): Record<string, unknown> {
  return readJson(join(schemaDir(), "core.schema.json")) as Record<string, unknown>;
}

export function loadKindDefinitionSchema(): Record<string, unknown> {
  return readJson(join(schemaDir(), "kind-definition.schema.json")) as Record<string, unknown>;
}

/** Every facet attribute schema, keyed by its $id. */
export function loadFacetSchemas(): Record<string, unknown>[] {
  const dir = join(schemaDir(), "facets");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".schema.json"))
    .sort()
    .map((f) => readJson(join(dir, f)) as Record<string, unknown>);
}

/** The kinds the core ships, as kind definitions (JSON). */
export function loadCoreKindDefinitions(): unknown[] {
  return readJson(join(schemaDir(), "core.kinds.json")) as unknown[];
}
