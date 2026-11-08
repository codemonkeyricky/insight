// Object literals bound to a name: each function-valued property is a named function, `<binding>.<prop>`.
export const api = {
  load: () => 1,
  save(x: number): number {
    return x;
  },
};

export const outer = {
  inner: {
    deep: function (): number {
      return 2;
    },
  },
};

export class Clicker {
  onX = (): number => 3;
  handlers = {
    onY: (): number => 4,
  };
}

// An object literal passed inline is bound to no name: its arrow is a lambda, parented by the file.
export function run(o: { go(): number }): number {
  return o.go();
}
export const result = run({ go: () => 5 });

// A literal bound inside a function is named under that function.
export function make(): number {
  const local = { go: (): number => 6 };
  return local.go();
}
