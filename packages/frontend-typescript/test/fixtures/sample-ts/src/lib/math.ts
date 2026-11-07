export function add(a: number, b: number): number {
  return a + b;
}

export const double = (n: number): number => add(n, n);

export class Counter {
  private value = 0;

  increment(by: number): number {
    if (by > 0) {
      this.value = add(this.value, by);
    }
    return this.value;
  }
}
