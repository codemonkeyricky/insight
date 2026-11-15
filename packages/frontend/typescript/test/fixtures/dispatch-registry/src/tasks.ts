// A fixed table of functions, looked up by a key that is only known at run time.
export const impl = {
  alpha(x: number): number {
    return x + 1;
  },
  beta: (x: number): number => x * 2,
};

export type TaskName = "alpha" | "beta";

// A keyed call into the table: every function in it is a candidate.
export function dispatch(name: TaskName, x: number): number {
  return impl[name](x);
}

// The same lookup bound to a const, then called: the const names the lookup.
export function viaConst(name: TaskName, x: number): number {
  const run = impl[name] as (x: number) => number;
  return run(x);
}
