/** Eased stagger: early items step apart more than late ones, and the delay is capped. */
export function popDelay(rank: number, cap = 260, count = 12): number {
  const t = Math.min(Math.max(rank, 0), count) / count;
  return Math.round(cap * Math.sin((t * Math.PI) / 2));
}
