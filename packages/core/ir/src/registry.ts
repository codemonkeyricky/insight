import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import type { KindDefinition, Part } from "./generated/kind-definition.js";
import { isCoreFacet, isFacetId } from "./facets.js";
import {
  CORE_SCHEMA_ID,
  KIND_DEFINITION_SCHEMA_ID,
  loadCoreSchema,
  loadFacetSchemas,
  loadKindDefinitionSchema,
} from "./schemas.js";

export interface RegisteredKind {
  kind: string;
  facet: string;
  on: "node" | "edge";
  extends?: string;
  attrs?: Record<string, unknown>;
  composedOf?: Part[];
  description?: string;
  /** "core" or the plugin id that supplied the definition. */
  source: string;
}

export class KindRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KindRegistryError";
  }
}

/** Creates the Ajv instance used for every schema in the IR. All IR schemas are registered once. */
export function createIRAjv(): Ajv2020 {
  const ajv = new Ajv2020({ allErrors: true, strict: false, allowUnionTypes: true });
  ajv.addSchema(loadCoreSchema(), CORE_SCHEMA_ID);
  ajv.addSchema(loadKindDefinitionSchema(), KIND_DEFINITION_SCHEMA_ID);
  for (const schema of loadFacetSchemas()) ajv.addSchema(schema);
  return ajv;
}

/**
 * Registry of kinds. A kind is either a core kind or a definition supplied by a plugin.
 * Definitions are added as a batch: either the whole batch is accepted or none of it is.
 */
export class KindRegistry {
  private readonly kinds: Map<string, RegisteredKind>;
  private readonly ajv: Ajv2020;
  private readonly kindValidator: ValidateFunction;
  private readonly attrValidators = new Map<string, ValidateFunction>();
  private readonly subkindCache = new Map<string, string[]>();

  constructor(ajv: Ajv2020 = createIRAjv(), kinds: Map<string, RegisteredKind> = new Map()) {
    this.ajv = ajv;
    this.kinds = kinds;
    const compiled = ajv.getSchema(KIND_DEFINITION_SCHEMA_ID);
    if (!compiled) throw new Error("kind-definition schema is not registered");
    this.kindValidator = compiled;
  }

  /** Returns an independent copy, so a plugin's definitions can be tried without touching the original. */
  clone(): KindRegistry {
    return new KindRegistry(this.ajv, new Map(this.kinds));
  }

  /**
   * Adds kind definitions. `source` names who supplies them ("core" or a plugin id) and appears in errors.
   * Plugin definitions must use an x-<name>. kind namespace. Core definitions may use facet namespaces.
   */
  add(definitions: unknown[], source: string, options: { core?: boolean } = {}): void {
    const core = options.core ?? false;
    const errors: string[] = [];
    const next = new Map(this.kinds);
    const batch: RegisteredKind[] = [];

    for (const [index, raw] of definitions.entries()) {
      if (!this.kindValidator(raw)) {
        const detail = (this.kindValidator.errors ?? [])
          .map((e) => `${e.instancePath || "/"} ${e.message ?? ""}`.trim())
          .join("; ");
        errors.push(`definition #${index + 1} from "${source}" is not a valid kind definition: ${detail}`);
        continue;
      }
      const def = raw as KindDefinition;
      if (!core && !def.kind.startsWith("x-")) {
        errors.push(
          `"${source}" defines kind "${def.kind}"; plugin kinds must use an x-<name>. namespace`,
        );
        continue;
      }
      if (!isFacetId(def.facet)) {
        errors.push(`kind "${def.kind}" from "${source}" uses unknown facet "${def.facet}"`);
        continue;
      }
      if (!core && !isCoreFacet(def.facet) && !def.facet.startsWith("x-")) {
        errors.push(`kind "${def.kind}" from "${source}" uses unknown facet "${def.facet}"`);
        continue;
      }
      const existing = next.get(def.kind);
      if (existing) {
        errors.push(
          `kind "${def.kind}" is defined by both "${existing.source}" and "${source}"`,
        );
        continue;
      }
      const entry: RegisteredKind = {
        kind: def.kind,
        facet: def.facet,
        on: def.on,
        ...(def.extends !== undefined ? { extends: def.extends } : {}),
        ...(def.attrs !== undefined ? { attrs: def.attrs } : {}),
        ...(def.composedOf !== undefined ? { composedOf: def.composedOf } : {}),
        ...(def.description !== undefined ? { description: def.description } : {}),
        source,
      };
      next.set(def.kind, entry);
      batch.push(entry);
    }

    // Cross-checks run against the combined map so definitions in one batch can refer to each other.
    for (const entry of batch) {
      if (entry.extends !== undefined) {
        const parent = next.get(entry.extends);
        if (!parent) {
          errors.push(
            `kind "${entry.kind}" from "${source}" extends "${entry.extends}", which no loaded definition provides`,
          );
        } else {
          if (parent.facet !== entry.facet) {
            errors.push(
              `kind "${entry.kind}" (facet ${entry.facet}) extends "${parent.kind}" (facet ${parent.facet}); extension must stay in one facet`,
            );
          }
          if (parent.on !== entry.on) {
            errors.push(`kind "${entry.kind}" is a ${entry.on} kind but extends the ${parent.on} kind "${parent.kind}"`);
          }
          if (this.hasCycle(entry.kind, next)) {
            errors.push(`kind "${entry.kind}" extends itself through a chain of kinds`);
          }
        }
      }
      for (const part of entry.composedOf ?? []) {
        this.checkPart(part, entry, next, errors);
      }
      if (entry.attrs !== undefined) {
        try {
          this.ajv.compile(entry.attrs);
        } catch (err) {
          errors.push(`kind "${entry.kind}" from "${source}" has invalid attrs schema: ${(err as Error).message}`);
        }
      }
    }

    if (errors.length > 0) {
      throw new KindRegistryError(errors.join("\n"));
    }
    this.kinds.clear();
    for (const [k, v] of next) this.kinds.set(k, v);
    this.attrValidators.clear();
    this.subkindCache.clear();
  }

