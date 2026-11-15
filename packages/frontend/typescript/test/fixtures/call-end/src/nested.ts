export function g(x: number): number {
  return x + 1;
}

export function f(x: number): number {
  return x * 2;
}

export function run(x: number): number {
  return f(g(x));
}
