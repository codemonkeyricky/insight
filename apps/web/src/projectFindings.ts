// The findings count a project card shows. The workspace's Findings badge counts every lens's findings, so the card sums
// the same per-lens counts from the last run; the run's own model-level count is added in case it ever carries any.

/** The total findings of a project's last run: its own count plus each lens's count. A run without lenses counts its own. */
export function projectFindingsTotal(last: { findings: number; lenses?: { findings: number }[] } | undefined): number {
  if (last === undefined) return 0;
  const lensTotal = (last.lenses ?? []).reduce((sum, lens) => sum + lens.findings, 0);
  return last.findings + lensTotal;
}
