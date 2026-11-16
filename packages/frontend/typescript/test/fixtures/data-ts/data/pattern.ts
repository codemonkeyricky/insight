let cache: Record<string, number> = {};

export function fill(src: Record<string, number>): void {
  ({ cache } = src);
}

export function swap(xs: number[]): void {
  [globalThis.px] = xs;
}

export function readsInArray(): unknown[] {
  return [globalThis.px];
}

export function peek(): Record<string, number> {
  return cache;
}
