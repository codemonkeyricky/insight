import { randomUUID } from "node:crypto";
import type { ProjectPaths } from "./paths.js";
import { InputError, readJsonFile, writeFileAtomic } from "./util.js";

export const ANNOTATIONS_SCHEMA = 1;
export const TARGET_TYPES = ["node", "edge", "finding"] as const;
export type TargetType = (typeof TARGET_TYPES)[number];

/**
 * A comment on something in the IR. The key is the node id for a node, the finding key `<lens>#<id>`
 * for a finding, and an opaque string the UI chooses for an edge. Node ids are stable across reindexing,
 * so annotations survive it.
 */
export interface Annotation {
  id: string;
  target: { type: TargetType; key: string };
  text: string;
  createdAt: string;
  updatedAt: string;
}

/** Stored as .insight/annotations.json. */
export interface AnnotationsFile {
  schema: typeof ANNOTATIONS_SCHEMA;
  annotations: Annotation[];
}

const TEXT_LIMIT = 4000;
const KEY_LIMIT = 1000;

export function readAnnotations(paths: ProjectPaths): AnnotationsFile {
  const file = readJsonFile<AnnotationsFile | undefined>(paths.annotations, undefined);
  return file && file.schema === ANNOTATIONS_SCHEMA && Array.isArray(file.annotations)
    ? file
    : { schema: ANNOTATIONS_SCHEMA, annotations: [] };
}

function write(paths: ProjectPaths, file: AnnotationsFile): void {
  writeFileAtomic(paths.annotations, `${JSON.stringify(file, null, 1)}\n`);
}

function checkText(text: unknown): string {
  const t = typeof text === "string" ? text.trim() : "";
  if (t === "") throw new InputError("text is required");
  if (t.length > TEXT_LIMIT) throw new InputError(`text is longer than ${TEXT_LIMIT} characters`);
  return t;
}

export function listAnnotations(paths: ProjectPaths, target?: { type?: string; key?: string }): Annotation[] {
  return readAnnotations(paths).annotations.filter(
    (a) => (target?.type === undefined || a.target.type === target.type) && (target?.key === undefined || a.target.key === target.key),
  );
}

export function addAnnotation(paths: ProjectPaths, input: { type: unknown; key: unknown; text: unknown }, now = new Date()): Annotation {
  if (!TARGET_TYPES.includes(input.type as TargetType)) throw new InputError(`type must be one of ${TARGET_TYPES.join(", ")}`);
  if (typeof input.key !== "string" || input.key.trim() === "" || input.key.length > KEY_LIMIT) {
    throw new InputError("key is required and must be at most 1000 characters");
  }
  const at = now.toISOString();
  const annotation: Annotation = {
    id: randomUUID(),
    target: { type: input.type as TargetType, key: input.key },
    text: checkText(input.text),
    createdAt: at,
    updatedAt: at,
  };
  const file = readAnnotations(paths);
  file.annotations.push(annotation);
  write(paths, file);
  return annotation;
}

export function updateAnnotation(paths: ProjectPaths, id: string, text: unknown, now = new Date()): Annotation | undefined {
  const file = readAnnotations(paths);
  const hit = file.annotations.find((a) => a.id === id);
  if (!hit) return undefined;
  hit.text = checkText(text);
  hit.updatedAt = now.toISOString();
  write(paths, file);
  return hit;
}

/** Removes an annotation. Returns false when there was none with that id. */
export function deleteAnnotation(paths: ProjectPaths, id: string): boolean {
  const file = readAnnotations(paths);
  const before = file.annotations.length;
  file.annotations = file.annotations.filter((a) => a.id !== id);
  if (file.annotations.length === before) return false;
  write(paths, file);
  return true;
}
