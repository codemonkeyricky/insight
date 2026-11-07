import type { Diagnostic } from "@insight/ir";
import type { IRRecord, IRFinding, KindDefinition, UnresolvedRef, NodeId, FacetId, Provenance } from "@insight/ir";

export type { Provenance, KindDefinition, IRRecord, NodeId, FacetId };

/** A project as the pipeline sees it. */
export interface ProjectRoot {
  /** Absolute path of the project folder. */
  path: string;
  name: string;
  /** Whether build tools (bazel, cmake) may be run. Off by default. */
  allowBuildTools: boolean;
}

/** Returned by Frontend.detect when the frontend applies to a project. */
export interface Detection {
  reason: string;
}

/** One batch of IR, emitted for one project-relative file. */
export interface IRBatch {
  file: string;
  records: IRRecord[];
  /**
   * Other project files this batch's facts were derived from, such as the file that declares a
   * type a call was resolved against. Changing one of them re-extracts this batch.
   */
  dependsOn?: string[];
}

export interface ExtractContext {
  root: ProjectRoot;
  /** Project-relative, POSIX-style paths to extract. One IRBatch is due for each. */
  files: string[];
  /** Every project file, relative and sorted. Useful for resolving names. */
  listFiles(): string[];
  readFile(relPath: string): Promise<string>;
  /** Emits a diagnostic into the run log. */
  log(message: string): void;
}

/**
 * A frontend turns one language or build system into IR. It declares the facets it fills,
 * and it never imports a lens.
 */
export interface Frontend {
  id: string;
  version: string;
  provides: FacetId[];
  defines?: KindDefinition[];
  detect(root: ProjectRoot): Promise<Detection | null>;
  extract(ctx: ExtractContext): AsyncIterable<IRBatch>;
  /**
   * Optional. A digest of the part of a file that other files can see (its API), computed from
   * the text alone. When a dependency changes but its digest does not, dependents keep their shards.
   * Without it the file's content hash is used.
   */
  apiDigest?(relPath: string, text: string): string;
}

export type Confidence = "exact" | "inferred" | "heuristic";

export interface ResolveContext {
  root: ProjectRoot;
  /** Project-relative path of the file that holds the unresolved reference. */
  fromFile: string;
  hasFile(relPath: string): boolean;
  /** True when a node with this id exists in the linked IR. */
  hasNode(id: NodeId): boolean;
  listFiles(): string[];
}

export interface ResolveAnswer {
  /** Node IDs the reference points at. More than one means the answer is a candidate set. */
  targets: NodeId[];
  confidence: Confidence;
  note?: string;
}

/** Settles a reference another plugin left open, by scheme and priority. */
export interface Resolver {
  scheme: string;
  /** Higher runs first. */
  priority: number;
  resolve(ref: UnresolvedRef["unresolved"], ctx: ResolveContext): Promise<ResolveAnswer | null>;
}

export type LensFinding = Omit<IRFinding, "provenance"> & { lens: string; id: string };

export interface GraphView {
  type: "graph";
  id: string;
  title: string;
  nodes: { id: string; label: string; group?: string; span?: { file: string; start: [number, number]; end: [number, number] } }[];
  edges: { from: string; to: string; kind: string; label?: string; confidence?: Confidence }[];
}

export interface TableView {
  type: "table";
  id: string;
  title: string;
  columns: string[];
  rows: (string | number | boolean | null)[][];
}

export interface TreeView {
  type: "tree";
  id: string;
  title: string;
  root: { label: string; children?: TreeView["root"][] };
}

export type LensView = GraphView | TableView | TreeView;

export interface LensResult {
  findings: LensFinding[];
  views: LensView[];
  metrics: Record<string, number>;
}

export interface LensContext {
  root: ProjectRoot;
  /** The result this lens produced last time, if any. */
  previous?: LensResult;
  /** A result from another lens that ran earlier in this pass (see Lens.after). */
  resultOf(lensId: string): LensResult | undefined;
}

/** Analyses the IR. It sees only IRView, never parser objects. */
export interface Lens {
  id: string;
  title: string;
  /** Hard needs. Without them the lens is skipped and marked unavailable. */
  requires: FacetId[];
  optional?: FacetId[];
  after?: string[];
  run(ir: import("./irview.js").IRView, ctx: LensContext): Promise<LensResult>;
}

export type { Diagnostic };
