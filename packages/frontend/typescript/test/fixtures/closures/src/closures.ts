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
  const f = () => 1;
  function helper() {
    return 2;
  }
  function unused() {
    return 3;
  }
  return f() + helper();
}

export function wrap() {
  const holder = { mid: { leaf: () => 3 } };
  use(holder);
}

export function factory() {
  class Local {
    lm() {
      return 4;
    }
    get lg() {
      return 5;
    }
    pa = () => 6;
  }
  return new Local();
}

export function mapper() {
  return [1].map(function h(x) {
    return x + 1;
  });
}

export class Top {
  m() {
    return 7;
  }
  get g() {
    return 8;
  }
  pa = () => 9;
}

export namespace Ns {
  export function nf() {
    return 10;
  }
}
