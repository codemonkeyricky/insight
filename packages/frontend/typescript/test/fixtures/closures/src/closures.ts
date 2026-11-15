export const api = { get: () => 1 };
export function top() {
  return 0;
}
declare function use(value: unknown): unknown;

export function link() {
  const ctx = { hasFile: (p: string) => p.length > 0 };
  use(ctx);
}

export function outer() {
  const helper = () => 1;
  function inner() {
    return 2;
  }
  return helper() + inner();
}

export function wrap() {
  const holder = { mid: { leaf: () => 3 } };
  use(holder);
}
