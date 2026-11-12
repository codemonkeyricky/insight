import type { ProjectPaths } from "./paths.js";
import { InputError, readJsonFile, writeFileAtomic } from "./util.js";

export const REVIEW_SCHEMA = 1;

/** Decisions a reviewer records. A finding with no decision is open. */
export type Decision = "accepted" | "dismissed";
export type ReviewStatus = "open" | Decision;

export interface ReviewEntry {
  status: Decision;
  note: string;
  updatedAt: string;
}

/** Stored as .insight/review.json. Keys are stable finding keys, `<lens>#<id>`. */
export interface ReviewFile {
  schema: typeof REVIEW_SCHEMA;
  decisions: Record<string, ReviewEntry>;
}

/** One line of the checklist: a finding from the snapshot, with its decision if it has one. */
export interface ChecklistItem {
  key: string;
  lens: string;
  id: string;
  severity: string;
  message: string;
  file?: string;
  line?: number;
  status: ReviewStatus;
  note?: string;
  updatedAt?: string;
}

export const NOTE_LIMIT = 4000;

export function readReview(paths: ProjectPaths): ReviewFile {
  const file = readJsonFile<ReviewFile | undefined>(paths.review, undefined);
  return file && file.schema === REVIEW_SCHEMA && file.decisions ? file : { schema: REVIEW_SCHEMA, decisions: {} };
}

function writeReview(paths: ProjectPaths, file: ReviewFile): void {
  writeFileAtomic(paths.review, `${JSON.stringify(file, null, 1)}\n`);
}

function checkNote(note: unknown, required: boolean): string {
  const text = typeof note === "string" ? note.trim() : "";
  if (required && text === "") throw new InputError("a dismissal needs a note saying why");
  if (text.length > NOTE_LIMIT) throw new InputError(`note is longer than ${NOTE_LIMIT} characters`);
  return text;
}

/** Records an accept or a dismiss. A dismissal must carry a note. An accept may carry one. */
export function setDecision(paths: ProjectPaths, key: unknown, status: unknown, note: unknown, now = new Date()): ReviewEntry {
  if (typeof key !== "string" || key.trim() === "") throw new InputError("key is required");
  if (status !== "accepted" && status !== "dismissed") throw new InputError('status must be "accepted" or "dismissed"');
  const entry: ReviewEntry = { status, note: checkNote(note, status === "dismissed"), updatedAt: now.toISOString() };
  const file = readReview(paths);
  file.decisions[key] = entry;
  writeReview(paths, file);
  return entry;
}

/** Puts a finding back to open. */
export function clearDecision(paths: ProjectPaths, key: string): void {
  const file = readReview(paths);
  if (!(key in file.decisions)) return;
  delete file.decisions[key];
  writeReview(paths, file);
}

/**
 * The checklist for one snapshot's findings. Decisions whose key no longer appears are returned as
 * `stale`, so a dismissal is never silently dropped when a finding moves or goes away.
 */
export function checklist(
  findings: { key: string; lens: string; id: string; severity: string; message: string; file?: string; line?: number }[],
  review: ReviewFile,
): { items: ChecklistItem[]; stale: (ReviewEntry & { key: string })[] } {
  const present = new Set(findings.map((f) => f.key));
  const items: ChecklistItem[] = findings.map((f) => {
    const d = review.decisions[f.key];
    return {
      ...f,
      status: d ? d.status : "open",
      ...(d ? { note: d.note, updatedAt: d.updatedAt } : {}),
    };
  });
  const stale = Object.entries(review.decisions)
    .filter(([key]) => !present.has(key))
    .map(([key, d]) => ({ key, ...d }));
  return { items, stale };
}