  private checkPart(part: Part, owner: RegisteredKind, all: Map<string, RegisteredKind>, errors: string[]): void {
    const names = part.kind !== undefined ? [part.kind] : part.oneOf ?? [];
    for (const name of names) {
      if (!all.has(name)) {
        errors.push(
          `kind "${owner.kind}" from "${owner.source}" is composed of "${name}" (role ${part.role}), which no loaded definition provides`,
        );
      }
    }
    for (const child of part.contains ?? []) this.checkPart(child, owner, all, errors);
  }

  private hasCycle(start: string, all: Map<string, RegisteredKind>): boolean {
    const seen = new Set<string>();
    let current = all.get(start)?.extends;
    while (current !== undefined) {
      if (current === start || seen.has(current)) return true;
      seen.add(current);
      current = all.get(current)?.extends;
    }
    return false;
  }

  has(kind: string): boolean {
    return this.kinds.has(kind);
  }

  get(kind: string): RegisteredKind | undefined {
    return this.kinds.get(kind);
  }

  list(): RegisteredKind[] {
    return [...this.kinds.values()];
  }

  /** Kinds this kind extends, nearest first. */
  ancestors(kind: string): string[] {
    const out: string[] = [];
    let current = this.kinds.get(kind)?.extends;
    while (current !== undefined && !out.includes(current)) {
      out.push(current);
      current = this.kinds.get(current)?.extends;
    }
    return out;
  }

  /** True when `kind` is `ancestor` or extends it, directly or through a chain. */
  isA(kind: string, ancestor: string): boolean {
    return kind === ancestor || this.ancestors(kind).includes(ancestor);
  }

  /** The kind itself and every registered kind that extends it, at any depth. */
  subkinds(kind: string): string[] {
    const cached = this.subkindCache.get(kind);
    if (cached) return cached;
    const result = [kind];
    for (const entry of this.kinds.values()) {
      if (entry.kind !== kind && this.isA(entry.kind, kind)) result.push(entry.kind);
    }
    this.subkindCache.set(kind, result);
    return result;
  }

  /** Kinds not present in the registry are opaque: stored and shown, but without a schema. */
  isOpaque(kind: string): boolean {
    return !this.kinds.has(kind);
  }

  /** Validates attributes against the merged schema of the kind and all its ancestors. */
  validateAttrs(kind: string, attrs: unknown): string[] {
    const entry = this.kinds.get(kind);
    if (!entry) return [];
    let validator = this.attrValidators.get(kind);
    if (!validator) {
      const chain = [...this.ancestors(kind).reverse(), kind]
        .map((k) => this.kinds.get(k)?.attrs)
        .filter((s): s is Record<string, unknown> => s !== undefined);
      validator = this.ajv.compile(chain.length === 0 ? {} : { allOf: chain });
      this.attrValidators.set(kind, validator);
    }
    if (validator(attrs)) return [];
    return (validator.errors ?? []).map((e) => {
      const path = e.instancePath.replace(/^\//, "").replace(/\//g, ".");
      return `attrs${path ? `.${path}` : ""} ${e.message ?? "is invalid"}`;
    });
  }
}
