import type { IREdge, IRDocument, IRFinding, IRNode } from "@insight/ir";
import { buildProjectModel, type ProjectModel } from "./model.js";

/**
 * The version of the serialized model. A reader refuses any other value, so a page built against one
 * schema never reads another. Bump it when the shape of SerializedModel changes.
 */
export const MODEL_SCHEMA = 1;

/**
 * The model as plain JSON. The IR document is the source of truth: every index (tree, functions,
 * relations) is derived from it again by buildProjectModel, so the file holds no derived data.
 */
export interface SerializedModel {
  schema: typeof MODEL_SCHEMA;
  /** The snapshot the model was built from. */
  snapshot: string;
  doc: { nodes: IRNode[]; edges: IREdge[]; findings: IRFinding[] };
}

/** Serializes a model as the snapshot it was built from. The document is copied, not shared, so the result can be stored as is. */
export function serializeModel(model: ProjectModel, snapshot: string): SerializedModel {
  const { nodes, edges, findings } = model.doc;
  return { schema: MODEL_SCHEMA, snapshot, doc: { nodes: [...nodes], edges: [...edges], findings: [...findings] } };
}

/**
 * Rebuilds a project model from its serialized form. A value that is not a model of this schema
 * (missing fields, another schema number) throws, so a stale or foreign file fails loudly.
 */
export function loadModel(json: unknown): ProjectModel {
  if (typeof json !== "object" || json === null) throw new Error("model: expected an object");
  const { schema, doc } = json as { schema?: unknown; doc?: unknown };
  if (schema !== MODEL_SCHEMA) throw new Error(`model: schema ${String(schema)} is not ${MODEL_SCHEMA}`);
  const d = doc as Partial<IRDocument> | undefined;
  if (!d || !Array.isArray(d.nodes) || !Array.isArray(d.edges) || !Array.isArray(d.findings)) {
    throw new Error("model: doc must hold nodes, edges and findings arrays");
  }
  return buildProjectModel({ nodes: d.nodes, edges: d.edges, findings: d.findings });
}
