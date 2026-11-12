import { validateIR, type KindRegistry } from "@insight/ir";
import type { Frontend, IRBatch, ProjectRoot } from "./types.js";

export interface ConformanceCheck {
  name: string;
  ok: boolean;
  problems: string[];
}

export interface ConformanceReport {
  frontend: string;
  ok: boolean;
  checks: ConformanceCheck[];
}

export interface ConformanceOptions {
  frontend: Frontend;
  root: ProjectRoot;
  /** Project-relative files to extract. Every one must yield exactly one batch. */
  files: string[];
  readFile(relPath: string): Promise<string>;
  /** The registry the frontend's kinds were added to (core plus the frontend's own definitions). */
  registry: KindRegistry;
  /** Cap on problems listed per check. */
  maxProblems?: number;
}

/**
 * The checks every frontend must pass. The kit runs the frontend twice, so it also tests
 * that IDs are stable between runs.
 */
export async function runFrontendConformance(opts: ConformanceOptions): Promise<ConformanceReport> {
  const cap = opts.maxProblems ?? 20;
  const checks: ConformanceCheck[] = [];
  const add = (name: string, problems: string[]) =>
    checks.push({ name, ok: problems.length === 0, problems: problems.slice(0, cap) });

  const detection = await opts.frontend.detect(opts.root);
  add("detect returns a detection or null", detection === null || typeof detection.reason === "string" ? [] : ["detect returned an object without a reason"]);

  const first = await collect(opts);
  const second = await collect(opts);

  const fileSet = new Set(opts.files);
  const lineCounts = new Map<string, number>();
  for (const file of opts.files) {
    lineCounts.set(file, (await opts.readFile(file)).split("\n").length);
  }

  const batchProblems: string[] = [];
  const seen = new Map<string, number>();
  for (const batch of first) {
    seen.set(batch.file, (seen.get(batch.file) ?? 0) + 1);
    if (!fileSet.has(batch.file)) batchProblems.push(`batch for "${batch.file}", which was not requested`);
  }
  for (const file of opts.files) {
    const count = seen.get(file) ?? 0;
    if (count !== 1) batchProblems.push(`"${file}" yielded ${count} batches, expected 1`);
  }
  add("one batch per requested file", batchProblems);

  const records = first.flatMap((b) => b.records);
  const text = records.map((r) => JSON.stringify(r)).join("\n");
  const report = validateIR(text, opts.registry, { closed: false });
  add(
    "output validates against the IR schema and kinds",
    report.errors.map((e) => `${e.line !== undefined ? `record ${e.line}: ` : ""}${e.message}`),
  );

  const declared = new Set(opts.frontend.provides);
  const undeclared = new Set<string>();
  for (const r of records) {
    if ("node" in r && !declared.has(r.node.facet)) undeclared.add(`node ${r.node.id} in facet ${r.node.facet}`);
    if ("edge" in r && !declared.has(r.edge.facet)) undeclared.add(`edge ${r.edge.kind} in facet ${r.edge.facet}`);
  }
  add(
    "facets match the declaration",
    [...undeclared].map((u) => `${u} is not in provides`),
  );

  const idProblems: string[] = [];
  const key = (b: IRBatch) => JSON.stringify({ file: b.file, records: b.records });
  const a = first.map(key).sort();
  const b = second.map(key).sort();
  if (a.length !== b.length || a.some((v, i) => v !== b[i])) idProblems.push("two runs over the same input produced different output");
  add("IDs and output are stable across runs", idProblems);

  const spanProblems: string[] = [];
  for (const r of records) {
    const span = "node" in r ? r.node.span : "edge" in r ? r.edge.span : undefined;
    const label = "node" in r ? `node ${r.node.id}` : "edge" in r ? `edge ${r.edge.kind}` : "finding";
    if (span === undefined) continue;
    const lines = lineCounts.get(span.file);
    if (lines === undefined) {
      spanProblems.push(`${label}: span file "${span.file}" is not a requested file`);
      continue;
    }
    const [sl, sc] = span.start;
    const [el, ec] = span.end;
    if (sl > el || (sl === el && sc > ec)) spanProblems.push(`${label}: span starts after it ends`);
    if (el >= lines) spanProblems.push(`${label}: span ends on line ${el + 1}, file has ${lines} lines`);
  }
  add("spans point at real source", spanProblems);

  const refProblems: string[] = [];
  for (const r of records) {
    if (!("edge" in r)) continue;
    const to = r.edge.to;
    if (typeof to === "string") continue;
    if ("unresolved" in to) {
      if (!to.unresolved.scheme) refProblems.push(`edge ${r.edge.kind}: unresolved reference has no scheme`);
      if (typeof to.unresolved.text !== "string") refProblems.push(`edge ${r.edge.kind}: unresolved reference text is not a string`);
    } else if (to.candidates.length === 0) {
      refProblems.push(`edge ${r.edge.kind}: empty candidate set`);
    }
  }
  add("unresolved references are well-formed", refProblems);

  return { frontend: opts.frontend.id, ok: checks.every((c) => c.ok), checks };
}

async function collect(opts: ConformanceOptions): Promise<IRBatch[]> {
  const batches: IRBatch[] = [];
  const ctx = {
    root: opts.root,
    files: opts.files,
    listFiles: () => [...opts.files].sort(),
    readFile: opts.readFile,
    log: () => undefined,
  };
  for await (const batch of opts.frontend.extract(ctx)) batches.push(batch);
  return batches;
}
