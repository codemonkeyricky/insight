export interface Mesh {
  n: number;
}

export type Tri = [number, number, number];

export const LIMIT = 3;

export function describe(m: Mesh): string {
  return String(m.n);
}
