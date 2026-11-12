import { type ValidateFunction } from "ajv/dist/2020.js";
import type { IRFinding, IREdge, IRNode } from "./generated/core.js";
import { createIRAjv, KindRegistry } from "./registry.js";
import { CORE_SCHEMA_ID } from "./schemas.js";
import { Ajv2020 } from "ajv/dist/2020.js";

export interface Diagnostic {
  /** 1-based line in the NDJSON input, when the problem is tied to a line. */
  line?: number;
  message: string;
}

export interface IRDocument {
  nodes: IRNode[];
  edges: IREdge[];
  findings: IRFinding[];
}

export interface ValidationReport extends IRDocument {
  ok: boolean;
  errors: Diagnostic[];
  /** Kinds used by the document that the registry does not know. */
  opaqueKinds: string[];
}

export interface ValidateOptions {
  /** Require every parent and edge endpoint to exist inside the document. Default true. */
  closed?: boolean;
}

export interface ParsedLine {
  line: number;
  value: unknown;
}

/** Splits NDJSON text into parsed lines. Parse failures are returned as diagnostics. */
export function parseNdjson(text: string): { lines: ParsedLine[]; errors: Diagnostic[] } {
  const lines: ParsedLine[] = [];
  const errors: Diagnostic[] = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    if (raw.trim() === "") return;
    try {
      lines.push({ line: index + 1, value: JSON.parse(raw) as unknown });
    } catch (err) {
      errors.push({ line: index + 1, message: `not valid JSON: ${(err as Error).message}` });
    }
  });
  return { lines, errors };
}

function formatAjvErrors(validator: ValidateFunction): string {
  return (validator.errors ?? [])
    .map((e) => {
      const where = e.instancePath === "" ? "record" : e.instancePath.replace(/^\//, "").replace(/\//g, ".");
      return `${where} ${e.message ?? "is invalid"}`;
    })
    .join("; ");
}

/**
 * Validates an IR document. Structure is checked against the core JSON Schema, and each
 * node or edge is checked against its kind (facet, node/edge role, attribute schema).
 */
export function validateIR(
  text: string,
  registry: KindRegistry,
  options: ValidateOptions = {},
  ajv: Ajv2020 = createIRAjv(),
): ValidationReport {
  const closed = options.closed ?? true;
  const { lines, errors: parseErrors } = parseNdjson(text);
  const errors: Diagnostic[] = [...parseErrors];
  const opaque = new Set<string>();
  const doc: IRDocument = { nodes: [], edges: [], findings: [] };
  const lineOf = new Map<unknown, number>();

  const shapeValidators: Record<"node" | "edge" | "finding", ValidateFunction> = {
    node: ajv.compile({ $ref: `${CORE_SCHEMA_ID}#/$defs/IRNode` }),
    edge: ajv.compile({ $ref: `${CORE_SCHEMA_ID}#/$defs/IREdge` }),
    finding: ajv.compile({ $ref: `${CORE_SCHEMA_ID}#/$defs/IRFinding` }),
  };

  const seenIds = new Map<string, number>();
  for (const { line, value } of lines) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      errors.push({ line, message: "record must be a JSON object with one of node, edge or finding" });
      continue;
    }
    const keys = Object.keys(value);
    const recordType = keys.length === 1 ? keys[0] : undefined;
    if (recordType !== "node" && recordType !== "edge" && recordType !== "finding") {
      errors.push({
        line,
        message: `record must have exactly one of node, edge or finding (found: ${keys.join(", ") || "nothing"})`,
      });
      continue;
    }
    const body = (value as Record<string, unknown>)[recordType];
    const shape = shapeValidators[recordType];
    if (!shape(body)) {
      errors.push({ line, message: `${recordType}: ${formatAjvErrors(shape)}` });
      continue;
    }

    if (recordType === "node") {
      const node = body as IRNode;
      if (seenIds.has(node.id)) {
        errors.push({ line, message: `node "${node.id}" is defined twice (first on line ${seenIds.get(node.id)})` });
        continue;
      }
      seenIds.set(node.id, line);
      lineOf.set(node, line);
      doc.nodes.push(node);
      checkKind(node.kind, node.facet, "node", node.attrs, `node "${node.id}"`, line);
    } else if (recordType === "edge") {
      const edge = body as IREdge;
      lineOf.set(edge, line);
      doc.edges.push(edge);
      checkKind(edge.kind, edge.facet, "edge", edge.attrs ?? {}, `edge ${edge.from} -> ${edge.kind}`, line);
    } else {
      doc.findings.push(body as IRFinding);
    }
  }

  function checkKind(
    kind: string,
    facet: string,
    role: "node" | "edge",
    attrs: unknown,
    label: string,
    line: number,
  ): void {
    if (registry.isOpaque(kind)) {
      opaque.add(kind);
      return;
    }
    const entry = registry.get(kind);
    if (!entry) return;
    if (entry.on !== role) {
      errors.push({ line, message: `${label}: kind "${kind}" is an ${entry.on} kind and cannot be used as a ${role}` });
    }
    if (entry.facet !== facet) {
      errors.push({ line, message: `${label}: kind "${kind}" belongs to facet "${entry.facet}", not "${facet}"` });
    }
    for (const problem of registry.validateAttrs(kind, attrs)) {
      errors.push({ line, message: `${label}: kind "${kind}" ${problem}` });
    }
  }

  if (closed) {
    const ids = new Set(doc.nodes.map((n) => n.id));
    for (const node of doc.nodes) {
      if (node.parent !== undefined && !ids.has(node.parent)) {
        errors.push({ line: lineOf.get(node), message: `node "${node.id}": parent "${node.parent}" is not defined in this document` });
      }
    }
    for (const edge of doc.edges) {
      const line = lineOf.get(edge);
      if (!ids.has(edge.from)) {
        errors.push({ line, message: `edge: from "${edge.from}" is not defined in this document` });
      }
      const to = edge.to;
      if (typeof to === "string") {
        if (!ids.has(to)) errors.push({ line, message: `edge from "${edge.from}": to "${to}" is not defined in this document` });
      } else if ("candidates" in to) {
        for (const c of to.candidates) {
          if (!ids.has(c)) errors.push({ line, message: `edge from "${edge.from}": candidate "${c}" is not defined in this document` });
        }
      }
    }
  }

  return {
    ...doc,
    ok: errors.length === 0,
    errors,
    opaqueKinds: [...opaque].sort(),
  };
}
