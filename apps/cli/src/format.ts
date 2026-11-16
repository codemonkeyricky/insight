import type { IndexReport } from "@insight/indexer";
import type { CouplingReport, CouplingReportEntry } from "@insight/flow";

function table(rows: string[][]): string {
  const widths = rows[0]?.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length))) ?? [];
  return rows
    .map((r) => r.map((cell, i) => (i === 0 ? cell.padEnd(widths[i] ?? 0) : cell.padStart(widths[i] ?? 0))).join("  "))
    .join("\n");
}

/** Plain-text summary of one index run. */
export function formatReport(r: IndexReport): string {
  const lines: string[] = [];
  lines.push(`Indexed ${r.projectPath} in ${(r.durationMs / 1000).toFixed(2)}s`);
  lines.push(`snapshot ${r.snapshot} (${r.snapshotChanged ? "new or changed" : "unchanged"})`);
  lines.push(
    `changes since last run: ${r.changes.added.length} added, ${r.changes.modified.length} modified, ` +
      `${r.changes.removed.length} removed, ${r.changes.renamed.length} renamed`,
  );
  const extractedBy = new Map<string, string[]>();
  for (const e of r.extracted) {
    const list = extractedBy.get(e.frontend) ?? [];
    list.push(e.file);
    extractedBy.set(e.frontend, list);
  }
  lines.push(`extracted ${r.extracted.length} file(s), reused ${r.reused} cached shard(s), removed ${r.removed.length}`);
  for (const [id, files] of extractedBy) {
    lines.push(`  ${id}: ${files.join(", ")}`);
  }
  for (const f of r.failed) lines.push(`  FAILED ${f.frontend} ${f.file}: ${f.message}`);
  lines.push(`graph: ${r.nodes} nodes, ${r.edges} edges, ${r.findings} findings, ${r.resolved} references resolved, ${r.unresolved} unresolved`);
  lines.push("");
  lines.push("coverage");
  const rows: string[][] = [["facet", "providers", "files", "with records", "nodes", "edges", "errors"]];
  for (const c of r.coverage) {
    rows.push([
      c.facet,
      c.providers.length ? c.providers.join(",") : "(not provided)",
      String(c.filesScanned),
      String(c.filesWithRecords),
      String(c.nodes),
      String(c.edges),
      String(c.filesWithErrors),
    ]);
  }
  lines.push(table(rows));
  if (r.frontends.length === 0) lines.push("no frontend applies to this project");
  for (const s of r.skipped) lines.push(`skipped ${s.id}: ${s.reason}`);
  for (const d of r.disabled) lines.push(`disabled ${d.id}: ${d.reason}`);
  if (r.problems.length > 0) {
    lines.push(`problems in the linked IR (${r.problems.length} shown at most):`);
    for (const p of r.problems) lines.push(`  ${p}`);
  }
  return lines.join("\n");
}

/** One entry: its label, the target it names, and where the target is declared. */
function formatCouplingEntry(e: CouplingReportEntry): string {
  const target = e.target === undefined ? "" : ` → ${e.target}`;
  const where = e.file === undefined ? "" : `  (${e.file}${e.line === undefined ? "" : `:${e.line}`})`;
  return `    ${e.label}${target}${where}`;
}

/** Plain-text coupling footprint of one scope, grouped by class. Empty classes are omitted. */
export function formatCoupling(r: CouplingReport): string {
  if (r.functions.length === 0) return "no functions in scope";
  const lines: string[] = [];
  for (const f of r.functions) {
    if (lines.length > 0) lines.push("");
    lines.push(`${f.name}  ${f.id}`);
    lines.push(`  ${f.file ?? "(no file)"}  module ${f.module}`);
    lines.push(`  ${f.summary}`);
    const classes: [string, CouplingReportEntry[]][] = [
      ["cross", f.cross],
      ["io", f.io],
      ["state", f.state],
      ["conc", f.conc],
      ["escape", f.escape],
    ];
    for (const [name, entries] of classes) {
      if (entries.length === 0) continue;
      lines.push(`  ${name}`);
      for (const e of entries) lines.push(formatCouplingEntry(e));
    }
  }
  return lines.join("\n");
}
