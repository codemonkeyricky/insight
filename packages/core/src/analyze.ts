import { join } from "node:path";
import type { IRDocument, KindRegistry } from "@insight/ir";
import { IRView, type Lens, type LensFinding, type LensResult, type ProjectRoot } from "@insight/sdk";
import type { LoadedLens } from "./loader.js";
import { canonicalJson, readJsonFile, sha256, writeFileAtomic } from "./util.js";
import type { ProjectPaths } from "./paths.js";

export const ANALYSIS_SCHEMA = 1;

export type LensStatus = "ok" | "unavailable" | "error";

export interface LensRecord {
  id: string;
  title: string;
  status: LensStatus;
  /** Why the lens is unavailable or failed. */
  reason?: string;
  /** True when the result is the previous one, because the lens's inputs did not change. */
  reused: boolean;
  /** Hash of the facets the lens reads, its settings and its version. */
  inputsHash: string;
  result?: LensResult;
}

/** The lens results for one snapshot. Stored as .insight/analysis/<snapshot>.json. */
export interface AnalysisFile {
  schema: typeof ANALYSIS_SCHEMA;
  snapshot: string;
  lenses: LensRecord[];
}

export interface AnalyzeInput {
  doc: IRDocument;
  registry: KindRegistry;
  root: ProjectRoot;
  snapshot: string;
  lenses: LoadedLens[];
  /** Settings per lens id, from .insight/lenses/<id>.json. */
  configs: Record<string, unknown>;
  /** The analysis of the previous snapshot, used to keep results whose inputs did not change. */
  previous?: AnalysisFile;
  /** Called before each lens is considered, with its 0-based position in run order and the lens count. */
  onLens?: (i: number, n: number, id: string) => void;
}

export function analysisPath(paths: ProjectPaths, snapshot: string): string {
  return join(paths.analysis, `${snapshot}.json`);
}

export function readAnalysis(paths: ProjectPaths, snapshot: string): AnalysisFile | undefined {
  const file = readJsonFile<AnalysisFile | undefined>(analysisPath(paths, snapshot), undefined);
  return file && file.schema === ANALYSIS_SCHEMA ? file : undefined;
}

export function writeAnalysis(paths: ProjectPaths, file: AnalysisFile): void {
  writeFileAtomic(analysisPath(paths, file.snapshot), JSON.stringify(file));
}

/** Lenses in an order where each runs after the lenses it names in `after` that are present. */
export function orderLenses(lenses: LoadedLens[]): LoadedLens[] {
  const byId = new Map(lenses.map((l) => [l.lens.id, l]));
  const done = new Set<string>();
  const out: LoadedLens[] = [];
  const visit = (l: LoadedLens, stack: string[]) => {
    if (done.has(l.lens.id)) return;
    if (stack.includes(l.lens.id)) throw new Error(`lens cycle: ${[...stack, l.lens.id].join(" -> ")}`);
    for (const dep of l.lens.after ?? []) {
      const d = byId.get(dep);
      if (d) visit(d, [...stack, l.lens.id]);
    }
    done.add(l.lens.id);
    out.push(l);
  };
  for (const l of lenses) visit(l, []);
  return out;
}

/** The facets a lens reads, and the IR records in them. Findings are not inputs. */
export function inputsFor(lens: Lens, doc: IRDocument): { facets: string[]; nodes: unknown[]; edges: unknown[] } {
  const facets = [...new Set([...lens.requires, ...(lens.optional ?? [])])].sort();
  const set = new Set(facets);
  return {
    facets,
    nodes: doc.nodes.filter((n) => set.has(n.facet)),
    edges: doc.edges.filter((e) => set.has(e.facet)),
  };
}

/**
 * Runs every lens against one snapshot. A lens whose required facets are missing is recorded as
 * unavailable. A lens whose inputs match the previous snapshot keeps its previous result.
 */
export async function runAnalysis(input: AnalyzeInput): Promise<AnalysisFile> {
  const view = new IRView({
    nodes: input.doc.nodes,
    edges: input.doc.edges,
    findings: input.doc.findings,
    registry: input.registry,
  });
  const present = view.facets();
  const results = new Map<string, LensResult>();
  const records: LensRecord[] = [];

  const ordered = orderLenses(input.lenses);
  for (const [i, { lens, manifest }] of ordered.entries()) {
    input.onLens?.(i, ordered.length, lens.id);
    const config = input.configs[lens.id];
    const inputs = inputsFor(lens, input.doc);
    const inputsHash = sha256(
      canonicalJson({ id: lens.id, version: manifest.version, config: config ?? null, ...inputs }),
    );
    const previousRecord = input.previous?.lenses.find((r) => r.id === lens.id);
    const missing = lens.requires.filter((f) => !present.has(f));
    if (missing.length > 0) {
      records.push({
        id: lens.id,
        title: lens.title,
        status: "unavailable",
        reason: `unavailable: no frontend provides ${missing.join(", ")}`,
        reused: false,
        inputsHash,
      });
      continue;
    }
    if (previousRecord?.status === "ok" && previousRecord.inputsHash === inputsHash && previousRecord.result) {
      results.set(lens.id, previousRecord.result);
      records.push({ ...previousRecord, reused: true });
      continue;
    }
    try {
      const raw = await lens.run(view, {
        root: input.root,
        config,
        previous: previousRecord?.status === "ok" ? previousRecord.result : undefined,
        resultOf: (other) => results.get(other),
      });
      const result = normalize(lens.id, raw);
      results.set(lens.id, result);
      records.push({ id: lens.id, title: lens.title, status: "ok", reused: false, inputsHash, result });
    } catch (err) {
      records.push({
        id: lens.id,
        title: lens.title,
        status: "error",
        reason: (err as Error).message,
        reused: false,
        inputsHash,
      });
    }
  }
  return { schema: ANALYSIS_SCHEMA, snapshot: input.snapshot, lenses: records };
}

/** Gives every lens finding its lens id and an id that is unique within the result. */
export function normalize(lensId: string, result: LensResult): LensResult {
  const seen = new Set<string>();
  const findings: LensFinding[] = result.findings.map((f, i) => {
    let id = f.id && f.id.length > 0 ? f.id : `${lensId}:${i}`;
    while (seen.has(id)) id = `${id}#${i}`;
    seen.add(id);
    return { ...f, lens: lensId, id };
  });
  return { findings, views: result.views, metrics: result.metrics };
}
