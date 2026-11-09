// The Findings page's data: findings grouped into one row per kind (the rule that made them, the id's part before its
// colon). Pure, so the grouping, the top files, the examples and the message filling are unit tested without rendering.
import type { FindingRow } from "./api";

/** How many files a row lists, and how many examples it shows. */
export const TOP_FILES = 5;
export const EXAMPLES = 3;

/** The kind of a finding: the part of its id before the first colon. A finding with no colon is its own kind. */
export const kindOf = (f: Pick<FindingRow, "id">): string => {
  const at = f.id.indexOf(":");
  return at === -1 ? f.id : f.id.slice(0, at);
};

/** The file a finding is about: its span's file, else the file part of its first node. */
export function fileOf(f: FindingRow): string | undefined {
  if (f.span) return f.span.file;
  const node = f.nodes?.[0];
  if (node === undefined) return undefined;
  const hash = node.indexOf("#");
  return hash === -1 ? node : node.slice(0, hash);
}

/** The function a finding names, as its node id (`file#name`), or undefined when it names a file or nothing. */
export function fnOf(f: FindingRow): string | undefined {
  const node = f.nodes?.[0];
  return node !== undefined && node.includes("#") ? node : undefined;
}

/** The subject of a finding: the short name of its function, else its node ids joined into a chain. */
export function subjectOf(f: FindingRow): string {
  const fn = fnOf(f);
  if (fn !== undefined) return fn.slice(fn.indexOf("#") + 1);
  return (f.nodes ?? []).join(" -> ");
}

/** The numbers a message carries, in order. */
export const numbersOf = (message: string): number[] => (message.match(/\d+/g) ?? []).map(Number);

/**
 * The template of a message: its subject becomes `{subject}` and each number `{n}`. Filling the template from the same
 * finding gives the message back (see fillTemplate).
 */
export function templateOf(message: string, subject: string): string {
  let out = message;
  if (subject !== "" && out.includes(subject)) out = out.replace(subject, "\u0000subject\u0000");
  out = out.replace(/\d+/g, "{n}");
  return out.replace("\u0000subject\u0000", "{subject}");
}

/**
 * Fills a template's `{subject}` and `{n}` placeholders. The `{n}` placeholders take `numbers` in order. Returns undefined
 * when a placeholder has no value, so the caller can fall back to a real message rather than show a raw placeholder.
 */
export function fillTemplate(template: string, values: { subject: string; numbers: readonly number[] }): string | undefined {
  let next = 0;
  let missing = false;
  const filled = template.replace(/\{(subject|n)\}/g, (_, key: string) => {
    if (key === "subject") return values.subject;
    const n = values.numbers[next++];
    if (n === undefined) {
      missing = true;
      return "";
    }
    return String(n);
  });
  return missing ? undefined : filled;
}

/** One example location of a kind: where it is, the function it names (if any), and its message. */
export interface FindingExample {
  file: string | undefined;
  line?: number;
  fn?: string;
  message: string;
}

/** One file of a kind, with how many of the kind's findings it holds. */
export interface FileCount {
  file: string;
  count: number;
}

/** One row of the Findings table: a kind, its count, its top files, three examples and its filled message. */
export interface FindingGroup {
  kind: string;
  lens: string;
  severity: FindingRow["severity"];
  count: number;
  /** The kind's message template, with placeholders. */
  template: string;
  /** The template filled from the first example. */
  message: string;
  topFiles: FileCount[];
  examples: FindingExample[];
  /** The file the row's "Show in Flow" opens, or undefined for findings with no file. */
  flowFile: string | undefined;
  /** The function to select in Flow: the first finding in the top file that names one. */
  flowFn: string | undefined;
}

const SEVERITY_RANK: Record<string, number> = { error: 0, warning: 1, info: 2 };

/**
 * Groups findings into one row per kind, ordered by count (most first, then by kind). Each row's template is taken from its
 * first finding and filled from that same finding, so the row shows real numbers and names and never a raw placeholder.
 */
export function groupFindings(rows: readonly FindingRow[]): FindingGroup[] {
  const byKind = new Map<string, FindingRow[]>();
  for (const f of rows) {
    const kind = kindOf(f);
    const list = byKind.get(kind);
    if (list) list.push(f);
    else byKind.set(kind, [f]);
  }
  const groups: FindingGroup[] = [];
  for (const [kind, list] of byKind) {
    const first = list[0] as FindingRow;
    const subject = subjectOf(first);
    const template = templateOf(first.message, subject);
    const filled = fillTemplate(template, { subject, numbers: numbersOf(first.message) });
    const files = new Map<string, number>();
    for (const f of list) {
      const file = fileOf(f);
      if (file !== undefined) files.set(file, (files.get(file) ?? 0) + 1);
    }
    const topFiles = [...files]
      .map(([file, count]) => ({ file, count }))
      .sort((a, b) => b.count - a.count || a.file.localeCompare(b.file))
      .slice(0, TOP_FILES);
    const examples: FindingExample[] = list.slice(0, EXAMPLES).map((f) => {
      const fn = fnOf(f);
      return {
        file: fileOf(f),
        ...(f.span ? { line: f.span.start[0] + 1 } : {}),
        ...(fn !== undefined ? { fn } : {}),
        message: f.message,
      };
    });
    const flowFile = topFiles[0]?.file;
    const flowFn = flowFile === undefined ? undefined : list.map(fnOf).find((fn, i) => fn !== undefined && fileOf(list[i] as FindingRow) === flowFile);
    groups.push({
      kind,
      lens: first.lens,
      severity: first.severity,
      count: list.length,
      template,
      message: filled ?? first.message,
      topFiles,
      examples,
      flowFile,
      flowFn,
    });
  }
  return groups.sort(
    (a, b) => b.count - a.count || (SEVERITY_RANK[a.severity] ?? 3) - (SEVERITY_RANK[b.severity] ?? 3) || a.kind.localeCompare(b.kind),
  );
}
