/** The facets the core defines. Plugins may also use x-<name> facets. */
export const CORE_FACETS = [
  "structure",
  "packaging",
  "flow",
  "calls",
  "concurrency",
  "sync",
  "effects",
] as const;

export type CoreFacet = (typeof CORE_FACETS)[number];

const FACET_PATTERN = /^(structure|packaging|flow|calls|concurrency|sync|effects|x-[a-z0-9-]+)$/;

export function isFacetId(value: string): boolean {
  return FACET_PATTERN.test(value);
}

export function isCoreFacet(value: string): value is CoreFacet {
  return (CORE_FACETS as readonly string[]).includes(value);
}
