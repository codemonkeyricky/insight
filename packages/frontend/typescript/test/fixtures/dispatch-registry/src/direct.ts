// Calls the checker resolves to one function keep their direct edge; a registry is only for calls it cannot resolve.
class Svc {
  run(): number {
    return 1;
  }
}
const fnA = (): number => 2;

// A table with a value that is not an object literal: its candidate list would be partial, so the call stays direct.
const MIXED = { a: { run: fnA }, b: new Svc() };
export function mixed(k: "a" | "b"): number {
  return MIXED[k].run();
}

const TABLE = {
  json: {
    parse(s: string): number {
      return s.length;
    },
  },
  text: { parse: (s: string): number => s.trim().length },
};

// A literal key picks one entry: a direct call.
export function literalKey(s: string): number {
  return TABLE["json"].parse(s);
}

export const ops = {
  alpha(x: number): number {
    return x + 1;
  },
  beta: (x: number): number => x * 2,
};

export function literalDirect(x: number): number {
  return ops["alpha"](x);
}

export function literalBound(x: number): number {
  const r = ops["beta"];
  return r(x);
}

// Two keys of the same object: every lookup runs that object's member.
const SAME = { a: ops, b: ops };
export function same(k: "a" | "b"): number {
  return SAME[k].alpha(1);
}

export function one(x: number): number {
  return x;
}
export function two(x: number): number {
  return -x;
}
const FNS = [one, two] as const;

export function firstFn(x: number): number {
  return FNS[0](x);
}

export function anyFn(i: number, x: number): number {
  return FNS[i](x);
}

// A union key fixes two of the three entries.
const THREE = { one, two, neg: (x: number): number => x - 1 };
export function twoOf(k: "one" | "two", x: number): number {
  return THREE[k](x);
}

// A spread may hold more functions than the literal shows: not a registry.
const base = {
  gamma(x: number): number {
    return x;
  },
};
const spread = { ...base, delta: (x: number): number => x };
export function viaSpread(k: "gamma" | "delta", x: number): number {
  return spread[k](x);
}
