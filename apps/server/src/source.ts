import { existsSync, realpathSync, statSync, readFileSync } from "node:fs";
import { isAbsolute, join, normalize, sep } from "node:path";
import { ProjectError } from "./registry.js";

const MAX_BYTES = 2 * 1024 * 1024;

/**
 * Resolves a project-relative path to a file inside the project root. Rejects absolute paths,
 * parent references, and symbolic links that lead outside the root.
 */
export function resolveInside(root: string, rel: string): string {
  if (rel.length === 0 || rel.includes("\0") || isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) {
    throw new ProjectError(400, "file must be a relative path inside the project");
  }
  const cleaned = normalize(rel);
  if (cleaned === ".." || cleaned.startsWith(`..${sep}`) || cleaned.split(sep).includes("..")) {
    throw new ProjectError(400, "file must not leave the project");
  }
  const realRoot = realpathSync(root);
  const candidate = join(root, cleaned);
  if (!existsSync(candidate)) throw new ProjectError(404, `no file ${rel}`);
  const real = realpathSync(candidate);
  if (real !== realRoot && !real.startsWith(realRoot + sep)) {
    throw new ProjectError(400, "file resolves outside the project");
  }
  if (!statSync(real).isFile()) throw new ProjectError(400, `${rel} is not a file`);
  if (statSync(real).size > MAX_BYTES) throw new ProjectError(413, `${rel} is larger than 2 MB`);
  return real;
}

export interface SourceSlice {
  file: string;
  /** 1-based number of the first line in `lines`. */
  firstLine: number;
  lines: string[];
  /** The highlighted range, 1-based and inclusive. */
  highlight: { start: number; end: number };
  totalLines: number;
}

/** A slice of a file around a line range, with `context` lines on each side. Lines are 1-based. */
export function sourceSlice(root: string, rel: string, start: number, end: number, context: number): SourceSlice {
  const abs = resolveInside(root, rel);
  const text = readFileSync(abs, "utf8");
  const all = text.split("\n");
  const lo = Math.max(1, Math.min(start, end) - Math.max(0, context));
  const hi = Math.min(all.length, Math.max(start, end) + Math.max(0, context));
  return {
    file: rel,
    firstLine: lo,
    lines: all.slice(lo - 1, hi).map((l) => l.replace(/\r$/, "")),
    highlight: { start: Math.min(start, end), end: Math.max(start, end) },
    totalLines: all.length,
  };
}

export interface FileText {
  file: string;
  lines: string[];
  totalLines: number;
  size: number;
}

/** A whole text file, for the file browser. Binary files are refused. */
export function readFileText(root: string, rel: string): FileText {
  const abs = resolveInside(root, rel);
  const buf = readFileSync(abs);
  if (buf.includes(0)) throw new ProjectError(415, `${rel} is a binary file`);
  const lines = buf.toString("utf8").split("\n").map((l) => l.replace(/\r$/, ""));
  // A trailing newline ends the last line; it does not start another one.
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return { file: rel, lines, totalLines: lines.length, size: buf.length };
}
