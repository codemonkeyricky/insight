import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Directory holding the JSON Schema sources. Works from both src/ and dist/. */
export const SCHEMA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "schema");

export const CORE_SCHEMA_ID = "https://insight.dev/ir/core.json";
export const KIND_DEFINITION_SCHEMA_ID = "https://insight.dev/ir/kind-definition.json";

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

export function loadCoreSchema(): Record<string, unknown> {
  return readJson(join(SCHEMA_DIR, "core.schema.json")) as Record<string, unknown>;
}

export function loadKindDefinitionSchema(): Record<string, unknown> {
  return readJson(join(SCHEMA_DIR, "kind-definition.schema.json")) as Record<string, unknown>;
}

/** Every facet attribute schema, keyed by its $id. */
export function loadFacetSchemas(): Record<string, unknown>[] {
  const dir = join(SCHEMA_DIR, "facets");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".schema.json"))
    .sort()
    .map((f) => readJson(join(dir, f)) as Record<string, unknown>);
}

/** The kinds the core ships, as kind definitions (JSON). */
export function loadCoreKindDefinitions(): unknown[] {
  return readJson(join(SCHEMA_DIR, "core.kinds.json")) as unknown[];
}
