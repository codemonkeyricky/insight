export interface CoverageShard {
  frontend: string;
  file: string;
  /** Per facet: how many nodes and edges this shard produced. */
  facets: Map<string, { nodes: number; edges: number }>;
  errors: number;
}

export interface CoverageRow {
  facet: string;
  /** Plugins that declare the facet and ran. "core" stands for the linker's structure.file nodes. */
  providers: string[];
  filesScanned: number;
  filesWithRecords: number;
  filesWithErrors: number;
  nodes: number;
  edges: number;
}

export interface CoverageInput {
  facets: readonly string[];
  frontends: { id: string; provides: string[] }[];
  shards: CoverageShard[];
  /** Number of project files, for the core structure.file nodes. */
  coreFiles: number;
}

/** One row per facet: which plugins fill it and how much of the project they cover. */
export function computeCoverage(input: CoverageInput): CoverageRow[] {
  const facets = new Set<string>(input.facets);
  for (const f of input.frontends) for (const p of f.provides) facets.add(p);
  const rows: CoverageRow[] = [];
  for (const facet of [...facets].sort()) {
    const providers = input.frontends.filter((f) => f.provides.includes(facet)).map((f) => f.id);
    if (facet === "structure") providers.unshift("core");
    const shards = input.shards.filter((s) => providers.includes(s.frontend));
    const files = new Set(shards.map((s) => s.file));
    let filesScanned = files.size;
    let filesWithRecords = shards.filter((s) => s.facets.has(facet)).length;
    if (facet === "structure") {
      filesScanned = Math.max(filesScanned, input.coreFiles);
      filesWithRecords = Math.max(filesWithRecords, input.coreFiles);
    }
    let nodes = 0;
    let edges = 0;
    for (const s of shards) {
      const c = s.facets.get(facet);
      if (c) {
        nodes += c.nodes;
        edges += c.edges;
      }
    }
    if (facet === "structure") nodes += input.coreFiles;
    rows.push({
      facet,
      providers,
      filesScanned,
      filesWithRecords,
      filesWithErrors: shards.filter((s) => s.errors > 0).length,
      nodes,
      edges,
    });
  }
  return rows;
}
