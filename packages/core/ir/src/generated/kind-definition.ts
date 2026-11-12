/* Generated from the JSON Schema by scripts/generate-types.mjs. Do not edit. */

export type Part = Part1 & {
  role: string;
  kind?: string;
  /**
   * @minItems 1
   */
  oneOf?: [string, ...string[]];
  many?: boolean;
  optional?: boolean;
  contains?: Part[];
};
export type Part1 = {
  [k: string]: unknown;
};

/**
 * A kind declared as data. It may extend one kind and may be composed of existing kinds.
 */
export interface KindDefinition {
  kind: string;
  facet: string;
  /**
   * Whether instances are nodes or edges.
   */
  on: "node" | "edge";
  extends?: string;
  /**
   * JSON Schema for the kind's own attributes.
   */
  attrs?: {
    [k: string]: unknown;
  };
  composedOf?: Part[];
  description?: string;
}
