// Fuzzy matching for the Find palette. A query matches a text when its characters appear in the text in order. The
// score rewards matches at the start of the text, at a word boundary (after / . _ - space or a colon) and at a camel-case
// hump, and runs of consecutive characters. Shorter texts win ties, so "pl" ranks `place` above `planAssembly`.

const BOUNDARY = /[\s/._\-:#(]/;

/** Scores how well `query` matches `text`. Undefined when the characters of the query do not appear in order. Higher is better. */
export function fuzzyScore(query: string, text: string): number | undefined {
  const q = query.trim().toLowerCase();
  if (q === "") return 0;
  const lower = text.toLowerCase();
  let score = 0;
  let from = 0;
  let prev = -2;
  for (const ch of q) {
    const at = lower.indexOf(ch, from);
    if (at === -1) return undefined;
    let bonus = 1;
    if (at === 0) bonus += 8;
    else if (BOUNDARY.test(text.charAt(at - 1))) bonus += 5;
    else if (isUpper(text.charAt(at)) && isLower(text.charAt(at - 1))) bonus += 4;
    if (at === prev + 1) bonus += 4;
    // A gap before this character costs a little, so tight matches beat scattered ones.
    score += bonus - Math.min(at - from, 3) * 0.2;
    prev = at;
    from = at + 1;
  }
  return score - text.length * 0.01;
}

const isUpper = (c: string) => c !== "" && c === c.toUpperCase() && c !== c.toLowerCase();
const isLower = (c: string) => c !== "" && c === c.toLowerCase() && c !== c.toUpperCase();

/**
 * The items that match `query`, best first, at most `limit` of them. An empty query keeps the items in their own order.
 * Ties keep their order, so a list the caller sorted (by group, say) stays sorted within equal scores.
 */
export function rankFuzzy<T>(items: readonly T[], query: string, text: (item: T) => string, limit = 50): T[] {
  if (query.trim() === "") return items.slice(0, limit);
  const scored: { item: T; score: number; index: number }[] = [];
  items.forEach((item, index) => {
    const score = fuzzyScore(query, text(item));
    if (score !== undefined) scored.push({ item, score, index });
  });
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.slice(0, limit).map((s) => s.item);
}
