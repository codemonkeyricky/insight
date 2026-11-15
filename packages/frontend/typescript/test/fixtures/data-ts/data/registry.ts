const m = new Map<string, number>();
export const TABLE = [1, 2] as const;
export function remember(k: string): void {
  m.set(k, 1);
}
export function lookup(i: 0 | 1): number {
  return TABLE[i];
}
