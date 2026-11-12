import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type Database from "better-sqlite3";
import type { IRDocument } from "@insight/ir";

/**
 * Opens a SQLite database. better-sqlite3 is a native module, so it is imported here and nowhere else: a run that
 * writes no index never loads it, and a bundle without it still works.
 */
async function openDatabase(file: string, options?: Database.Options): Promise<Database.Database> {
  const { default: Driver } = await import("better-sqlite3");
  return new Driver(file, options);
}

const SCHEMA = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE nodes (
  id TEXT PRIMARY KEY, facet TEXT NOT NULL, kind TEXT NOT NULL, parent TEXT,
  file TEXT, line INTEGER, col INTEGER, json TEXT NOT NULL
);
CREATE INDEX nodes_facet ON nodes (facet);
CREATE INDEX nodes_kind ON nodes (kind);
CREATE INDEX nodes_file ON nodes (file);
CREATE INDEX nodes_parent ON nodes (parent);
CREATE TABLE edges (
  id INTEGER PRIMARY KEY, from_id TEXT NOT NULL, to_id TEXT,
  to_scheme TEXT, to_text TEXT, facet TEXT NOT NULL, kind TEXT NOT NULL, file TEXT, json TEXT NOT NULL
);
CREATE INDEX edges_from ON edges (from_id);
CREATE INDEX edges_to ON edges (to_id);
CREATE INDEX edges_kind ON edges (kind);
CREATE TABLE findings (
  id INTEGER PRIMARY KEY, severity TEXT NOT NULL, message TEXT NOT NULL, file TEXT, json TEXT NOT NULL
);
`;

/**
 * Rebuilds the SQLite index from a document. The database holds no state of its own: deleting
 * it and running again gives the same contents. Candidate edges get one row per candidate.
 */
export async function writeIndex(dbPath: string, doc: IRDocument, snapshot: string): Promise<void> {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = await openDatabase(dbPath);
  try {
    db.exec(
      "DROP TABLE IF EXISTS meta; DROP TABLE IF EXISTS nodes; DROP TABLE IF EXISTS edges; DROP TABLE IF EXISTS findings;",
    );
    db.exec(SCHEMA);
    const insMeta = db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)");
    const insNode = db.prepare(
      "INSERT INTO nodes (id, facet, kind, parent, file, line, col, json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const insEdge = db.prepare(
      "INSERT INTO edges (from_id, to_id, to_scheme, to_text, facet, kind, file, json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const insFinding = db.prepare("INSERT INTO findings (severity, message, file, json) VALUES (?, ?, ?, ?)");
    db.transaction(() => {
      insMeta.run("snapshot", snapshot);
      insMeta.run("nodes", String(doc.nodes.length));
      insMeta.run("edges", String(doc.edges.length));
      insMeta.run("findings", String(doc.findings.length));
      for (const n of doc.nodes) {
        insNode.run(n.id, n.facet, n.kind, n.parent ?? null, n.span?.file ?? null, n.span?.start[0] ?? null, n.span?.start[1] ?? null, JSON.stringify(n));
      }
      for (const e of doc.edges) {
        const file = e.span?.file ?? null;
        const json = JSON.stringify(e);
        const to = e.to;
        if (typeof to === "string") {
          insEdge.run(e.from, to, null, null, e.facet, e.kind, file, json);
        } else if ("candidates" in to) {
          for (const c of to.candidates) insEdge.run(e.from, c, null, null, e.facet, e.kind, file, json);
        } else {
          insEdge.run(e.from, null, to.unresolved.scheme, to.unresolved.text, e.facet, e.kind, file, json);
        }
      }
      for (const f of doc.findings) {
        insFinding.run(f.severity, f.message, f.span?.file ?? null, JSON.stringify(f));
      }
    })();
  } finally {
    db.close();
  }
}

/** The snapshot id the database was last built from, or undefined when it is missing or unreadable. */
export async function readIndexedSnapshot(dbPath: string): Promise<string | undefined> {
  if (!existsSync(dbPath)) return undefined;
  let db: Database.Database | undefined;
  try {
    db = await openDatabase(dbPath, { readonly: true, fileMustExist: true });
    const row = db.prepare("SELECT value FROM meta WHERE key = 'snapshot'").get() as { value: string } | undefined;
    return row?.value;
  } catch {
    return undefined;
  } finally {
    db?.close();
  }
}
