import type { IndexReport } from "@insight/core";

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
