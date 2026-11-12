import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { IRDocument, IRRecord } from "@insight/ir";
import type { ProjectPaths } from "./paths.js";
import { canonicalJson, sha256, writeFileAtomic } from "./util.js";

/**
 * Canonical NDJSON for a document. Lines are sorted by their text inside each record kind
 * (nodes, then edges, then findings), so equal IR always gives equal bytes.
 */
export function serializeDocument(doc: IRDocument): string {
  const groups: Record<"node" | "edge" | "finding", string[]> = { node: [], edge: [], finding: [] };
  for (const node of doc.nodes) groups.node.push(canonicalJson({ node }));
  for (const edge of doc.edges) groups.edge.push(canonicalJson({ edge }));
  for (const finding of doc.findings) groups.finding.push(canonicalJson({ finding }));
  const lines = [...groups.node.sort(), ...groups.edge.sort(), ...groups.finding.sort()];
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

export function snapshotId(text: string): string {
  return sha256(text).slice(0, 16);
}

export function snapshotPath(paths: ProjectPaths, id: string): string {
  return join(paths.snapshots, `${id}.ndjson`);
}

export function writeSnapshot(paths: ProjectPaths, id: string, text: string): void {
  writeFileAtomic(snapshotPath(paths, id), text);
}

export function snapshotExists(paths: ProjectPaths, id: string): boolean {
  return existsSync(snapshotPath(paths, id));
}

export function deleteSnapshot(paths: ProjectPaths, id: string): void {
  rmSync(snapshotPath(paths, id), { force: true });
}

export function readSnapshot(paths: ProjectPaths, id: string): IRRecord[] {
  return readFileSync(snapshotPath(paths, id), "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as IRRecord);
}
